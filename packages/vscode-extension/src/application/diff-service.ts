import { createHash, randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { lstat, open, readlink } from "node:fs/promises"
import type { DiffFileSummary, DiffScope, DiffSnapshot } from "@opencode-workbench/shared"
import type { GitResult, GitRunner } from "./worktree-service.js"

export interface DiffCapture {
  snapshot: DiffSnapshot
  unifiedDiff: string
}
export interface DiffBaseline {
  headRef: string
  clean: boolean
}

const MAXIMUM_NATIVE_DIFF_TEXT_BYTES = 8 * 1024 * 1024

function range(value: string): { start: number; end: number } {
  const [start, count = "1"] = value.split(",")
  const first = Number(start)
  const length = Number(count)
  return { start: first, end: length === 0 ? first - 1 : first + length - 1 }
}

function count(value: string): { value: number; binary: boolean } {
  if (value === "-") return { value: 0, binary: true }
  if (!/^\d+$/.test(value)) throw new Error("Git returned malformed NUL-delimited numstat metadata")
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error("Git returned an unsafe numstat count")
  return { value: parsed, binary: false }
}

/** Parse `git diff --numstat -z`, including its three-NUL rename/copy form. */
export function parseGitNumstatZ(value: string): DiffFileSummary[] {
  const summaries: DiffFileSummary[] = []
  let offset = 0
  while (offset < value.length) {
    const addedEnd = value.indexOf("\t", offset)
    const removedEnd = addedEnd < 0 ? -1 : value.indexOf("\t", addedEnd + 1)
    const pathEnd = removedEnd < 0 ? -1 : value.indexOf("\0", removedEnd + 1)
    if (addedEnd < 0 || removedEnd < 0 || pathEnd < 0) {
      throw new Error("Git returned unterminated NUL-delimited numstat metadata")
    }
    const added = count(value.slice(offset, addedEnd))
    const removed = count(value.slice(addedEnd + 1, removedEnd))
    let file = value.slice(removedEnd + 1, pathEnd)
    let previousPath: string | undefined
    offset = pathEnd + 1
    if (!file) {
      const previousEnd = value.indexOf("\0", offset)
      const currentEnd = previousEnd < 0 ? -1 : value.indexOf("\0", previousEnd + 1)
      if (previousEnd < 0 || currentEnd < 0) throw new Error("Git returned an unterminated rename in numstat metadata")
      previousPath = value.slice(offset, previousEnd)
      file = value.slice(previousEnd + 1, currentEnd)
      offset = currentEnd + 1
    }
    if (!file || previousPath === "") throw new Error("Git returned an empty path in numstat metadata")
    summaries.push({
      path: file,
      ...(previousPath === undefined ? {} : { previousPath }),
      additions: added.value,
      deletions: removed.value,
      binary: added.binary || removed.binary,
      hunks: [],
    })
  }
  return summaries
}

function patchSections(unifiedDiff: string): string[] {
  const sections: string[] = []
  let current: string[] | undefined
  for (const line of unifiedDiff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(current.join("\n"))
      current = [line]
    } else if (current) current.push(line)
  }
  if (current) sections.push(current.join("\n"))
  return sections
}

function files(
  unifiedDiff: string,
  summaries: DiffFileSummary[],
): { files: DiffFileSummary[]; complete: boolean; truncationReason?: string } {
  const result: DiffFileSummary[] = summaries.map((summary) => ({ ...summary, hunks: [] }))
  const sections = patchSections(unifiedDiff)
  const uniquePaths = new Set(result.map((summary) => summary.path))
  if (sections.length !== result.length || uniquePaths.size !== result.length) {
    return {
      files: result,
      complete: false,
      truncationReason: "Git diff content could not be reconciled with its NUL-delimited file metadata",
    }
  }
  for (let index = 0; index < sections.length; index++) {
    for (const line of sections[index]!.split("\n")) {
      const hunk = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/.exec(line)
      if (hunk) {
        result[index]!.hunks!.push({
          header: line.slice(0, 1_024),
          oldRange: range(hunk[1]!),
          newRange: range(hunk[2]!),
        })
      }
    }
  }
  return { files: result, complete: true }
}

export function diffFileChangeKind(capture: DiffCapture, filePath: string): "added" | "deleted" | "changed" {
  const index = capture.snapshot.files.findIndex((file) => file.path === filePath)
  if (index < 0) throw new Error("Diff file metadata is unavailable")
  const section = patchSections(capture.unifiedDiff)[index]
  if (!section) throw new Error("Diff file content is unavailable")
  if (/^new file mode /m.test(section) || /^--- \/dev\/null$/m.test(section)) return "added"
  if (/^deleted file mode /m.test(section) || /^\+\+\+ \/dev\/null$/m.test(section)) return "deleted"
  return "changed"
}

function includeUntracked(scope: DiffScope, headRef?: string): boolean {
  return !headRef && ["turn", "session", "unstaged", "branch"].includes(scope)
}

function gitFailure(value: unknown): { code?: unknown; stdout?: unknown; stderr?: unknown } {
  return typeof value === "object" && value !== null ? value : {}
}

async function allowNoIndexDifference(git: GitRunner, args: string[], repository: string): Promise<GitResult> {
  try {
    return await git.run(args, repository)
  } catch (error) {
    const failure = gitFailure(error)
    if (failure.code === 1 && typeof failure.stdout === "string") {
      return { stdout: failure.stdout, stderr: typeof failure.stderr === "string" ? failure.stderr : "" }
    }
    throw error
  }
}

function appendDiff(target: string, addition: string): string {
  if (!addition) return target
  if (!target) return addition
  return `${target}${target.endsWith("\n") ? "" : "\n"}${addition}`
}

async function captureUntracked(
  git: GitRunner,
  repository: string,
  names: string[],
  maximumBytes: number,
  maximumFiles = 1_000,
): Promise<{ unifiedDiff: string; files: DiffFileSummary[]; complete: boolean; truncationReason?: string }> {
  let unifiedDiff = ""
  const summaries: DiffFileSummary[] = []
  const candidates = names.slice(0, maximumFiles)
  if (maximumBytes <= 0 && candidates.length) {
    return {
      unifiedDiff,
      files: summaries,
      complete: false,
      truncationReason: "Untracked diff exceeds the complete diff byte limit",
    }
  }
  for (const file of candidates) {
    const [diff, stats] = await Promise.all([
      allowNoIndexDifference(
        git,
        ["diff", "--no-index", "--binary", "--full-index", "--", "/dev/null", file],
        repository,
      ),
      allowNoIndexDifference(git, ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", file], repository),
    ])
    const nextDiff = appendDiff(unifiedDiff, diff.stdout)
    if (Buffer.byteLength(nextDiff) > maximumBytes) {
      return {
        unifiedDiff,
        files: summaries,
        complete: false,
        truncationReason: "Untracked diff exceeds the complete diff byte limit",
      }
    }
    const parsed = parseGitNumstatZ(stats.stdout)
    if (parsed.length !== 1) throw new Error("Git returned unexpected numstat metadata for an untracked file")
    summaries.push({
      path: file,
      additions: parsed[0]!.additions,
      deletions: parsed[0]!.deletions,
      binary: parsed[0]!.binary,
      hunks: [],
    })
    unifiedDiff = nextDiff
  }
  if (names.length > candidates.length) {
    return {
      unifiedDiff,
      files: summaries,
      complete: false,
      truncationReason: `Untracked file count exceeds the ${maximumFiles}-file complete diff limit`,
    }
  }
  return { unifiedDiff, files: summaries, complete: true }
}

export class DiffService {
  constructor(private readonly git: GitRunner, private readonly completeLimit = 4_000_000) {}

  async captureTurnBaseline(repository: string): Promise<DiffBaseline> {
    const result = await this.git.run(["rev-parse", "--verify", "HEAD^{commit}"], repository)
    const headRef = result.stdout.trim()
    if (!/^[0-9a-f]{40,64}$/i.test(headRef)) {
      throw new Error("Git did not return a valid commit identity for the turn baseline")
    }
    const capture = await this.capture({ repository, scope: "session", baseRef: headRef })
    return {
      headRef,
      clean: capture.snapshot.complete && capture.snapshot.files.length === 0 && capture.unifiedDiff.length === 0,
    }
  }

  async readRevisionText(
    repository: string,
    revision: string,
    gitPath: string,
    maximumBytes = MAXIMUM_NATIVE_DIFF_TEXT_BYTES,
  ): Promise<string> {
    this.validateReadLimit(maximumBytes)
    const result = await this.git.run(["show", `${revision}:${gitPath}`], repository)
    this.assertText(result.stdout, maximumBytes)
    return result.stdout
  }

  async readWorkingTreeText(filePath: string, maximumBytes = MAXIMUM_NATIVE_DIFF_TEXT_BYTES): Promise<string> {
    this.validateReadLimit(maximumBytes)
    const initial = await lstat(filePath)
    if (initial.isSymbolicLink()) {
      const target = await readlink(filePath)
      this.assertText(target, maximumBytes)
      return target
    }
    if (!initial.isFile()) throw new Error("Diff path is not a regular file")
    if (initial.size > maximumBytes) throw new Error(`Diff text exceeds ${maximumBytes} bytes`)
    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const current = await handle.stat()
      if (!current.isFile()) throw new Error("Diff path is not a regular file")
      const content = Buffer.alloc(maximumBytes + 1)
      let length = 0
      while (length < content.length) {
        const { bytesRead } = await handle.read(content, length, content.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > maximumBytes) throw new Error(`Diff text exceeds ${maximumBytes} bytes`)
      const text = content.subarray(0, length).toString("utf8")
      this.assertText(text, maximumBytes)
      return text
    } finally {
      await handle.close()
    }
  }

  private validateReadLimit(maximumBytes: number): void {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAXIMUM_NATIVE_DIFF_TEXT_BYTES) {
      throw new Error("Invalid native diff text byte limit")
    }
  }

  private assertText(value: string, maximumBytes: number): void {
    if (Buffer.byteLength(value) > maximumBytes) throw new Error(`Diff text exceeds ${maximumBytes} bytes`)
    if (value.includes("\0")) throw new Error("Binary files are not available in the text diff editor")
  }

  async capture(
    input: { repository: string; scope: DiffScope; baseRef?: string; headRef?: string; baselineClean?: boolean },
  ): Promise<DiffCapture> {
    const rangeArgs = input.scope === "staged"
      ? ["--cached"]
      : input.scope === "unstaged"
      ? []
      : input.baseRef && input.headRef
      ? [`${input.baseRef}..${input.headRef}`]
      : input.baseRef
      ? [input.baseRef]
      : []
    const common = ["--find-renames", "--no-ext-diff", ...rangeArgs, "--"]
    const [diff, stats, untrackedNames] = await Promise.all([
      this.git.run(["diff", "--binary", "--full-index", ...common], input.repository),
      this.git.run(["diff", "--numstat", "-z", ...common], input.repository),
      includeUntracked(input.scope, input.headRef)
        ? this.git.run(["ls-files", "--others", "--exclude-standard", "-z", "--"], input.repository).then((result) =>
          result.stdout.split("\0").filter(Boolean)
        )
        : Promise.resolve([]),
    ])
    const trackedBytes = Buffer.byteLength(diff.stdout)
    const untracked = await captureUntracked(
      this.git,
      input.repository,
      untrackedNames,
      Math.max(0, this.completeLimit - trackedBytes),
    )
    const unifiedDiff = appendDiff(diff.stdout, untracked.unifiedDiff)
    const bytes = Buffer.byteLength(unifiedDiff)
    const baselineIncomplete = input.scope === "turn" && input.baselineClean === false
    const reconciled = files(unifiedDiff, [...parseGitNumstatZ(stats.stdout), ...untracked.files])
    const complete = bytes <= this.completeLimit && untracked.complete && !baselineIncomplete && reconciled.complete
    const hash = `sha256:${createHash("sha256").update(unifiedDiff).digest("hex")}`
    return {
      unifiedDiff,
      snapshot: {
        id: randomUUID(),
        scope: input.scope,
        repository: input.repository,
        baseRef: input.baseRef,
        headRef: input.headRef,
        unifiedDiffHash: hash,
        files: reconciled.files,
        generatedAt: Date.now(),
        complete,
        truncationReason: baselineIncomplete
          ? "Turn did not begin from a verified clean baseline; its changes cannot be attributed exactly"
          : trackedBytes > this.completeLimit
          ? `Unified diff exceeds ${this.completeLimit} bytes`
          : untracked.truncationReason ?? reconciled.truncationReason,
      },
    }
  }
}
