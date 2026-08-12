import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import {
  createOpenCodeMessageID,
  type MessageBundle,
  MULTI_RUN_DEFAULT_CONCURRENCY,
  MULTI_RUN_MAX_CANDIDATES,
  MULTI_RUN_MAX_CONCURRENCY,
  type RunGroup,
  type RunReference,
  type SessionLocator,
  type SessionStatus,
  type StructuredError,
} from "@opencode-workbench/shared"
import type { PromptFilePart } from "../opencode-client.js"
import type { WorktreeService } from "./worktree-service.js"
import { sessionTurnOutcome } from "./session-turn-outcome.js"

export interface RunRuntime {
  createSession(title: string): Promise<{ id: string }>
  sendPrompt(
    sessionID: string,
    promptID: string,
    text: string,
    delivery: "steer" | "queue",
    agent?: string,
    model?: string,
    variant?: string,
    files?: PromptFilePart[],
  ): Promise<unknown>
  abort(sessionID: string): Promise<boolean>
  statuses(): Promise<Record<string, SessionStatus>>
  needsInput?(sessionID: string): Promise<boolean>
  inspectSession(sessionID: string): Promise<{ exists: boolean; messages: MessageBundle[] }>
}

export interface RunRuntimeFactory {
  forDirectory(directory: string): RunRuntime
}

export interface RunAdmissionTracker {
  prepare(sourceReceiptID: string | undefined, sessionID: string, promptID: string): void
  admit(sessionID: string, promptID: string): void
  reject(promptID: string): void
}

export interface MultiRunOrchestratorOptions {
  admission?: RunAdmissionTracker
  monitorIntervalMilliseconds?: number
  onRunAdmitted?(groupID: string, runID: string): void | PromiseLike<void>
}

const MAX_ERROR_MESSAGE_LENGTH = 2_000
const AUTHORIZATION_VALUE = /\b((?:proxy-authorization|authorization)\s*:\s*)[^\r\n]+/gi
const COOKIE_HEADER_VALUE = /\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi
const SECRET_VALUE =
  /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi

function sanitizedErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "")
  return raw
    .replace(AUTHORIZATION_VALUE, "$1[redacted]")
    .replace(COOKIE_HEADER_VALUE, "$1[redacted]")
    .replace(SECRET_VALUE, "$1[redacted]")
    .replace(URL_CREDENTIAL, "$1[redacted]@")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH) || "Multi-run operation failed"
}

function sanitizedStructuredError(error: StructuredError): StructuredError {
  return { code: error.code, message: sanitizedErrorMessage(error.message), retryable: error.retryable }
}

function errorValue(error: unknown): StructuredError {
  return { code: "INTERNAL", message: sanitizedErrorMessage(error), retryable: true }
}

function promptAdmissionError(): StructuredError {
  return { code: "INTERNAL", message: "OpenCode prompt admission failed", retryable: true }
}

const MAX_RUN_GROUPS = 500
const MAX_RUN_GROUP_LISTENERS = 64
const TERMINAL_RUN_PHASES = new Set<RunReference["phase"]>(["completed", "failed", "cancelled"])

function cloneRunGroup(group: RunGroup): RunGroup {
  const clone = structuredClone(group)
  clone.runs = clone.runs.map((run) => run.error ? { ...run, error: sanitizedStructuredError(run.error) } : run)
  return clone
}

function isTerminalGroup(group: RunGroup): boolean {
  return group.runs.every((run) => TERMINAL_RUN_PHASES.has(run.phase))
}

function runValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if ((typeof left !== "object" || left === null) || (typeof right !== "object" || right === null)) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

async function forEachConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next
      next += 1
      await work(values[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
}

export class RunGroupService {
  private readonly groups = new Map<string, RunGroup>()
  private readonly mutations = new Map<string, string>()
  private readonly listeners = new Set<(groups: RunGroup[]) => void>()
  private persistenceTail: Promise<void> = Promise.resolve()
  private persistenceFailure: unknown

  constructor(initial: RunGroup[] = [], private readonly persist?: (groups: RunGroup[]) => void | PromiseLike<void>) {
    for (const group of initial) {
      this.groups.set(group.id, cloneRunGroup(group))
      if (group.mutationID) this.mutations.set(group.mutationID, group.id)
    }
    const pruned = this.pruneTerminalHistory()
    if (this.groups.size > MAX_RUN_GROUPS) {
      throw new Error("Run-group journal limit exceeded by active or needs-input groups")
    }
    if (pruned) this.publish()
  }

  list(): RunGroup[] {
    return [...this.groups.values()].map(cloneRunGroup)
  }
  get(id: string): RunGroup | undefined {
    const group = this.groups.get(id)
    return group ? cloneRunGroup(group) : undefined
  }

  async flush(): Promise<void> {
    await this.persistenceTail
    if (this.persistenceFailure !== undefined) {
      const failure = this.persistenceFailure
      this.persistenceFailure = undefined
      throw failure
    }
  }

  subscribe(listener: (groups: RunGroup[]) => void): { dispose(): void } {
    if (this.listeners.size >= MAX_RUN_GROUP_LISTENERS) throw new Error("Run-group listener limit reached")
    this.listeners.add(listener)
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        this.listeners.delete(listener)
      },
    }
  }

  create(
    input: Omit<RunGroup, "id" | "createdAt" | "runs"> & {
      mutationID: string
      runs: Array<Pick<RunReference, "id" | "model" | "agent" | "variant">>
    },
  ): RunGroup {
    if (!input.mutationID || input.mutationID.length > 1_024) throw new Error("Invalid run-group mutation ID")
    if (
      input.runs.length < 2 || input.runs.length > MULTI_RUN_MAX_CANDIDATES ||
      new Set(input.runs.map((run) => run.id)).size !== input.runs.length
    ) throw new Error(`Multi-run requires two to ${MULTI_RUN_MAX_CANDIDATES} unique runs`)
    const existingID = this.mutations.get(input.mutationID)
    if (existingID) {
      const existing = this.get(existingID)!
      const sameRuns = existing.runs.length === input.runs.length && existing.runs.every((run, index) => {
        const requested = input.runs[index]
        return requested !== undefined && run.id === requested.id && run.model === requested.model &&
          run.agent === requested.agent && run.variant === requested.variant
      })
      if (
        existing.ownerSessionID !== input.ownerSessionID || existing.title !== input.title.slice(0, 500) ||
        existing.repository !== input.repository || existing.baseRef !== input.baseRef ||
        existing.promptReceiptID !== input.promptReceiptID || existing.isolation !== input.isolation ||
        existing.requestFingerprint !== input.requestFingerprint || !sameRuns
      ) {
        throw new Error(`Run-group mutation ${input.mutationID} was reused with a different request`)
      }
      return existing
    }
    const pruned = this.pruneTerminalHistory(1)
    if (this.groups.size >= MAX_RUN_GROUPS) {
      if (pruned) this.publish()
      throw new Error(
        "Run-group journal limit reached by active or needs-input groups; finish or cancel an existing group before creating another",
      )
    }
    const group: RunGroup = {
      id: randomUUID(),
      mutationID: input.mutationID,
      requestFingerprint: input.requestFingerprint,
      ownerSessionID: input.ownerSessionID,
      title: input.title.slice(0, 500),
      repository: input.repository,
      baseRef: input.baseRef,
      promptReceiptID: input.promptReceiptID,
      isolation: input.isolation,
      createdAt: Date.now(),
      runs: input.runs.map((run) => ({
        ...run,
        phase: "pending",
        session: {
          sessionID: "pending",
          directory: input.repository,
          experience: "workbench",
          transport: "http-sse",
          runtimeEpoch: "pending",
        },
      })),
    }
    this.groups.set(group.id, group)
    this.mutations.set(input.mutationID, group.id)
    this.commit()
    return cloneRunGroup(group)
  }

  update(groupID: string, runID: string, values: Partial<Omit<RunReference, "id">>): RunGroup {
    const group = this.groups.get(groupID)
    const run = group?.runs.find((candidate) => candidate.id === runID)
    if (!group || !run) throw new Error("Unknown run group or run")
    const next = structuredClone(values)
    if (next.error) next.error = sanitizedStructuredError(next.error)
    if (Object.entries(next).every(([key, value]) => runValueEqual(run[key as keyof RunReference], value))) {
      return cloneRunGroup(group)
    }
    Object.assign(run, next)
    this.commit()
    return cloneRunGroup(group)
  }

  updateIf(
    groupID: string,
    runID: string,
    expected: RunReference["phase"][],
    values: Partial<Omit<RunReference, "id">>,
  ): RunGroup | undefined {
    const group = this.groups.get(groupID)
    const run = group?.runs.find((candidate) => candidate.id === runID)
    if (!group || !run) throw new Error("Unknown run group or run")
    if (!expected.includes(run.phase)) return undefined
    const next = structuredClone(values)
    if (next.error) next.error = sanitizedStructuredError(next.error)
    if (Object.entries(next).every(([key, value]) => runValueEqual(run[key as keyof RunReference], value))) {
      return cloneRunGroup(group)
    }
    Object.assign(run, next)
    this.commit()
    return cloneRunGroup(group)
  }

  private pruneTerminalHistory(reservedGroups = 0): boolean {
    const excess = this.groups.size + reservedGroups - MAX_RUN_GROUPS
    if (excess <= 0) return false
    const terminal = [...this.groups.values()]
      .filter(isTerminalGroup)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    const removeCount = Math.min(excess, terminal.length)
    for (let index = 0; index < removeCount; index += 1) {
      const group = terminal[index]!
      this.groups.delete(group.id)
      if (group.mutationID && this.mutations.get(group.mutationID) === group.id) this.mutations.delete(group.mutationID)
    }
    return removeCount > 0
  }

  private publish(): void {
    const snapshot = this.list()
    if (this.persist) {
      try {
        const pending = Promise.resolve(this.persist(snapshot))
        this.persistenceTail = Promise.all([this.persistenceTail, pending]).then(
          () => undefined,
          (error) => {
            if (this.persistenceFailure === undefined) this.persistenceFailure = error
          },
        )
      } catch (error) {
        if (this.persistenceFailure === undefined) this.persistenceFailure = error
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot))
      } catch {
        // A view subscriber cannot interrupt a durable run transition.
      }
    }
  }

  private commit(): void {
    this.pruneTerminalHistory()
    this.publish()
  }
}

export interface MultiRunInput {
  mutationID: string
  ownerSessionID?: string
  title: string
  repository: string
  baseRef: string
  promptReceiptID: string
  prompt: string
  files?: PromptFilePart[]
  runs: Array<{ id?: string; model: string; agent?: string; variant?: string }>
  concurrency?: number
  worktreeParent: string
  runtimeEpoch: string
}

function launchRequestFingerprint(
  input: MultiRunInput,
  runs: Array<{ id: string; model: string; agent?: string; variant?: string }>,
  concurrency: number,
): string {
  const payload = {
    ownerSessionID: input.ownerSessionID,
    title: input.title,
    repository: input.repository,
    baseRef: input.baseRef,
    promptReceiptID: input.promptReceiptID,
    prompt: input.prompt,
    files: (input.files ?? []).map((file) => ({
      type: file.type,
      mime: file.mime,
      url: file.url,
      filename: file.filename,
    })),
    runs: runs.map((run) => ({ id: run.id, model: run.model, agent: run.agent, variant: run.variant })),
    concurrency,
    worktreeParent: input.worktreeParent,
    runtimeEpoch: input.runtimeEpoch,
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

export class MultiRunOrchestrator {
  private readonly operations = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly monitorTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly interruptionResults = new Map<string, boolean>()
  private readonly launchQueues = new Map<string, { input: MultiRunInput; concurrency: number }>()
  private readonly launchPumps = new Map<string, Promise<void>>()
  private disposed = false

  constructor(
    private readonly groups: RunGroupService,
    private readonly worktrees: WorktreeService,
    private readonly runtimes: RunRuntimeFactory,
    private readonly options: MultiRunOrchestratorOptions = {},
  ) {
    const interval = options.monitorIntervalMilliseconds
    if (interval !== undefined && (!Number.isSafeInteger(interval) || interval < 100 || interval > 60_000)) {
      throw new Error("Multi-run monitor interval must be between 100 and 60,000 milliseconds")
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.monitorTimers.values()) clearTimeout(timer)
    this.monitorTimers.clear()
    for (const controller of this.controllers.values()) controller.abort(new Error("Multi-run orchestrator disposed"))
    this.controllers.clear()
    this.interruptionResults.clear()
    this.launchQueues.clear()
  }

  async shutdown(): Promise<void> {
    this.dispose()
    await Promise.allSettled([...this.operations.values(), ...this.launchPumps.values()])
    await Promise.all([this.groups.flush(), this.worktrees.flush()])
  }

  async start(input: MultiRunInput): Promise<RunGroup> {
    if (this.disposed) throw new Error("Multi-run orchestrator is disposed")
    if (!input.prompt.trim() || input.prompt.length > 200_000) throw new Error("Multi-run prompt is empty or too large")
    const concurrency = input.concurrency ?? MULTI_RUN_DEFAULT_CONCURRENCY
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MULTI_RUN_MAX_CONCURRENCY) {
      throw new Error(`Multi-run concurrency must be between 1 and ${MULTI_RUN_MAX_CONCURRENCY}`)
    }
    const selections = input.runs.map((run, index) => ({ ...run, id: run.id ?? `run-${index + 1}` }))
    const requestFingerprint = launchRequestFingerprint(input, selections, concurrency)
    const group = this.groups.create({
      mutationID: input.mutationID,
      requestFingerprint,
      ownerSessionID: input.ownerSessionID,
      title: input.title,
      repository: input.repository,
      baseRef: input.baseRef,
      promptReceiptID: input.promptReceiptID,
      isolation: "worktree",
      runs: selections,
    })
    await this.groups.flush()
    this.launchQueues.set(group.id, { input: { ...input, runs: selections }, concurrency })
    await this.launchPump(group.id)
    return this.groups.get(group.id)!
  }

  async refresh(groupID: string): Promise<RunGroup> {
    if (this.disposed) throw new Error("Multi-run orchestrator is disposed")
    const group = this.groups.get(groupID)
    if (!group) throw new Error("Unknown run group")
    await this.worktrees.recover()
    await forEachConcurrent(group.runs, MULTI_RUN_MAX_CONCURRENCY, async (run) => {
      if (run.phase === "pending" && this.launchQueues.has(group.id)) return
      await this.recoverRun(group.id, run.id)
    })
    await this.groups.flush()
    if (this.launchQueues.has(groupID)) await this.launchPump(groupID)
    const refreshed = this.groups.get(groupID)!
    for (const run of refreshed.runs) this.scheduleMonitor(groupID, run.id)
    return refreshed
  }

  async cancel(groupID: string, runID?: string): Promise<RunGroup> {
    const group = this.groups.get(groupID)
    if (!group) throw new Error("Unknown run group")
    if (!runID) this.launchQueues.delete(groupID)
    const runs = runID ? group.runs.filter((run) => run.id === runID) : group.runs
    if (runID && !runs.length) throw new Error("Unknown run group or run")
    const cancellable = runs.filter((run) =>
      ["working", "admitting", "preparing", "pending", "needs-input"].includes(run.phase)
    )
    for (const run of cancellable) {
      this.stopMonitor(group.id, run.id)
      this.controllers.get(this.key(group.id, run.id))?.abort(new Error("Run cancelled"))
    }
    let rejected = 0
    for (const run of cancellable) {
      const key = this.key(group.id, run.id)
      const inFlight = this.operations.get(key)
      if (inFlight) await inFlight
      const current = this.run(group.id, run.id)
      let accepted = this.interruptionResults.get(key) ?? current?.session.sessionID === "pending"
      this.interruptionResults.delete(key)
      if (accepted !== true && current && current.session.sessionID !== "pending") {
        accepted = await this.runtimes.forDirectory(current.session.directory).abort(current.session.sessionID).catch(
          () => false,
        )
      }
      if (accepted) {
        this.groups.updateIf(group.id, run.id, ["working", "admitting", "preparing", "pending", "needs-input"], {
          phase: "cancelled",
          completedAt: Date.now(),
          error: undefined,
        })
      } else {
        rejected += 1
        if (current) {
          this.groups.updateIf(group.id, run.id, [current.phase], {
            phase: current.phase,
            error: {
              code: "INTERNAL",
              message: "OpenCode did not confirm interruption; the run remains active",
              retryable: true,
            },
          })
        }
        this.scheduleMonitor(group.id, run.id)
      }
    }
    await this.groups.flush()
    if (runID) this.scheduleLaunchPump(groupID)
    if (rejected) {
      throw new Error(
        `OpenCode did not confirm interruption for ${rejected} run${rejected === 1 ? "" : "s"}; monitoring continues`,
      )
    }
    return this.groups.get(groupID)!
  }

  async retry(groupID: string, runID: string, prompt: string, files: PromptFilePart[] = []): Promise<RunGroup> {
    if (this.disposed) throw new Error("Multi-run orchestrator is disposed")
    const group = this.groups.get(groupID)
    const run = group?.runs.find((candidate) => candidate.id === runID)
    if (!group || !run) throw new Error("Unknown run group or run")
    if (run.discarded || !["failed", "cancelled"].includes(run.phase) || !run.worktreeID) {
      throw new Error("Only a retained failed or cancelled run with a worktree can be retried")
    }
    if (!prompt.trim() || prompt.length > 200_000) throw new Error("Retry prompt is empty or too large")
    const entry = this.worktrees.get(run.worktreeID)
    if (!entry || ["cleanup-pending", "removed"].includes(entry.phase)) {
      throw new Error("Run worktree is no longer available for retry")
    }
    if (
      !this.groups.updateIf(group.id, run.id, ["failed", "cancelled"], {
        phase: "admitting",
        error: undefined,
        completedAt: undefined,
        startedAt: Date.now(),
      })
    ) throw new Error("Run is no longer retryable")
    await this.groups.flush()
    const key = this.key(group.id, run.id)
    const controller = new AbortController()
    this.controllers.set(key, controller)
    const operation = this.retryRun(group.id, run.id, prompt, files, controller)
    this.operations.set(key, operation)
    try {
      await operation
    } finally {
      if (this.operations.get(key) === operation) this.operations.delete(key)
      if (this.controllers.get(key) === controller) this.controllers.delete(key)
    }
    this.scheduleMonitor(group.id, run.id)
    if (this.run(group.id, run.id)?.phase === "working") await this.notifyRunAdmitted(group.id, run.id)
    return this.groups.get(group.id)!
  }

  private scheduleLaunchPump(groupID: string): void {
    if (this.disposed || !this.launchQueues.has(groupID)) return
    void this.launchPump(groupID)
  }

  private launchPump(groupID: string): Promise<void> {
    const existing = this.launchPumps.get(groupID)
    if (existing) return existing
    const pump = this.pumpLaunches(groupID).finally(() => {
      if (this.launchPumps.get(groupID) === pump) this.launchPumps.delete(groupID)
    })
    this.launchPumps.set(groupID, pump)
    return pump
  }

  private async pumpLaunches(groupID: string): Promise<void> {
    while (!this.disposed) {
      const queued = this.launchQueues.get(groupID)
      const group = this.groups.get(groupID)
      if (!queued || !group) return
      const active = group.runs.filter((run) =>
        ["preparing", "admitting", "working", "needs-input"].includes(run.phase)
      ).length
      const pending = group.runs.filter((run) =>
        run.phase === "pending" && !this.operations.has(this.key(groupID, run.id))
      )
      const available = Math.max(0, queued.concurrency - active)
      if (!pending.length) {
        this.launchQueues.delete(groupID)
        return
      }
      if (!available) return
      const selected = pending.slice(0, available)
      await Promise.all(selected.map(async (run) => {
        const index = group.runs.findIndex((candidate) => candidate.id === run.id)
        await this.ensureLaunch(queued.input, groupID, run.id, index)
        const current = this.run(groupID, run.id)
        if (current && ["working", "needs-input"].includes(current.phase)) {
          this.scheduleMonitor(groupID, run.id)
          await this.notifyRunAdmitted(groupID, run.id)
        }
      }))
    }
  }

  private async notifyRunAdmitted(groupID: string, runID: string): Promise<void> {
    await this.options.onRunAdmitted?.(groupID, runID)
  }

  private async ensureLaunch(input: MultiRunInput, groupID: string, runID: string, index: number): Promise<void> {
    const current = this.run(groupID, runID)
    if (!current || !["pending", "preparing", "admitting"].includes(current.phase)) return
    const key = this.key(groupID, runID)
    const existing = this.operations.get(key)
    if (existing) return await existing
    const controller = new AbortController()
    this.controllers.set(key, controller)
    const operation = this.launchRun(input, groupID, runID, index, controller)
    this.operations.set(key, operation)
    try {
      await operation
    } finally {
      if (this.operations.get(key) === operation) this.operations.delete(key)
      if (this.controllers.get(key) === controller) this.controllers.delete(key)
    }
  }

  private async launchRun(
    input: MultiRunInput,
    groupID: string,
    runID: string,
    index: number,
    controller: AbortController,
  ): Promise<void> {
    let worktreeID: string | undefined
    let runtime: RunRuntime | undefined
    let sessionID: string | undefined
    let promptID: string | undefined
    let promptAttempted = false
    try {
      const initial = this.run(groupID, runID)!
      this.groups.updateIf(groupID, runID, ["pending", "preparing", "admitting"], {
        phase: initial.phase === "pending" ? "preparing" : initial.phase,
        startedAt: initial.startedAt ?? Date.now(),
        session: { ...initial.session, runtimeEpoch: input.runtimeEpoch },
      })
      await this.groups.flush()
      const slug = `${groupID.slice(0, 8)}-${index + 1}`
      const mutationID = `${input.mutationID}:worktree:${runID}`
      const worktree = await this.worktrees.create({
        directory: input.repository,
        path: path.join(input.worktreeParent, slug),
        branch: `workbench/run-${slug}`,
        baseRef: input.baseRef,
        mutationID,
      }, controller.signal)
      worktreeID = worktree.id
      const beforeSession = this.run(groupID, runID)!
      const provisional: SessionLocator = {
        ...beforeSession.session,
        directory: worktree.path,
        worktreeID: worktree.id,
        runtimeEpoch: input.runtimeEpoch,
      }
      this.groups.update(groupID, runID, { worktreeID: worktree.id, session: provisional })
      await this.groups.flush()
      if (!this.isActive(groupID, runID, controller)) return
      this.groups.updateIf(groupID, runID, ["preparing", "admitting", "pending"], { phase: "admitting" })
      await this.groups.flush()
      runtime = this.runtimes.forDirectory(worktree.path)

      if (worktree.phase === "prompt-admitted") {
        if (!worktree.sessionID || !worktree.promptID) {
          throw new Error("Recovered prompt-admitted journal entry is incomplete")
        }
        sessionID = worktree.sessionID
        const locator: SessionLocator = { ...provisional, sessionID }
        this.groups.update(groupID, runID, { session: locator })
        await this.groups.flush()
        if (await this.stopCancelled(groupID, runID, controller, runtime, sessionID)) return
        this.groups.updateIf(groupID, runID, ["admitting", "preparing", "pending"], { phase: "working" })
        await this.groups.flush()
        return
      }
      if (["prompt-admitting", "setup-running", "session-creating"].includes(worktree.phase)) {
        throw new Error(`Interrupted ${worktree.phase} operation requires an explicit retry`)
      }

      if (worktree.phase === "session-ready") {
        if (!worktree.sessionID) throw new Error("Recovered session-ready journal entry has no session ID")
        sessionID = worktree.sessionID
      } else {
        await this.worktrees.markDurably(worktree.id, "session-creating")
        const session = await runtime.createSession(`${input.title}: ${beforeSession.model}`)
        sessionID = session.id
        await this.worktrees.markDurably(worktree.id, "session-ready", { sessionID })
      }
      const locator: SessionLocator = { ...provisional, sessionID }
      this.groups.update(groupID, runID, { session: locator })
      await this.groups.flush()
      if (await this.stopCancelled(groupID, runID, controller, runtime, sessionID)) return

      promptID = createOpenCodeMessageID()
      await this.worktrees.markDurably(worktree.id, "prompt-admitting", { sessionID, promptID })
      if (await this.stopCancelled(groupID, runID, controller, runtime, sessionID)) return
      this.options.admission?.prepare(input.promptReceiptID, sessionID, promptID)
      promptAttempted = true
      await runtime.sendPrompt(
        sessionID,
        promptID,
        input.prompt,
        "steer",
        beforeSession.agent,
        beforeSession.model,
        beforeSession.variant,
        input.files,
      )
      this.options.admission?.admit(sessionID, promptID)
      await this.worktrees.markDurably(worktree.id, "prompt-admitted", { sessionID, promptID })
      if (await this.stopCancelled(groupID, runID, controller, runtime, sessionID)) return
      this.groups.updateIf(groupID, runID, ["admitting", "preparing"], { phase: "working" })
      await this.groups.flush()
    } catch (error) {
      if (promptID) this.options.admission?.reject(promptID)
      const journal = worktreeID
        ? this.worktrees.get(worktreeID)
        : this.worktrees.findByMutation(`${input.mutationID}:worktree:${runID}`)
      if (journal) {
        const current = this.run(groupID, runID)
        if (current) {
          this.groups.update(groupID, runID, {
            worktreeID: journal.id,
            session: {
              ...current.session,
              directory: journal.path,
              worktreeID: journal.id,
              sessionID: journal.sessionID ?? current.session.sessionID,
            },
          })
        }
      }
      if (!this.isActive(groupID, runID, controller)) {
        if (runtime && sessionID) await runtime.abort(sessionID).catch(() => undefined)
        return
      }
      const structured = promptAttempted ? promptAdmissionError() : errorValue(error)
      if (journal && journal.phase !== "failed" && journal.phase !== "removed") {
        await this.worktrees.failDurably(journal.id, structured)
      }
      this.groups.updateIf(groupID, runID, ["pending", "preparing", "admitting"], {
        phase: "failed",
        completedAt: Date.now(),
        error: structured,
        worktreeID: journal?.id,
      })
      await this.groups.flush()
    }
  }

  private async retryRun(
    groupID: string,
    runID: string,
    prompt: string,
    files: PromptFilePart[],
    controller: AbortController,
  ): Promise<void> {
    const initial = this.run(groupID, runID)!
    const worktreeID = initial.worktreeID!
    const entry = this.worktrees.get(worktreeID)
    if (!entry) {
      this.groups.updateIf(groupID, runID, ["admitting"], {
        phase: "failed",
        completedAt: Date.now(),
        error: { code: "SESSION_NOT_FOUND", message: "Run worktree journal entry is missing", retryable: false },
      })
      await this.groups.flush()
      return
    }
    const runtime = this.runtimes.forDirectory(entry.path)
    let sessionID = initial.session.sessionID === "pending" ? entry.sessionID : initial.session.sessionID
    let promptID: string | undefined
    let promptAttempted = false
    try {
      if (!sessionID || sessionID === "pending") {
        await this.worktrees.markDurably(entry.id, "session-creating")
        const session = await runtime.createSession(`Retry: ${initial.model}`)
        sessionID = session.id
        await this.worktrees.markDurably(entry.id, "session-ready", { sessionID })
      }
      this.groups.update(groupID, runID, {
        session: { ...initial.session, sessionID, directory: entry.path, worktreeID: entry.id },
      })
      await this.groups.flush()
      if (await this.stopCancelled(groupID, runID, controller, runtime, sessionID)) return
      promptID = createOpenCodeMessageID()
      await this.worktrees.markDurably(entry.id, "prompt-admitting", { sessionID, promptID })
      if (await this.stopCancelled(groupID, runID, controller, runtime, sessionID)) return
      const sourceReceiptID = this.groups.get(groupID)?.promptReceiptID
      this.options.admission?.prepare(sourceReceiptID, sessionID, promptID)
      promptAttempted = true
      await runtime.sendPrompt(
        sessionID,
        promptID,
        prompt,
        "steer",
        initial.agent,
        initial.model,
        initial.variant,
        files,
      )
      this.options.admission?.admit(sessionID, promptID)
      await this.worktrees.markDurably(entry.id, "prompt-admitted", { sessionID, promptID })
      if (await this.stopCancelled(groupID, runID, controller, runtime, sessionID)) return
      this.groups.updateIf(groupID, runID, ["admitting"], { phase: "working" })
      await this.groups.flush()
    } catch (error) {
      if (promptID) this.options.admission?.reject(promptID)
      if (!this.isActive(groupID, runID, controller)) {
        if (sessionID && sessionID !== "pending") await runtime.abort(sessionID).catch(() => undefined)
        return
      }
      const structured = promptAttempted ? promptAdmissionError() : errorValue(error)
      try {
        await this.worktrees.failDurably(entry.id, structured)
      } catch { /* Cleanup may have completed while the retry was in flight. */ }
      this.groups.updateIf(groupID, runID, ["admitting"], {
        phase: "failed",
        completedAt: Date.now(),
        error: structured,
      })
      await this.groups.flush()
    }
  }

  private async recoverRun(groupID: string, runID: string): Promise<void> {
    const key = this.key(groupID, runID)
    if (this.operations.has(key)) return
    const run = this.run(groupID, runID)
    const group = this.groups.get(groupID)
    if (!run || !group || run.discarded) return
    const mutationID = group.mutationID ? `${group.mutationID}:worktree:${run.id}` : undefined
    const entry = (run.worktreeID ? this.worktrees.get(run.worktreeID) : undefined) ??
      (mutationID ? this.worktrees.findByMutation(mutationID) : undefined)
    if (entry?.phase === "removed") {
      this.groups.update(groupID, runID, {
        phase: "cancelled",
        discarded: true,
        completedAt: run.completedAt ?? Date.now(),
        error: undefined,
      })
      return
    }
    if (["completed", "failed", "cancelled"].includes(run.phase)) return
    if (!entry) {
      if (["pending", "preparing", "admitting", "working", "needs-input"].includes(run.phase)) {
        this.groups.updateIf(groupID, runID, [run.phase], {
          phase: "failed",
          completedAt: Date.now(),
          error: {
            code: "SESSION_NOT_FOUND",
            message: "Run worktree journal entry is missing after restart",
            retryable: false,
          },
        })
      }
      return
    }
    const sessionID = entry.sessionID ?? run.session.sessionID
    const locator: SessionLocator = { ...run.session, sessionID, directory: entry.path, worktreeID: entry.id }
    this.groups.update(groupID, runID, { worktreeID: entry.id, session: locator })
    if (entry.phase === "prompt-admitted" && sessionID !== "pending") {
      this.groups.updateIf(groupID, runID, ["pending", "preparing", "admitting"], { phase: "working" })
      await this.pollRun(groupID, runID)
      return
    }
    const retryable = !["removed", "cleanup-pending", "retained-dirty"].includes(entry.phase)
    const message = entry.phase === "prompt-admitting"
      ? "Prompt admission was interrupted and cannot be replayed without explicit user confirmation"
      : `Run launch was interrupted during ${entry.phase}`
    this.groups.updateIf(groupID, runID, ["pending", "preparing", "admitting", "working", "needs-input"], {
      phase: "failed",
      completedAt: Date.now(),
      error: { code: retryable ? "OPERATION_CONFLICT" : "SESSION_NOT_FOUND", message, retryable },
    })
  }

  private async pollRun(groupID: string, runID: string): Promise<void> {
    const run = this.run(groupID, runID)
    if (!run || !["working", "needs-input"].includes(run.phase) || run.session.sessionID === "pending") return
    try {
      const runtime = this.runtimes.forDirectory(run.session.directory)
      const status = (await runtime.statuses())[run.session.sessionID]
      const needsInput = await runtime.needsInput?.(run.session.sessionID) ?? false
      if (status?.type === "error") {
        this.groups.updateIf(groupID, runID, ["working", "needs-input"], {
          phase: "failed",
          completedAt: Date.now(),
          error: { code: "INTERNAL", message: "OpenCode run failed", retryable: true },
        })
      } else if (needsInput) {
        this.groups.updateIf(groupID, runID, ["working", "needs-input"], { phase: "needs-input", error: undefined })
      } else if (!status || status.type === "idle") {
        const inspection = await runtime.inspectSession(run.session.sessionID)
        const outcome = sessionTurnOutcome(status, inspection.exists, inspection.messages)
        if (outcome.state === "missing") {
          this.groups.updateIf(groupID, runID, ["working", "needs-input"], {
            phase: "failed",
            completedAt: Date.now(),
            error: { code: "SESSION_NOT_FOUND", message: "OpenCode run session no longer exists", retryable: false },
          })
        } else if (outcome.state === "failed") {
          this.groups.updateIf(groupID, runID, ["working", "needs-input"], {
            phase: "failed",
            completedAt: Date.now(),
            error: { code: "INTERNAL", message: "OpenCode run failed", retryable: true },
          })
        } else if (outcome.state === "completed") {
          this.groups.updateIf(groupID, runID, ["working", "needs-input"], {
            phase: "completed",
            completedAt: Date.now(),
            error: undefined,
          })
        } else {
          this.groups.updateIf(groupID, runID, ["working", "needs-input"], { phase: "working", error: undefined })
        }
      } else this.groups.updateIf(groupID, runID, ["working", "needs-input"], { phase: "working", error: undefined })
      await this.groups.flush()
    } catch {
      const current = this.run(groupID, runID)
      if (current && ["working", "needs-input"].includes(current.phase)) {
        this.groups.updateIf(groupID, runID, [current.phase], {
          phase: current.phase,
          error: {
            code: "INTERNAL",
            message: "Run status is temporarily unavailable; monitoring will retry",
            retryable: true,
          },
        })
      }
      await this.groups.flush()
    }
    const current = this.run(groupID, runID)
    if (!current || !["preparing", "admitting", "working", "needs-input"].includes(current.phase)) {
      this.scheduleLaunchPump(groupID)
    }
  }

  private scheduleMonitor(groupID: string, runID: string): void {
    const interval = this.options.monitorIntervalMilliseconds
    const key = this.key(groupID, runID)
    const run = this.run(groupID, runID)
    if (
      this.disposed || interval === undefined || this.monitorTimers.has(key) || !run ||
      !["working", "needs-input"].includes(run.phase)
    ) return
    const timer = setTimeout(() => {
      this.monitorTimers.delete(key)
      void this.pollRun(groupID, runID).finally(() => this.scheduleMonitor(groupID, runID))
    }, interval)
    this.monitorTimers.set(key, timer)
  }

  private stopMonitor(groupID: string, runID: string): void {
    const key = this.key(groupID, runID)
    const timer = this.monitorTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.monitorTimers.delete(key)
  }

  private async stopCancelled(
    groupID: string,
    runID: string,
    controller: AbortController,
    runtime: RunRuntime,
    sessionID: string,
  ): Promise<boolean> {
    if (this.isActive(groupID, runID, controller)) return false
    const accepted = await runtime.abort(sessionID).catch(() => false)
    this.interruptionResults.set(this.key(groupID, runID), accepted)
    if (!accepted) throw new Error("OpenCode did not confirm interruption")
    return true
  }

  private isActive(groupID: string, runID: string, controller: AbortController): boolean {
    const run = this.run(groupID, runID)
    return !controller.signal.aborted && run !== undefined && !run.discarded &&
      ["pending", "preparing", "admitting"].includes(run.phase)
  }

  private run(groupID: string, runID: string): RunReference | undefined {
    return this.groups.get(groupID)?.runs.find((candidate) => candidate.id === runID)
  }

  private key(groupID: string, runID: string): string {
    return `${groupID}:${runID}`
  }
}
