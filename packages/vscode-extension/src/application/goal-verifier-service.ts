import type { EvidenceReference, GoalVerdict, GoalVerifierConfiguration } from "@opencode-workbench/shared"
import { createHash } from "node:crypto"

export interface GoalVerifierInput {
  objective: string
  acceptanceCriteria: string[]
  latestAssistantResult?: string
  evidence: EvidenceReference[]
  diffSummary?: string
  diagnostics?: string
  checkpoints?: string[]
  remainingLimits?: { tokens?: number; autoTurns?: number; durationSeconds?: number }
  configuration?: Partial<GoalVerifierConfiguration>
}

export interface GoalVerifierInvocationMetadata {
  sessionID?: string
  model?: string
  tokens?: number
  cost?: number
}

export interface GoalVerifierInvocationEnvelope {
  workbenchVerifierInvocation: true
  output: unknown
  metadata?: GoalVerifierInvocationMetadata
}

export interface GoalVerifierAttempt extends GoalVerifierInvocationMetadata {
  attempt: number
  startedAt: number
  completedAt: number
  outcome: "completed" | "invalid-output" | "failed"
}

export interface GoalVerificationResult {
  verdict: GoalVerdict
  attempts: GoalVerifierAttempt[]
}

export class GoalVerifierInvocationError extends Error {
  constructor(message: string, readonly metadata?: GoalVerifierInvocationMetadata, options?: ErrorOptions) {
    super(message, options)
    this.name = "GoalVerifierInvocationError"
  }
}

export const GOAL_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason", "missingCriteria", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["continue", "complete", "blocked", "needs-user"] },
    reason: { type: "string", maxLength: 4_000 },
    missingCriteria: { type: "array", maxItems: 100, items: { type: "string", maxLength: 2_000 } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const

export function boundedVerifierEvidence(entries: readonly EvidenceReference[]): EvidenceReference[] {
  const unique = [
    ...new Map(entries.slice().sort((left, right) => left.id.localeCompare(right.id)).map((entry) => [entry.id, entry]))
      .values(),
  ]
  if (unique.length <= 200) {
    return unique.sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id)).map((
      entry,
    ) => structuredClone(entry))
  }
  const newest = unique.slice().sort((left, right) =>
    right.observedAt - left.observedAt || left.id.localeCompare(right.id)
  ).slice(0, 199)
  const omittedIDs = unique.filter((entry) => !newest.includes(entry)).map((entry) => entry.id).sort()
  const marker: EvidenceReference = {
    id: `verifier-evidence-limit:${createHash("sha256").update(omittedIDs.join("\0")).digest("hex").slice(0, 32)}`,
    kind: "criterion",
    label: "Verifier evidence selection limit",
    status: "warning",
    observedAt: newest.reduce((latest, entry) => Math.max(latest, entry.observedAt), 0),
    summary:
      `${omittedIDs.length} older evidence references were omitted from this verification attempt. Treat unsupported criteria conservatively; the complete durable evidence ledger remains available in Workbench.`,
  }
  return [
    ...newest.sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id)).map((
      entry,
    ) => structuredClone(entry)),
    marker,
  ]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invocation(value: unknown): { output: unknown; metadata?: GoalVerifierInvocationMetadata } {
  if (!record(value) || value.workbenchVerifierInvocation !== true || !("output" in value)) return { output: value }
  const candidate = record(value.metadata) ? value.metadata : undefined
  const sessionID = typeof candidate?.sessionID === "string" && candidate.sessionID.length <= 1_024
    ? candidate.sessionID
    : undefined
  const model = typeof candidate?.model === "string" && candidate.model.length <= 1_024 ? candidate.model : undefined
  const tokens = Number.isSafeInteger(candidate?.tokens) && Number(candidate?.tokens) >= 0
    ? Number(candidate?.tokens)
    : undefined
  const cost = typeof candidate?.cost === "number" && Number.isFinite(candidate.cost) && candidate.cost >= 0
    ? candidate.cost
    : undefined
  return { output: value.output, metadata: { sessionID, model, tokens, cost } }
}

export class GoalVerifierService {
  constructor(
    private readonly invoke: (
      prompt: string,
      schema: Record<string, unknown>,
      signal: AbortSignal,
      configuration?: Partial<GoalVerifierConfiguration>,
    ) => Promise<unknown>,
    private readonly timeoutMilliseconds = 60_000,
    private readonly retries = 1,
  ) {}

  async verify(input: GoalVerifierInput, signal?: AbortSignal): Promise<GoalVerdict> {
    return (await this.verifyDetailed(input, signal)).verdict
  }

  async verifyDetailed(input: GoalVerifierInput, signal?: AbortSignal): Promise<GoalVerificationResult> {
    const objective = input.objective.trim()
    if (!objective || objective.length > 4_000 || input.acceptanceCriteria.length > 100) {
      throw new Error("Invalid verifier input")
    }
    if (input.acceptanceCriteria.some((value) => !value.trim() || value.length > 2_000)) {
      throw new Error("Verifier acceptance criteria exceed their explicit limits")
    }
    if ((input.latestAssistantResult?.length ?? 0) > 20_000) {
      throw new Error("Verifier assistant result exceeds 20,000 characters")
    }
    if (
      input.evidence.length > 200 ||
      input.evidence.some((entry) => entry.label.length > 1_024 || entry.summary.length > 4_000)
    ) throw new Error("Verifier deterministic evidence exceeds its explicit limits")
    if ((input.diffSummary?.length ?? 0) > 10_000 || (input.diagnostics?.length ?? 0) > 10_000) {
      throw new Error("Verifier diff or diagnostics summary exceeds 10,000 characters")
    }
    if ((input.checkpoints?.length ?? 0) > 20 || input.checkpoints?.some((value) => value.length > 2_000)) {
      throw new Error("Verifier checkpoints exceed their explicit limits")
    }
    const payload = {
      objective,
      acceptanceCriteria: input.acceptanceCriteria,
      latestAssistantResult: input.latestAssistantResult,
      deterministicEvidence: input.evidence.map((entry) => ({
        kind: entry.kind,
        label: entry.label,
        status: entry.status,
        summary: entry.summary,
        sourceID: entry.sourceID,
      })),
      diffSummary: input.diffSummary,
      diagnostics: input.diagnostics,
      checkpoints: input.checkpoints,
      remainingLimits: input.remainingLimits,
    }
    const encodedPayload = JSON.stringify(payload)
    if (Buffer.byteLength(encodedPayload) > 1_500_000) {
      throw new Error("Verifier input exceeds the 1,500,000-byte aggregate limit")
    }
    const prompt =
      `Independently evaluate this goal using only the supplied JSON evidence. Do not inspect the filesystem, call tools, or assume a model claim is evidence. Unsupported criteria must remain missing. Return only the required verdict schema.\n\n${encodedPayload}`
    const controller = new AbortController()
    const relay = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", relay, { once: true })
    if (signal?.aborted) relay()
    const timeoutMilliseconds = Math.min(
      300_000,
      Math.max(1_000, input.configuration?.timeoutMilliseconds ?? this.timeoutMilliseconds),
    )
    const timeout = setTimeout(() => controller.abort(new Error("Goal verifier timed out")), timeoutMilliseconds)
    try {
      let lastError: unknown
      const attempts: GoalVerifierAttempt[] = []
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        const startedAt = Date.now()
        let metadata: GoalVerifierInvocationMetadata | undefined
        try {
          if (controller.signal.aborted) throw controller.signal.reason
          const invoked = invocation(
            await this.invoke(
              prompt,
              GOAL_VERDICT_SCHEMA as unknown as Record<string, unknown>,
              controller.signal,
              input.configuration,
            ),
          )
          metadata = invoked.metadata
          const value = typeof invoked.output === "string"
            ? JSON.parse(invoked.output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))
            : invoked.output
          if (
            !record(value) || !["continue", "complete", "blocked", "needs-user"].includes(String(value.verdict)) ||
            typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 4_000 ||
            !Array.isArray(value.missingCriteria) || value.missingCriteria.length > 100 ||
            value.missingCriteria.some((item) => typeof item !== "string" || item.length > 2_000) ||
            !["low", "medium", "high"].includes(String(value.confidence))
          ) {
            attempts.push({
              attempt: attempt + 1,
              startedAt,
              completedAt: Date.now(),
              outcome: "invalid-output",
              ...invoked.metadata,
            })
            throw new Error("OpenCode returned an invalid goal verdict")
          }
          attempts.push({
            attempt: attempt + 1,
            startedAt,
            completedAt: Date.now(),
            outcome: "completed",
            ...invoked.metadata,
          })
          return {
            verdict: {
              verdict: value.verdict as GoalVerdict["verdict"],
              reason: value.reason,
              missingCriteria: value.missingCriteria as string[],
              confidence: value.confidence as GoalVerdict["confidence"],
            },
            attempts,
          }
        } catch (error) {
          const failureMetadata = error instanceof GoalVerifierInvocationError ? error.metadata : metadata
          if (attempts.at(-1)?.startedAt !== startedAt) {
            attempts.push({
              attempt: attempt + 1,
              startedAt,
              completedAt: Date.now(),
              outcome: "failed",
              ...failureMetadata,
            })
          }
          lastError = error
          if (controller.signal.aborted) throw controller.signal.reason
        }
      }
      throw lastError
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", relay)
    }
  }
}
