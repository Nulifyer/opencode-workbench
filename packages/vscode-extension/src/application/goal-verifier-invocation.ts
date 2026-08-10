import type { GoalVerifierConfiguration, MessageBundle, SessionStatus } from "@opencode-workbench/shared"
import { GoalVerifierInvocationError, type GoalVerifierInvocationEnvelope } from "./goal-verifier-service.js"
import { sessionTurnOutcome } from "./session-turn-outcome.js"

export interface OpenCodeGoalVerifierRuntime {
  createSession(title: string): Promise<{ id: string }>
  sendStructuredPrompt(sessionID: string, prompt: string, input: { agent?: string; model?: string; schema: Record<string, unknown>; retryCount?: number }, signal: AbortSignal): Promise<unknown>
  sessionStatuses(): Promise<Record<string, SessionStatus>>
  listSessions(): Promise<Array<{ id: string }>>
  messages(sessionID: string): Promise<MessageBundle[]>
  abort(sessionID: string): Promise<unknown>
}

export type OpenCodeGoalVerifierRuntimeProvider = () => OpenCodeGoalVerifierRuntime

function tokenCount(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const tokens = value as Record<string, unknown>
  const cache = typeof tokens.cache === "object" && tokens.cache !== null && !Array.isArray(tokens.cache) ? tokens.cache as Record<string, unknown> : undefined
  const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead ?? cache?.read, tokens.cacheWrite ?? cache?.write]
  if (!values.some((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)) return undefined
  return values.reduce<number>((total, entry) => total + (Number.isSafeInteger(entry) && Number(entry) >= 0 ? Number(entry) : 0), 0)
}

function invocationMetadata(messages: MessageBundle[], sessionID: string, fallbackModel?: string): { sessionID: string; model?: string; tokens?: number; cost?: number } {
  const assistant = messages.slice().reverse().find((message) => message.info.role === "assistant")
  const finish = assistant?.parts.slice().reverse().find((part) => part.type === "step-finish")
  const providerID = typeof assistant?.info.providerID === "string" ? assistant.info.providerID : undefined
  const modelID = typeof assistant?.info.modelID === "string" ? assistant.info.modelID : undefined
  const cost = typeof assistant?.info.cost === "number" && Number.isFinite(assistant.info.cost) && assistant.info.cost >= 0 ? assistant.info.cost : undefined
  return {
    sessionID,
    model: providerID && modelID ? `${providerID}/${modelID}` : fallbackModel,
    tokens: tokenCount(finish?.tokens) ?? tokenCount(assistant?.info.tokens),
    cost,
  }
}

function cancellationError(signal: AbortSignal, metadata: { sessionID: string; model?: string }): GoalVerifierInvocationError {
  return new GoalVerifierInvocationError("Goal verifier was cancelled", metadata, { cause: signal.reason })
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds)
    const abort = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    function done(): void {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

export function createOpenCodeGoalVerifierInvocation(runtimeProvider: OpenCodeGoalVerifierRuntimeProvider, pollMilliseconds = 500): (prompt: string, schema: Record<string, unknown>, signal: AbortSignal, configuration?: Partial<GoalVerifierConfiguration>) => Promise<GoalVerifierInvocationEnvelope> {
  if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 0 || pollMilliseconds > 10_000) throw new Error("Goal verifier poll interval must be between 0 and 10,000 milliseconds")
  return async (prompt, schema, signal, configuration) => {
    if (signal.aborted) throw signal.reason
    const runtime = runtimeProvider()
    const session = await runtime.createSession("Workbench goal verifier")
    const fallbackMetadata = { sessionID: session.id, model: configuration?.model }
    let completed = false
    let abortPromise: Promise<void> | undefined
    const abortSession = (): Promise<void> => abortPromise ??= Promise.resolve()
      .then(() => runtime.abort(session.id))
      .then(() => undefined, () => undefined)
    const onAbort = () => { if (!completed) void abortSession() }
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      if (signal.aborted) throw cancellationError(signal, fallbackMetadata)
      await runtime.sendStructuredPrompt(session.id, prompt, { agent: configuration?.agent || "plan", model: configuration?.model, schema, retryCount: 2 }, signal)
      while (true) {
        if (signal.aborted) throw cancellationError(signal, fallbackMetadata)
        const [statuses, sessions, messages] = await Promise.all([
          runtime.sessionStatuses(),
          runtime.listSessions(),
          runtime.messages(session.id),
        ])
        const status = statuses[session.id]
        const outcome = sessionTurnOutcome(status, sessions.some((candidate) => candidate.id === session.id), messages)
        if (outcome.state === "failed" || outcome.state === "missing") {
          throw new GoalVerifierInvocationError(outcome.state === "missing" ? "Goal verifier session no longer exists" : "Goal verifier failed", invocationMetadata(messages, session.id, configuration?.model))
        }
        if (outcome.state === "completed") {
          const assistant = messages.slice().reverse().find((message) => message.info.role === "assistant")
          const usedTool = messages.some((message) => message.parts.some((part) => part.type === "tool"))
          const output = usedTool ? undefined : assistant?.info.structured ?? assistant?.parts.find((part) => part.type === "text" && part.text)?.text
          const metadata = invocationMetadata(messages, session.id, configuration?.model)
          if (signal.aborted) throw cancellationError(signal, metadata)
          if (output !== undefined) {
            completed = true
            return { workbenchVerifierInvocation: true, output, metadata }
          }
          throw new GoalVerifierInvocationError(usedTool ? "Goal verifier attempted to use a forbidden tool" : "Goal verifier returned no structured output", metadata)
        }
        await waitForPoll(pollMilliseconds, signal)
      }
    } catch (error) {
      if (!completed) await abortSession()
      if (error instanceof GoalVerifierInvocationError) throw error
      if (signal.aborted) throw cancellationError(signal, fallbackMetadata)
      throw new GoalVerifierInvocationError("Goal verifier invocation failed", fallbackMetadata, { cause: error })
    } finally {
      signal.removeEventListener("abort", onAbort)
      if (!completed && signal.aborted) await abortSession()
    }
  }
}
