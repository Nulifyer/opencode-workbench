import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert"
import type { WorktreeJournalEntry, WorktreePhase } from "@opencode-workbench/shared"
import { WorktreeService, type GitRunner } from "../src/application/worktree-service.ts"

class FakeGit implements GitRunner {
  calls: string[][] = []
  dirty = false
  listed = ""
  async run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    this.calls.push([cwd, ...args])
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${cwd}\n`, stderr: "" }
    if (args[0] === "rev-parse") return { stdout: `${cwd}/.git\n`, stderr: "" }
    if (args[0] === "status") return { stdout: this.dirty ? " M file.ts\n" : "", stderr: "" }
    if (args[0] === "worktree" && args[1] === "list") return { stdout: this.listed, stderr: "" }
    if (args[0] === "worktree" && args[1] === "add") {
      this.listed = [this.listed, `worktree ${args.at(-2)}`].filter(Boolean).join("\n")
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      const removed = String(args.at(-1))
      this.listed = this.listed.split(/\r?\n/).filter((line) => line !== `worktree ${removed}`).join("\n")
    }
    return { stdout: "", stderr: "" }
  }
}

Deno.test("typed worktree creation is idempotent and never invokes a shell string", async () => {
  const git = new FakeGit()
  const phases: WorktreePhase[] = []
  const service = new WorktreeService(git, [], (entries) => { if (entries[0]) phases.push(entries[0].phase) })
  const input = { directory: Deno.cwd(), path: `${Deno.cwd()}/../worktree-one`, branch: "workbench/one", baseRef: "HEAD", mutationID: "mutation" }
  const first = await service.create(input)
  const second = await service.create(input)
  assertEquals(first.id, second.id)
  assertEquals(git.calls.filter((call) => call.includes("add")).length, 1)
  assertEquals(git.calls.some((call) => call.join(" ").includes("-- worktree-one")), false)
  assertEquals(phases.slice(0, 3), ["requested", "creating", "ready"])
  await assertRejects(() => service.create({ ...input, branch: "workbench/different" }), Error, "different request")
})

Deno.test("worktree side effects wait for a durable creating journal checkpoint", async () => {
  const git = new FakeGit()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const persisted: WorktreePhase[] = []
  const service = new WorktreeService(git, [], async (entries) => {
    if (entries[0]) persisted.push(entries[0].phase)
    await gate
  })
  const creating = service.create({ directory: Deno.cwd(), path: `${Deno.cwd()}/../worktree-durable`, branch: "workbench/durable", baseRef: "HEAD", mutationID: "durable" })
  while (persisted.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
  assertEquals(persisted.slice(0, 2), ["requested", "creating"])
  assertEquals(git.calls.some((call) => call.includes("check-ref-format") || call.includes("add")), false)
  release()
  assertEquals((await creating).phase, "ready")
  await service.flush()
})

Deno.test("concurrent duplicate worktree creation shares one in-flight operation", async () => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const addStarted = new Promise<void>((resolve) => { started = resolve })
  class BlockingGit extends FakeGit {
    override async run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
      const result = await super.run(args, cwd)
      if (args[0] === "worktree" && args[1] === "add") {
        started()
        await gate
      }
      return result
    }
  }
  const git = new BlockingGit()
  const service = new WorktreeService(git)
  const input = { directory: Deno.cwd(), path: `${Deno.cwd()}/../worktree-concurrent`, branch: "workbench/concurrent", baseRef: "HEAD", mutationID: "concurrent" }
  const first = service.create(input)
  await addStarted
  const second = service.create(input)
  release()
  const [one, two] = await Promise.all([first, second])
  assertEquals(one.id, two.id)
  assertEquals(git.calls.filter((call) => call.includes("add")).length, 1)
})

Deno.test("dirty worktrees are retained and branch deletion remains separate", async () => {
  const git = new FakeGit()
  const service = new WorktreeService(git)
  const entry = await service.create({ directory: Deno.cwd(), path: `${Deno.cwd()}/../worktree-two`, branch: "workbench/two", baseRef: "HEAD", mutationID: "two" })
  git.dirty = true
  await assertRejects(() => service.remove(entry.id), Error, "Dirty worktree retained")
  assertEquals(service.journal()[0]?.phase, "retained-dirty")
  assertEquals(git.calls.some((call) => call.includes("branch")), false)
})

Deno.test("failed worktree cleanup reconciles an already missing Git registration", async () => {
  const git = new FakeGit()
  const service = new WorktreeService(git)
  const entry = await service.create({ directory: Deno.cwd(), path: `${Deno.cwd()}/../worktree-missing`, branch: "workbench/missing", baseRef: "HEAD", mutationID: "missing" })
  service.fail(entry.id, { code: "INTERNAL", message: "Prompt failed", retryable: true })
  git.listed = ""
  await service.remove(entry.id)
  assertEquals(service.get(entry.id)?.phase, "removed")
  assertEquals(git.calls.filter((call) => call.includes("status")).length, 0)
})

Deno.test("worktree recovery reconciles crashes after every journal phase", async () => {
  const git = new FakeGit()
  const phases: WorktreePhase[] = ["requested", "creating", "ready", "setup-running", "session-creating", "session-ready", "prompt-admitting", "prompt-admitted", "cleanup-pending"]
  const entries: WorktreeJournalEntry[] = phases.map((phase, index) => ({ id: String(index), mutationID: `mutation-${index}`, owner: "workbench", repository: Deno.cwd(), repositoryID: "repo", path: `${Deno.cwd()}/../recovery-${index}`, branch: `workbench/recovery-${index}`, baseRef: "HEAD", phase, createdAt: 1, updatedAt: 1 }))
  git.listed = [`worktree ${entries[0]!.path}`, `worktree ${entries[1]!.path}`, ...entries.slice(2, -1).map((entry) => `worktree ${entry.path}`)].join("\n")
  const service = new WorktreeService(git, entries)
  const recovered = await service.recover()
  assertEquals(recovered.find((entry) => entry.phase === "ready" && entry.id === "0")?.id, "0")
  assertEquals(recovered.find((entry) => entry.id === "1")?.phase, "ready")
  assertEquals(recovered.find((entry) => entry.id === String(entries.length - 1))?.phase, "removed")
  for (const phase of ["setup-running", "session-creating", "prompt-admitting"] as const) {
    const entry = recovered.find((candidate) => candidate.id === String(phases.indexOf(phase)))
    assertEquals(entry?.phase, "failed")
    assertEquals(entry?.error?.code, "OPERATION_CONFLICT")
    assertEquals(entry?.error?.retryable, true)
    assert(entry?.error?.message.includes(phase))
  }
  assertEquals(recovered.find((entry) => entry.id === String(phases.indexOf("ready")))?.phase, "ready")
  assertEquals(recovered.find((entry) => entry.id === String(phases.indexOf("session-ready")))?.phase, "session-ready")
  assertEquals(recovered.find((entry) => entry.id === String(phases.indexOf("prompt-admitted")))?.phase, "prompt-admitted")
  assertEquals(recovered.filter((entry) => entry.phase === "failed").length, 3)
})

Deno.test("worktree subscriptions are bounded, isolated, disposable, and sanitize journal errors", async () => {
  const git = new FakeGit()
  const observed: WorktreePhase[] = []
  const service = new WorktreeService(git)
  const subscription = service.subscribe((entries) => {
    const current = entries[0]
    if (!current) return
    observed.push(current.phase)
    current.phase = "removed"
    if (current.error) current.error.message = "listener mutation"
  })
  const throwing = service.subscribe(() => { throw new Error("listener failed") })
  const entry = await service.create({
    directory: Deno.cwd(), path: `${Deno.cwd()}/../worktree-subscription`, branch: "workbench/subscription", baseRef: "HEAD", mutationID: "subscription",
  })
  assertEquals(observed, ["requested", "creating", "ready"])
  assertEquals(service.get(entry.id)?.phase, "ready")

  service.fail(entry.id, {
    code: "INTERNAL",
    message: "Authorization: Bearer top-secret\nhttps://user:pass@example.test/path token=secondary-secret",
    retryable: true,
    details: { token: "embedded-secret" },
  })
  const failed = service.get(entry.id)
  assertEquals(failed?.phase, "failed")
  assertEquals(failed?.error?.retryable, true)
  assertEquals(failed?.error?.details, undefined)
  assert(!failed?.error?.message.includes("top-secret"))
  assert(!failed?.error?.message.includes("user:pass"))
  assert(!failed?.error?.message.includes("secondary-secret"))
  assert(!failed?.error?.message.includes("\n"))
  assert(!failed?.error?.message.includes("listener mutation"))

  subscription.dispose()
  throwing.dispose()
  const observedBeforeDispose = observed.length
  service.mark(entry.id, "ready")
  assertEquals(observed.length, observedBeforeDispose)

  const bounded = new WorktreeService(git)
  const listeners = Array.from({ length: 64 }, () => bounded.subscribe(() => undefined))
  assertThrows(() => bounded.subscribe(() => undefined), Error, "listener limit")
  for (const listener of listeners) listener.dispose()
  bounded.subscribe(() => undefined).dispose()
})

Deno.test("worktree journal prunes only the oldest terminal history and retains mutation idempotency", async () => {
  const git = new FakeGit()
  const repository = await new WorktreeService(git).repository(Deno.cwd())
  const entry = (id: string, phase: WorktreePhase, updatedAt: number): WorktreeJournalEntry => ({
    id,
    mutationID: `mutation-${id}`,
    owner: "workbench",
    repository: repository.root,
    repositoryID: repository.id,
    path: `${repository.root}/../bounded-${id}`,
    branch: `workbench/bounded-${id}`,
    baseRef: "HEAD",
    phase,
    createdAt: updatedAt,
    updatedAt,
  })
  const protectedEntries = [entry("ready", "ready", 0), entry("cleanup", "cleanup-pending", 0), entry("dirty", "retained-dirty", 0)]
  const terminalEntries = Array.from({ length: 1_000 }, (_, index) => entry(`terminal-${index}`, index % 2 ? "failed" : "removed", index + 1))
  let persisted: WorktreeJournalEntry[] = []
  const service = new WorktreeService(git, [...protectedEntries, ...terminalEntries], (entries) => { persisted = entries })

  assertEquals(service.journal().length, 1_000)
  assertEquals(persisted.length, 1_000)
  assertEquals(protectedEntries.every((candidate) => service.get(candidate.id)?.phase === candidate.phase), true)
  assertEquals(["terminal-0", "terminal-2", "terminal-4"].map((id) => service.get(id)), [undefined, undefined, undefined])
  assertEquals(service.get("terminal-1")?.phase, "failed")
  const retained = terminalEntries.at(-1)!
  await assertRejects(() => service.create({
    directory: repository.root,
    path: retained.path,
    branch: retained.branch,
    baseRef: retained.baseRef,
    mutationID: retained.mutationID,
  }), Error, `already ${retained.phase}`)
  assertEquals(git.calls.filter((call) => call.includes("add")).length, 0)
})

Deno.test("worktree journal rejects new creation when protected entries consume the hard bound", async () => {
  const git = new FakeGit()
  const repository = await new WorktreeService(git).repository(Deno.cwd())
  const entries: WorktreeJournalEntry[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `active-${index}`,
    mutationID: `active-mutation-${index}`,
    owner: "workbench",
    repository: repository.root,
    repositoryID: repository.id,
    path: `${repository.root}/../active-${index}`,
    branch: `workbench/active-${index}`,
    baseRef: "HEAD",
    phase: index === 997 ? "cleanup-pending" : index === 998 ? "retained-dirty" : index === 999 ? "prompt-admitted" : "ready",
    createdAt: index,
    updatedAt: index,
  }))
  assertThrows(() => new WorktreeService(git, [...entries, {
    ...entries[0]!,
    id: "protected-overflow",
    mutationID: "protected-overflow",
    path: `${repository.root}/../protected-overflow`,
    branch: "workbench/protected-overflow",
  }]), Error, "limit exceeded")
  const service = new WorktreeService(git, entries)
  const duplicate = await service.create({
    directory: repository.root,
    path: entries[0]!.path,
    branch: entries[0]!.branch,
    baseRef: entries[0]!.baseRef,
    mutationID: entries[0]!.mutationID,
  })
  assertEquals(duplicate.id, entries[0]!.id)
  let notifications = 0
  service.subscribe(() => notifications++)
  await assertRejects(() => service.create({
    directory: repository.root,
    path: `${repository.root}/../active-overflow`,
    branch: "workbench/active-overflow",
    baseRef: "HEAD",
    mutationID: "active-overflow",
  }), Error, "journal limit reached")
  assertEquals(service.journal().length, 1_000)
  assertEquals(entries.every((candidate) => service.get(candidate.id)?.phase === candidate.phase), true)
  assertEquals(notifications, 0)
  assertEquals(git.calls.filter((call) => call.includes("add")).length, 0)
})

Deno.test("worktree journal pruning remains visible as bounded subscription snapshots", async () => {
  const git = new FakeGit()
  const repository = await new WorktreeService(git).repository(Deno.cwd())
  const entries: WorktreeJournalEntry[] = Array.from({ length: 999 }, (_, index) => ({
    id: `protected-${index}`, mutationID: `protected-${index}`, owner: "workbench", repository: repository.root, repositoryID: repository.id,
    path: `${repository.root}/../protected-${index}`, branch: `workbench/protected-${index}`, baseRef: "HEAD", phase: "ready", createdAt: index, updatedAt: index,
  }))
  entries.push({
    id: "old-terminal", mutationID: "old-terminal", owner: "workbench", repository: repository.root, repositoryID: repository.id,
    path: `${repository.root}/../old-terminal`, branch: "workbench/old-terminal", baseRef: "HEAD", phase: "removed", createdAt: 0, updatedAt: 0,
  })
  const service = new WorktreeService(git, entries)
  const snapshots: WorktreeJournalEntry[][] = []
  service.subscribe((snapshot) => snapshots.push(snapshot))
  const created = await service.create({
    directory: repository.root,
    path: `${repository.root}/../bounded-new`,
    branch: "workbench/bounded-new",
    baseRef: "HEAD",
    mutationID: "bounded-new",
  })
  assertEquals(created.phase, "ready")
  assertEquals(snapshots.map((snapshot) => snapshot.length), [1_000, 1_000, 1_000])
  assertEquals(snapshots.every((snapshot) => !snapshot.some((candidate) => candidate.id === "old-terminal")), true)
  assertEquals(entries.slice(0, -1).every((candidate) => service.get(candidate.id)?.phase === "ready"), true)
})
