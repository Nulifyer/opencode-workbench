import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { realpath } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import type { StructuredError, WorktreeJournalEntry } from "@opencode-workbench/shared"

const execFileAsync = promisify(execFile)
const MAX_JOURNAL_ENTRIES = 1_000
const MAX_JOURNAL_LISTENERS = 64
const MAX_ERROR_MESSAGE_LENGTH = 2_000
// A failed entry may still own a real checkout and branch. Only an explicitly
// removed entry is safe to forget without orphaning user-manageable state.
const TERMINAL_JOURNAL_PHASES = new Set<WorktreeJournalEntry["phase"]>(["removed"])
const STRANDED_RECOVERY_PHASES = new Set<WorktreeJournalEntry["phase"]>(["setup-running", "session-creating", "prompt-admitting"])
const AUTHORIZATION_VALUE = /\b(authorization\s*:\s*)(?:(?:bearer|token|basic)\s+)?[^\s,'"`]+/gi
const COOKIE_VALUE = /\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi
const SECRET_VALUE = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|cookie|password|secret|token|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const URL_CREDENTIAL = /(https?:\/\/)[^/@\s]+@/gi

export interface GitResult { stdout: string; stderr: string }
export interface GitRunner { run(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> }

interface NormalizedCreateRequest {
  mutationID: string
  repository: string
  repositoryID: string
  path: string
  branch: string
  baseRef: string
}

export class TypedGitRunner implements GitRunner {
  async run(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
    if (!args.length || args.some((argument) => argument.includes("\0"))) throw new Error("Invalid Git argument")
    const result = await execFileAsync("git", args, { cwd, signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

function sanitizedMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "")
  return raw
    .replace(AUTHORIZATION_VALUE, "$1[redacted]")
    .replace(COOKIE_VALUE, "$1[redacted]")
    .replace(SECRET_VALUE, "$1[redacted]")
    .replace(URL_CREDENTIAL, "$1[redacted]@")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH) || "Worktree operation failed"
}

function sanitizeStructuredError(error: StructuredError): StructuredError {
  return { code: error.code, message: sanitizedMessage(error.message), retryable: error.retryable }
}

function structuredError(error: unknown): StructuredError {
  return { code: "INTERNAL", message: sanitizedMessage(error), retryable: false }
}

function cloneEntry(entry: WorktreeJournalEntry): WorktreeJournalEntry {
  return { ...entry, ...(entry.error ? { error: sanitizeStructuredError(entry.error) } : {}) }
}

function validBranch(value: string): boolean {
  return value.length > 0 && value.length <= 240 && !value.startsWith("-") && !/[\s~^:?*[\\\0]/.test(value) && !value.includes("..") && !value.endsWith("/") && !value.endsWith(".") && !value.includes("@{")
}

export class WorktreeService {
  private readonly entries = new Map<string, WorktreeJournalEntry>()
  private readonly pendingCreates = new Map<string, Promise<WorktreeJournalEntry>>()
  private readonly listeners = new Set<(entries: WorktreeJournalEntry[]) => void>()
  private recovery?: Promise<WorktreeJournalEntry[]>
  private persistenceTail: Promise<void> = Promise.resolve()
  private persistenceFailure: unknown

  constructor(private readonly git: GitRunner, initial: WorktreeJournalEntry[] = [], private readonly persist?: (entries: WorktreeJournalEntry[]) => void | PromiseLike<void>, private readonly clock: () => number = Date.now) {
    for (const entry of initial) if (entry.owner === "workbench") this.entries.set(entry.id, cloneEntry(entry))
    const pruned = this.pruneTerminalHistory()
    if (this.entries.size > MAX_JOURNAL_ENTRIES) throw new Error("Worktree journal limit exceeded by active, failed, or retained operations")
    if (pruned) this.publish()
  }

  journal(): WorktreeJournalEntry[] {
    return [...this.entries.values()].map(cloneEntry)
  }

  get(entryID: string): WorktreeJournalEntry | undefined {
    const entry = this.entries.get(entryID)
    return entry ? cloneEntry(entry) : undefined
  }

  findByMutation(mutationID: string): WorktreeJournalEntry | undefined {
    const entry = [...this.entries.values()].find((candidate) => candidate.mutationID === mutationID)
    return entry ? cloneEntry(entry) : undefined
  }

  async flush(): Promise<void> {
    await this.persistenceTail
    if (this.persistenceFailure !== undefined) {
      const failure = this.persistenceFailure
      this.persistenceFailure = undefined
      throw failure
    }
  }

  subscribe(listener: (entries: WorktreeJournalEntry[]) => void): { dispose(): void } {
    if (this.listeners.size >= MAX_JOURNAL_LISTENERS) throw new Error("Worktree journal listener limit reached")
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

  async repository(directory: string): Promise<{ root: string; id: string }> {
    const rootOutput = await this.git.run(["rev-parse", "--show-toplevel"], directory)
    const root = await realpath(rootOutput.stdout.trim())
    const commonOutput = await this.git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], root)
    const common = await realpath(commonOutput.stdout.trim())
    return { root, id: `git:${createHash("sha256").update(common).digest("hex")}` }
  }

  async create(input: { directory: string; path: string; branch: string; baseRef: string; mutationID: string }, signal?: AbortSignal): Promise<WorktreeJournalEntry> {
    if (!validBranch(input.branch) || !input.baseRef.trim() || input.baseRef.length > 1_024 || !input.mutationID || input.mutationID.length > 1_024) throw new Error("Invalid worktree request")
    const repository = await this.repository(input.directory)
    const target = path.resolve(input.path)
    if (target === repository.root || path.dirname(target) === target) throw new Error("Worktree path must not replace the repository root")
    const request: NormalizedCreateRequest = {
      mutationID: input.mutationID,
      repository: repository.root,
      repositoryID: repository.id,
      path: target,
      branch: input.branch,
      baseRef: input.baseRef,
    }
    const duplicate = this.findByMutation(input.mutationID)
    if (duplicate) {
      this.assertSameRequest(duplicate, request)
      const pending = this.pendingCreates.get(input.mutationID)
      if (pending) return { ...await pending }
      if (["requested", "creating"].includes(duplicate.phase)) {
        await this.recover()
        const recovered = this.findByMutation(input.mutationID)!
        if (recovered.phase === "ready") return recovered
        throw new Error(recovered.error?.message ?? "Interrupted worktree creation could not be recovered")
      }
      if (["failed", "cleanup-pending", "retained-dirty", "removed"].includes(duplicate.phase)) {
        throw new Error(duplicate.error?.message ?? `Worktree mutation is already ${duplicate.phase}`)
      }
      return duplicate
    }

    const pruned = this.pruneTerminalHistory(1)
    if (this.entries.size >= MAX_JOURNAL_ENTRIES) {
      if (pruned) this.publish()
      throw new Error("Worktree journal limit reached by active or retained operations; resolve or remove an existing worktree before creating another")
    }

    const operation = this.createOnce(request, signal)
    this.pendingCreates.set(input.mutationID, operation)
    try {
      return { ...await operation }
    } finally {
      if (this.pendingCreates.get(input.mutationID) === operation) this.pendingCreates.delete(input.mutationID)
    }
  }

  private async createOnce(request: NormalizedCreateRequest, signal?: AbortSignal): Promise<WorktreeJournalEntry> {
    const now = this.clock()
    const entry: WorktreeJournalEntry = {
      id: randomUUID(), mutationID: request.mutationID, owner: "workbench", repository: request.repository, repositoryID: request.repositoryID,
      path: request.path, branch: request.branch, baseRef: request.baseRef, phase: "requested", createdAt: now, updatedAt: now,
    }
    this.entries.set(entry.id, entry)
    this.commit(entry, "requested")
    this.commit(entry, "creating")
    try {
      await this.flush()
      await this.git.run(["check-ref-format", "--branch", request.branch], request.repository, signal)
      await mkdir(path.dirname(request.path), { recursive: true })
      await this.git.run(["worktree", "add", "--no-track", "-b", request.branch, "--", request.path, request.baseRef], request.repository, signal)
      this.commit(entry, "ready")
      await this.flush()
      return { ...entry }
    } catch (error) {
      this.commit(entry, "failed", structuredError(error))
      await this.flush()
      throw error
    }
  }

  mark(entryID: string, phase: WorktreeJournalEntry["phase"], values: Pick<WorktreeJournalEntry, "sessionID" | "promptID"> = {}): WorktreeJournalEntry {
    const entry = this.require(entryID)
    if (entry.owner !== "workbench" || entry.phase === "removed") throw new Error("Worktree operation is not mutable")
    Object.assign(entry, values)
    this.commit(entry, phase)
    return { ...entry }
  }

  async markDurably(entryID: string, phase: WorktreeJournalEntry["phase"], values: Pick<WorktreeJournalEntry, "sessionID" | "promptID"> = {}): Promise<WorktreeJournalEntry> {
    const entry = this.mark(entryID, phase, values)
    await this.flush()
    return entry
  }

  fail(entryID: string, error: StructuredError): WorktreeJournalEntry {
    const entry = this.require(entryID)
    if (entry.owner !== "workbench" || entry.phase === "removed") throw new Error("Worktree operation is not mutable")
    this.commit(entry, "failed", error)
    return { ...entry }
  }

  async failDurably(entryID: string, error: StructuredError): Promise<WorktreeJournalEntry> {
    const entry = this.fail(entryID, error)
    await this.flush()
    return entry
  }

  async recover(): Promise<WorktreeJournalEntry[]> {
    if (this.recovery) return await this.recovery
    const operation = this.recoverOnce().finally(() => {
      if (this.recovery === operation) this.recovery = undefined
    })
    this.recovery = operation
    return await operation
  }

  private async recoverOnce(): Promise<WorktreeJournalEntry[]> {
    if (this.pendingCreates.size) await Promise.allSettled([...this.pendingCreates.values()])
    const repositories = new Map<string, Set<string>>()
    for (const entry of this.entries.values()) {
      if (["removed", "retained-dirty"].includes(entry.phase)) continue
      let paths = repositories.get(entry.repository)
      if (!paths) {
        const output = await this.git.run(["worktree", "list", "--porcelain"], entry.repository)
        paths = new Set(output.stdout.split(/\r?\n/).flatMap((line) => line.startsWith("worktree ") ? [path.resolve(line.slice(9))] : []))
        repositories.set(entry.repository, paths)
      }
      if (!paths.has(path.resolve(entry.path)) && entry.phase === "cleanup-pending") this.commit(entry, "removed")
      else if (!paths.has(path.resolve(entry.path)) && entry.phase !== "failed") this.commit(entry, "failed", { code: "SESSION_NOT_FOUND", message: "Journaled worktree is missing from Git", retryable: false })
      else if (paths.has(path.resolve(entry.path)) && ["requested", "creating"].includes(entry.phase)) this.commit(entry, "ready")
      else if (paths.has(path.resolve(entry.path)) && STRANDED_RECOVERY_PHASES.has(entry.phase)) {
        this.commit(entry, "failed", {
          code: "OPERATION_CONFLICT",
          message: `Worktree operation was interrupted during ${entry.phase}; retry explicitly before continuing`,
          retryable: true,
        })
      }
    }
    await this.flush()
    return this.journal()
  }

  async remove(entryID: string, signal?: AbortSignal): Promise<void> {
    const entry = this.require(entryID)
    if (entry.owner !== "workbench") throw new Error("Workbench cannot remove a native-owned worktree")
    if (entry.phase === "removed") return
    const listed = await this.git.run(["worktree", "list", "--porcelain"], entry.repository, signal)
    const registered = new Set(listed.stdout.split(/\r?\n/).flatMap((line) => line.startsWith("worktree ") ? [path.resolve(line.slice(9))] : []))
    if (!registered.has(path.resolve(entry.path))) {
      this.commit(entry, "removed")
      await this.flush()
      return
    }
    const status = await this.git.run(["status", "--porcelain=v1", "--untracked-files=all"], entry.path, signal)
    if (status.stdout.trim()) {
      this.commit(entry, "retained-dirty")
      await this.flush()
      throw new Error("Dirty worktree retained; commit, stash, or discard changes explicitly before removal")
    }
    this.commit(entry, "cleanup-pending")
    await this.flush()
    await this.git.run(["worktree", "remove", "--", entry.path], entry.repository, signal)
    this.commit(entry, "removed")
    await this.flush()
  }

  async deleteBranch(entryID: string, signal?: AbortSignal): Promise<void> {
    const entry = this.require(entryID)
    if (entry.phase !== "removed") throw new Error("Remove the worktree before deleting its branch")
    await this.git.run(["branch", "--delete", "--", entry.branch], entry.repository, signal)
  }

  private require(id: string): WorktreeJournalEntry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error("Unknown worktree journal entry")
    return entry
  }

  private assertSameRequest(entry: WorktreeJournalEntry, request: NormalizedCreateRequest): void {
    if (entry.repository !== request.repository || entry.repositoryID !== request.repositoryID || path.resolve(entry.path) !== request.path ||
      entry.branch !== request.branch || entry.baseRef !== request.baseRef) {
      throw new Error(`Worktree mutation ${request.mutationID} was reused with a different request`)
    }
  }

  private pruneTerminalHistory(reservedEntries = 0): boolean {
    const excess = this.entries.size + reservedEntries - MAX_JOURNAL_ENTRIES
    if (excess <= 0) return false
    const terminal = [...this.entries.values()]
      .filter((entry) => TERMINAL_JOURNAL_PHASES.has(entry.phase))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    const removeCount = Math.min(excess, terminal.length)
    for (let index = 0; index < removeCount; index += 1) this.entries.delete(terminal[index]!.id)
    return removeCount > 0
  }

  private publish(): void {
    const snapshot = this.journal()
    if (this.persist) {
      try {
        const pending = Promise.resolve(this.persist(snapshot))
        this.persistenceTail = Promise.all([this.persistenceTail, pending]).then(
          () => undefined,
          (error) => { if (this.persistenceFailure === undefined) this.persistenceFailure = error },
        )
      } catch (error) {
        if (this.persistenceFailure === undefined) this.persistenceFailure = error
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(snapshot.map(cloneEntry))
      } catch {
        // Subscriber failures must not corrupt or interrupt journal transitions.
      }
    }
  }

  private commit(entry: WorktreeJournalEntry, phase: WorktreeJournalEntry["phase"], error?: StructuredError): void {
    entry.phase = phase
    entry.updatedAt = this.clock()
    if (error) entry.error = sanitizeStructuredError(error)
    else if (phase !== "failed") delete entry.error
    this.pruneTerminalHistory()
    this.publish()
  }
}
