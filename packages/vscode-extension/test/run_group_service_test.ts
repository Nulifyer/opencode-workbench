import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert"
import type { RunGroup, SessionStatus, StructuredError, WorktreeJournalEntry, WorktreePhase } from "@opencode-workbench/shared"
import { MultiRunOrchestrator, RunGroupService, type RunRuntime, type RunRuntimeFactory } from "../src/application/run-group-service.ts"

class FakeWorktrees {
  count = 0
  readonly phases: Array<{ id: string; phase: WorktreePhase }> = []
  private readonly entries = new Map<string, WorktreeJournalEntry>()

  constructor(private readonly failAt = 2, initial: WorktreeJournalEntry[] = [], private readonly failureMessage = "create failed") {
    for (const entry of initial) this.entries.set(entry.id, { ...entry })
  }

  async create(input: { path: string; branch: string; baseRef: string; mutationID: string }) {
    const duplicate = this.findByMutation(input.mutationID)
    if (duplicate) return duplicate
    this.count++
    if (this.count === this.failAt) throw new Error(this.failureMessage)
    const entry: WorktreeJournalEntry = {
      id: `wt-${this.count}`, mutationID: input.mutationID, owner: "workbench", repository: "/repo", repositoryID: "repo",
      path: input.path, branch: input.branch, baseRef: input.baseRef, phase: "ready", createdAt: 1, updatedAt: 1,
    }
    this.entries.set(entry.id, entry)
    return { ...entry }
  }
  mark(id: string, phase: WorktreePhase, values: Pick<WorktreeJournalEntry, "sessionID" | "promptID"> = {}) {
    const entry = this.entries.get(id)!
    Object.assign(entry, values, { phase })
    this.phases.push({ id, phase })
    return { ...entry }
  }
  async markDurably(id: string, phase: WorktreePhase, values: Pick<WorktreeJournalEntry, "sessionID" | "promptID"> = {}) { return this.mark(id, phase, values) }
  fail(id: string, error: StructuredError) { const entry = this.entries.get(id)!; Object.assign(entry, { phase: "failed" as const, error }); return { ...entry } }
  async failDurably(id: string, error: StructuredError) { return this.fail(id, error) }
  async flush() { /* In-memory fake is immediately durable. */ }
  get(id: string) { const entry = this.entries.get(id); return entry ? { ...entry } : undefined }
  findByMutation(id: string) { const entry = [...this.entries.values()].find((candidate) => candidate.mutationID === id); return entry ? { ...entry } : undefined }
  journal() { return [...this.entries.values()].map((entry) => ({ ...entry })) }
  async recover() { return this.journal() }
}
class FakeRuntimes implements RunRuntimeFactory {
  prompts = 0
  aborts = 0
  abortAccepted = true
  status = "idle"
  statusFailure = false
  omitStatus = false
  inputPending = false
  sessionExists = true
  assistantError = false
  assistantComplete = true
  forDirectory(_directory: string): RunRuntime {
    return {
      createSession: async () => ({ id: "session" }),
      sendPrompt: async () => { this.prompts++ },
      abort: async () => { this.aborts++; return this.abortAccepted },
      statuses: async (): Promise<Record<string, SessionStatus>> => {
        if (this.statusFailure) throw new Error("OpenCode is restarting")
        return this.omitStatus ? {} : { session: { type: this.status } as SessionStatus }
      },
      needsInput: async () => this.inputPending,
      inspectSession: async () => ({
        exists: this.sessionExists,
        messages: this.sessionExists
          ? [
            { info: { id: "user", sessionID: "session", role: "user" }, parts: [] },
            ...(this.assistantComplete || this.assistantError
              ? [{
                info: { id: "assistant", sessionID: "session", role: "assistant" as const, ...(this.assistantError ? { error: { name: "ProviderError" } } : {}) },
                parts: this.assistantComplete ? [{ id: "text", sessionID: "session", messageID: "assistant", type: "text", text: "done" }] : [],
              }]
              : []),
          ]
          : [],
      }),
    }
  }
}

Deno.test("multi-run isolates partial launch failures and persists no prompt bytes", async () => {
  const groups = new RunGroupService()
  const orchestrator = new MultiRunOrchestrator(groups, new FakeWorktrees() as never, new FakeRuntimes())
  const group = await orchestrator.start({ mutationID: "mutation", title: "Compare", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement it", runs: [{ model: "provider/a" }, { model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  assertEquals(group.runs.map((run) => run.phase), ["working", "failed"])
  assertEquals(JSON.stringify(groups.list()).includes("Implement it"), false)
})

Deno.test("multi-run queues candidate launches independently from group size", async () => {
  let active = 0
  let peak = 0
  let started = 0
  const releases: Array<() => void> = []
  const runtimes: RunRuntimeFactory = {
    forDirectory: (directory) => ({
      createSession: async () => ({ id: `session-${directory.split("/").at(-1)}` }),
      sendPrompt: async () => {
        started += 1
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => releases.push(() => {
          active -= 1
          resolve()
        }))
      },
      abort: async () => true,
      statuses: async () => ({}),
      inspectSession: async () => ({ exists: true, messages: [] }),
    }),
  }
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 1_000 && !predicate(); attempt += 1) await Promise.resolve()
    if (!predicate()) throw new Error("Timed out waiting for queued multi-run launch")
  }
  const groups = new RunGroupService()
  const orchestrator = new MultiRunOrchestrator(groups, new FakeWorktrees(999) as never, runtimes)
  const launching = orchestrator.start({
    mutationID: "queued",
    ownerSessionID: "origin",
    title: "Queued comparison",
    repository: Deno.cwd(),
    baseRef: "HEAD",
    promptReceiptID: "receipt",
    prompt: "Implement it",
    runs: Array.from({ length: 6 }, (_, index) => ({ model: `provider/model-${index}` })),
    concurrency: 2,
    worktreeParent: "/tmp/runs",
    runtimeEpoch: "epoch",
  })
  await waitFor(() => started === 2)
  assertEquals(peak, 2)
  for (let target = 3; target <= 6; target += 1) {
    releases.shift()!()
    await waitFor(() => started === target)
    assertEquals(active <= 2, true)
  }
  while (releases.length) releases.shift()!()
  const group = await launching
  assertEquals(group.ownerSessionID, "origin")
  assertEquals(group.runs.length, 6)
  assertEquals(peak, 2)
})

Deno.test("run-group mutation IDs are idempotent", () => {
  const groups = new RunGroupService()
  const input = { mutationID: "same", title: "Compare", repository: "/repo", baseRef: "HEAD", promptReceiptID: "receipt", isolation: "worktree" as const, runs: [{ id: "one", model: "a" }, { id: "two", model: "b" }] }
  assertEquals(groups.create(input).id, groups.create(input).id)
  const restarted = new RunGroupService(groups.list())
  assertEquals(restarted.create(input).id, groups.create(input).id)
  assertThrows(() => groups.create({ ...input, title: "Different" }), Error, "different request")
  groups.update(groups.create(input).id, "one", { retained: true })
  assertEquals(new RunGroupService(groups.list()).get(groups.create(input).id)?.runs[0]?.retained, true)
})

Deno.test("run-group insertion retains only the newest protocol-safe 500 groups", () => {
  const persistedLengths: number[] = []
  const input = (index: number) => ({
    mutationID: `mutation-${index}`,
    title: `Comparison ${index}`,
    repository: "/repo",
    baseRef: "HEAD",
    promptReceiptID: `receipt-${index}`,
    isolation: "worktree" as const,
    runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }],
  })
  const initial: RunGroup[] = Array.from({ length: 500 }, (_, index) => ({
    ...input(index),
    id: `group-${index}`,
    createdAt: index,
    runs: input(index).runs.map((run) => ({ ...run, phase: "completed", session: { sessionID: `session-${index}-${run.id}`, directory: "/repo", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } })),
  }))
  const groups = new RunGroupService(initial, (values) => { persistedLengths.push(values.length) })
  const oldest = initial[0]!
  const newest = groups.create(input(500))

  assertEquals(groups.list().length, 500)
  assertEquals(groups.get(oldest.id), undefined)
  assertEquals(groups.get(newest.id)?.id, newest.id)
  assertEquals(Math.max(...persistedLengths), 500)
  assertEquals(groups.create(input(0)).id === oldest.id, false)
  assertEquals(groups.list().length, 500)
})

Deno.test("run-group capacity never evicts active or needs-input groups and preserves duplicate mutations", () => {
  const input = (index: number) => ({
    mutationID: `active-mutation-${index}`,
    title: `Active comparison ${index}`,
    repository: "/repo",
    baseRef: "HEAD",
    promptReceiptID: `receipt-${index}`,
    isolation: "worktree" as const,
    runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }],
  })
  const activePhases = ["pending", "preparing", "admitting", "working", "needs-input"] as const
  const initial: RunGroup[] = Array.from({ length: 500 }, (_, index) => ({
    ...input(index),
    id: `active-group-${index}`,
    createdAt: index,
    runs: input(index).runs.map((run, runIndex) => ({
      ...run,
      phase: runIndex === 0 ? activePhases[index % activePhases.length]! : "completed" as const,
      session: { sessionID: `session-${index}-${run.id}`, directory: "/repo", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" },
    })),
  }))
  const groups = new RunGroupService(initial)
  let notifications = 0
  groups.subscribe(() => notifications++)

  assertEquals(groups.create(input(0)).id, initial[0]!.id)
  assertThrows(() => groups.create(input(500)), Error, "journal limit reached")
  assertEquals(groups.list().length, 500)
  assertEquals(initial.every((group) => groups.get(group.id)?.id === group.id), true)
  assertEquals(notifications, 0)
})

Deno.test("run-group errors are bounded and redact credentials across ingress, persistence, and runtime failures", async () => {
  const unsafe = "Authorization: \"Bearer auth-value\"\nCookie: session=cookie-value; refresh=refresh-value\nOPENAI_API_KEY=env-secret password=top-secret https://user:pass@example.com/path\t" + "x".repeat(3_000)
  const structured = { code: "INTERNAL", message: unsafe, retryable: true, details: { token: "details-secret" } } as StructuredError
  const initial: RunGroup = {
    id: "unsafe", mutationID: "unsafe", title: "Unsafe", repository: "/repo", baseRef: "HEAD", promptReceiptID: "receipt", isolation: "worktree", createdAt: 1,
    runs: [
      { id: "one", model: "provider/a", phase: "failed", error: structured, session: { sessionID: "one", directory: "/repo", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
      { id: "two", model: "provider/b", phase: "completed", session: { sessionID: "two", directory: "/repo", experience: "workbench", transport: "http-sse", runtimeEpoch: "epoch" } },
    ],
  }
  let persisted: RunGroup[] = []
  const observed: RunGroup[][] = []
  const groups = new RunGroupService([initial], (values) => { persisted = values })
  groups.subscribe((values) => observed.push(values))
  const loaded = groups.get(initial.id)?.runs[0]?.error
  groups.update(initial.id, "one", { error: structured })

  for (const error of [loaded, persisted[0]?.runs[0]?.error, observed[0]?.[0]?.runs[0]?.error]) {
    assertEquals(Boolean(error), true)
    assertEquals(error?.message.length! <= 2_000, true)
    assertEquals(error?.message.includes("auth-value"), false)
    assertEquals(error?.message.includes("cookie-value"), false)
    assertEquals(error?.message.includes("refresh-value"), false)
    assertEquals(error?.message.includes("env-secret"), false)
    assertEquals(error?.message.includes("top-secret"), false)
    assertEquals(error?.message.includes("user:pass"), false)
    assertEquals(error?.message.includes("\n"), false)
    assertEquals(error?.details, undefined)
  }

  const runtimeGroups = new RunGroupService()
  const orchestrator = new MultiRunOrchestrator(runtimeGroups, new FakeWorktrees(1, [], unsafe) as never, new FakeRuntimes())
  const failed = await orchestrator.start({ mutationID: "runtime-secret", title: "Runtime error", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  const runtimeError = failed.runs.find((run) => run.phase === "failed")?.error
  assertEquals(Boolean(runtimeError), true)
  assertEquals(runtimeError?.message.includes("auth-value"), false)
  assertEquals(runtimeError?.message.includes("cookie-value"), false)
  assertEquals(runtimeError?.message.includes("env-secret"), false)
  assertEquals(runtimeError?.message.includes("user:pass"), false)
  assertEquals(runtimeError?.message.length! <= 2_000, true)
})

Deno.test("run-group subscriptions publish isolated snapshots and dispose cleanly", () => {
  const groups = new RunGroupService()
  const observed: RunGroup[][] = []
  const subscription = groups.subscribe((snapshot) => {
    observed.push(snapshot)
    snapshot[0]!.title = "subscriber mutation"
  })
  const input = { mutationID: "subscription", title: "Compare", repository: "/repo", baseRef: "HEAD", promptReceiptID: "receipt", isolation: "worktree" as const, runs: [{ id: "one", model: "a" }, { id: "two", model: "b" }] }
  const group = groups.create(input)
  assertEquals(observed.length, 1)
  assertEquals(groups.get(group.id)?.title, "Compare")
  subscription.dispose()
  groups.update(group.id, "one", { retained: true })
  assertEquals(observed.length, 1)
  for (let index = 0; index < 64; index += 1) groups.subscribe(() => undefined)
  assertThrows(() => groups.subscribe(() => undefined), Error, "listener limit")
})

Deno.test("concurrent duplicate launches share the same run operations", async () => {
  const groups = new RunGroupService()
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const runtimes = new FakeRuntimes()
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const input = { mutationID: "duplicate", title: "Compare", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Exactly once", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" }
  const [first, second] = await Promise.all([orchestrator.start(input), orchestrator.start(input)])
  assertEquals(first.id, second.id)
  assertEquals(worktrees.count, 2)
  assertEquals(runtimes.prompts, 2)
})

Deno.test("multi-run launch waits for a durable group checkpoint before creating worktrees", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let persisted = 0
  const groups = new RunGroupService([], async () => { persisted++; await gate })
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, new FakeRuntimes())
  const starting = orchestrator.start({ mutationID: "durable-group", title: "Durable", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  while (!persisted) await Promise.resolve()
  assertEquals(worktrees.count, 0)
  release()
  assertEquals((await starting).runs.map((run) => run.phase), ["working", "working"])
})

Deno.test("failed admitted runs can be retried independently without persisted prompt bytes", async () => {
  const groups = new RunGroupService()
  const worktrees = new FakeWorktrees()
  const runtimes = new FakeRuntimes()
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const group = await orchestrator.start({ mutationID: "retry", title: "Compare", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Original", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  groups.update(group.id, "one", { phase: "failed", completedAt: 2 })
  const retried = await orchestrator.retry(group.id, "one", "Explicit retry")
  assertEquals(retried.runs.find((run) => run.id === "one")?.phase, "working")
  assertEquals(runtimes.prompts, 2)
  assertEquals(JSON.stringify(groups.list()).includes("Explicit retry"), false)
  groups.update(group.id, "one", { phase: "cancelled", discarded: true })
  await assertRejects(() => orchestrator.retry(group.id, "one", "Do not revive"), Error, "retained")
  groups.update(group.id, "one", { discarded: false })
  worktrees.mark(group.runs[0]!.worktreeID!, "removed")
  await assertRejects(() => orchestrator.retry(group.id, "one", "Still do not revive"), Error, "no longer available")
  assertEquals(groups.get(group.id)?.runs[0]?.phase, "cancelled")
})

Deno.test("multi-run group cancellation is independent and restart refresh recovers status", async () => {
  const groups = new RunGroupService()
  const runtimes = new FakeRuntimes()
  const worktrees = new FakeWorktrees()
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const group = await orchestrator.start({ mutationID: "cancel", title: "Compare", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  const cancelled = await orchestrator.cancel(group.id)
  assertEquals(cancelled.runs.map((run) => run.phase), ["cancelled", "failed"])
  assertEquals(runtimes.aborts, 1)

  const restoredGroups = new RunGroupService(groups.list())
  const restored = new MultiRunOrchestrator(restoredGroups, new FakeWorktrees(2, worktrees.journal()) as never, runtimes)
  groups.update(group.id, "one", { phase: "working" })
  const restartGroups = new RunGroupService(groups.list())
  const restart = new MultiRunOrchestrator(restartGroups, new FakeWorktrees(2, worktrees.journal()) as never, runtimes)
  assertEquals((await restart.refresh(group.id)).runs.find((run) => run.id === "one")?.phase, "completed")
  assertEquals(await restored.refresh(group.id).then((value) => value.id), group.id)
})

Deno.test("multi-run does not report cancellation until OpenCode confirms interruption", async () => {
  const groups = new RunGroupService()
  const runtimes = new FakeRuntimes()
  runtimes.status = "busy"
  const orchestrator = new MultiRunOrchestrator(groups, new FakeWorktrees(Number.POSITIVE_INFINITY) as never, runtimes)
  const group = await orchestrator.start({ mutationID: "cancel-rejected", title: "Cancel", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  runtimes.abortAccepted = false
  await assertRejects(() => orchestrator.cancel(group.id, "one"), Error, "did not confirm interruption")
  assertEquals(groups.get(group.id)?.runs[0]?.phase, "working")
  assertEquals(groups.get(group.id)?.runs[0]?.error?.retryable, true)
})

Deno.test("multi-run refresh exposes and clears pending user input", async () => {
  const groups = new RunGroupService()
  const runtimes = new FakeRuntimes()
  runtimes.status = "busy"
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const group = await orchestrator.start({ mutationID: "input", title: "Compare", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  runtimes.inputPending = true
  assertEquals((await orchestrator.refresh(group.id)).runs.map((run) => run.phase), ["needs-input", "needs-input"])
  runtimes.inputPending = false
  assertEquals((await orchestrator.refresh(group.id)).runs.map((run) => run.phase), ["working", "working"])
})

Deno.test("multi-run treats omitted status as idle but never completes pending input", async () => {
  const groups = new RunGroupService()
  const runtimes = new FakeRuntimes()
  runtimes.status = "busy"
  const orchestrator = new MultiRunOrchestrator(groups, new FakeWorktrees(Number.POSITIVE_INFINITY) as never, runtimes)
  const group = await orchestrator.start({ mutationID: "omitted-status", title: "Omitted", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  runtimes.omitStatus = true
  runtimes.inputPending = true
  assertEquals((await orchestrator.refresh(group.id)).runs.map((run) => run.phase), ["needs-input", "needs-input"])
  runtimes.inputPending = false
  assertEquals((await orchestrator.refresh(group.id)).runs.map((run) => run.phase), ["completed", "completed"])
})

Deno.test("multi-run sparse status verifies persisted outcome before reporting completion", async () => {
  const groups = new RunGroupService()
  const runtimes = new FakeRuntimes()
  runtimes.status = "busy"
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const group = await orchestrator.start({ mutationID: "outcomes", title: "Outcomes", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })

  runtimes.omitStatus = true
  runtimes.assistantComplete = false
  assertEquals((await orchestrator.refresh(group.id)).runs.map((run) => run.phase), ["working", "working"])

  runtimes.assistantError = true
  assertEquals((await orchestrator.refresh(group.id)).runs.map((run) => run.phase), ["failed", "failed"])

  const missingGroups = new RunGroupService(groups.list().map((stored) => ({
    ...stored,
    runs: stored.runs.map((run) => ({ ...run, phase: "working" as const, error: undefined, completedAt: undefined })),
  })))
  runtimes.assistantError = false
  runtimes.sessionExists = false
  const missing = new MultiRunOrchestrator(missingGroups, new FakeWorktrees(Number.POSITIVE_INFINITY, worktrees.journal()) as never, runtimes)
  const refreshed = await missing.refresh(group.id)
  assertEquals(refreshed.runs.map((run) => run.error?.code), ["SESSION_NOT_FOUND", "SESSION_NOT_FOUND"])
})

Deno.test("multi-run retries transient observation failures without terminalizing an active run", async () => {
  const groups = new RunGroupService()
  const runtimes = new FakeRuntimes()
  runtimes.status = "busy"
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const group = await orchestrator.start({ mutationID: "restart", title: "Restart", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  runtimes.statusFailure = true
  const unavailable = await orchestrator.refresh(group.id)
  assertEquals(unavailable.runs.map((run) => run.phase), ["working", "working"])
  assertEquals(unavailable.runs.every((run) => run.error?.retryable), true)

  runtimes.statusFailure = false
  runtimes.status = "idle"
  const recovered = await orchestrator.refresh(group.id)
  assertEquals(recovered.runs.map((run) => run.phase), ["completed", "completed"])
  assertEquals(recovered.runs.every((run) => run.error === undefined), true)
})

Deno.test("multi-run background monitoring publishes input and terminal phases", async () => {
  const groups = new RunGroupService()
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const runtimes = new FakeRuntimes()
  runtimes.status = "busy"
  runtimes.inputPending = true
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes, { monitorIntervalMilliseconds: 100 })
  const group = await orchestrator.start({ mutationID: "monitor", title: "Monitor", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Observe", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  await new Promise((resolve) => setTimeout(resolve, 130))
  assertEquals(groups.get(group.id)?.runs.map((run) => run.phase), ["needs-input", "needs-input"])
  runtimes.inputPending = false
  runtimes.status = "idle"
  await new Promise((resolve) => setTimeout(resolve, 130))
  assertEquals(groups.get(group.id)?.runs.map((run) => run.phase), ["completed", "completed"])
  orchestrator.dispose()
})

Deno.test("multi-run binds the group context receipt to every admitted run prompt", async () => {
  const groups = new RunGroupService()
  const prepared: Array<{ source?: string; sessionID: string; promptID: string }> = []
  const admitted: string[] = []
  const rejected: string[] = []
  const orchestrator = new MultiRunOrchestrator(groups, new FakeWorktrees(Number.POSITIVE_INFINITY) as never, new FakeRuntimes(), {
    admission: {
      prepare: (source, sessionID, promptID) => prepared.push({ source, sessionID, promptID }),
      admit: (_sessionID, promptID) => admitted.push(promptID),
      reject: (promptID) => rejected.push(promptID),
    },
  })
  await orchestrator.start({ mutationID: "receipts", title: "Receipts", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "context:group", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  assertEquals(prepared.length, 2)
  assertEquals(prepared.every((entry) => entry.source === "context:group"), true)
  assertEquals(new Set(prepared.map((entry) => entry.promptID)).size, 2)
  assertEquals(new Set(admitted).size, 2)
  assertEquals(rejected, [])
})

Deno.test("multi-run journals every external admission boundary in order", async () => {
  const groups = new RunGroupService()
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, new FakeRuntimes())
  const group = await orchestrator.start({ mutationID: "phases", title: "Compare", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Private prompt", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  for (const run of group.runs) {
    assertEquals(worktrees.phases.filter((entry) => entry.id === run.worktreeID).map((entry) => entry.phase), ["session-creating", "session-ready", "prompt-admitting", "prompt-admitted"])
  }
  assertEquals(JSON.stringify(worktrees.journal()).includes("Private prompt"), false)
})

Deno.test("prompt admission failures cannot copy prompt text into durable state", async () => {
  const groups = new RunGroupService()
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const runtimes: RunRuntimeFactory = {
    forDirectory: () => ({
      createSession: async () => ({ id: "session" }),
      sendPrompt: async (_sessionID, _promptID, text) => { throw new Error(`upstream echoed: ${text}`) },
      abort: async () => true,
      statuses: async () => ({}),
      inspectSession: async () => ({ exists: true, messages: [] }),
    }),
  }
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const group = await orchestrator.start({ mutationID: "privacy", title: "Compare", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "do-not-persist-this", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  assertEquals(group.runs.map((run) => run.phase), ["failed", "failed"])
  assertEquals(JSON.stringify({ groups: groups.list(), journal: worktrees.journal() }).includes("do-not-persist-this"), false)
})

Deno.test("cancellation wins races with session creation and prevents prompt admission", async () => {
  const groups = new RunGroupService()
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const resolvers: Array<() => void> = []
  let creates = 0
  let prompts = 0
  let aborts = 0
  const runtimes: RunRuntimeFactory = {
    forDirectory: () => ({
      createSession: async () => {
        creates++
        await new Promise<void>((resolve) => resolvers.push(resolve))
        return { id: `session-${creates}` }
      },
      sendPrompt: async () => { prompts++ },
      abort: async () => { aborts++; return true },
      statuses: async () => ({}),
      inspectSession: async () => ({ exists: true, messages: [] }),
    }),
  }
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const starting = orchestrator.start({ mutationID: "race", title: "Compare", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Never admit", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  while (resolvers.length < 2) await Promise.resolve()
  const groupID = groups.list()[0]!.id
  const cancelling = orchestrator.cancel(groupID)
  for (const resolve of resolvers) resolve()
  await cancelling
  const result = await starting
  assertEquals(result.runs.map((run) => run.phase), ["cancelled", "cancelled"])
  assertEquals(prompts, 0)
  assertEquals(aborts, 2)
})

Deno.test("restart recovery resumes admitted prompts and fails ambiguous admission safely", async () => {
  const groups = new RunGroupService()
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const runtimes = new FakeRuntimes()
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const launched = await orchestrator.start({ mutationID: "recover", title: "Compare", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  groups.update(launched.id, "one", { phase: "admitting" })
  groups.update(launched.id, "two", { phase: "preparing" })
  worktrees.mark(launched.runs[1]!.worktreeID!, "prompt-admitting", { sessionID: launched.runs[1]!.session.sessionID, promptID: "uncertain" })

  const restoredGroups = new RunGroupService(groups.list())
  const restored = new MultiRunOrchestrator(restoredGroups, new FakeWorktrees(Number.POSITIVE_INFINITY, worktrees.journal()) as never, runtimes)
  const recovered = await restored.refresh(launched.id)
  assertEquals(recovered.runs[0]?.phase, "completed")
  assertEquals(recovered.runs[1]?.phase, "failed")
  assertEquals(recovered.runs[1]?.error?.code, "OPERATION_CONFLICT")
  assertEquals(recovered.runs[1]?.error?.retryable, true)
  assertEquals(runtimes.prompts, 2)
})

Deno.test("restart reconciliation treats an already removed run worktree as discarded", async () => {
  const groups = new RunGroupService()
  const worktrees = new FakeWorktrees(Number.POSITIVE_INFINITY)
  const runtimes = new FakeRuntimes()
  const orchestrator = new MultiRunOrchestrator(groups, worktrees as never, runtimes)
  const launched = await orchestrator.start({ mutationID: "removed", title: "Removed", repository: Deno.cwd(), baseRef: "HEAD", promptReceiptID: "receipt", prompt: "Implement", runs: [{ id: "one", model: "provider/a" }, { id: "two", model: "provider/b" }], worktreeParent: "/tmp/runs", runtimeEpoch: "epoch" })
  groups.update(launched.id, "one", { phase: "working" })
  worktrees.mark(launched.runs[0]!.worktreeID!, "removed")

  const restoredGroups = new RunGroupService(groups.list())
  const restored = new MultiRunOrchestrator(restoredGroups, new FakeWorktrees(Number.POSITIVE_INFINITY, worktrees.journal()) as never, runtimes)
  const run = (await restored.refresh(launched.id)).runs[0]!
  assertEquals({ phase: run.phase, discarded: run.discarded, error: run.error }, { phase: "cancelled", discarded: true, error: undefined })
})
