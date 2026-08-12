export interface PatchTextPair {
  original: string
  modified: string
}

interface TextLines {
  lines: string[]
  newline: string
  finalNewline: boolean
}

interface PatchHunk {
  oldStart?: number
  newStart?: number
  oldLines: string[]
  newLines: string[]
}

function splitText(value: string): TextLines {
  const newline = value.includes("\r\n") ? "\r\n" : "\n"
  const normalized = value.replaceAll("\r\n", "\n")
  const finalNewline = normalized.endsWith("\n")
  const lines = normalized.split("\n")
  if (finalNewline) lines.pop()
  return { lines, newline, finalNewline }
}

function joinText(value: TextLines): string {
  return value.lines.join(value.newline) + (value.finalNewline ? value.newline : "")
}

function patchHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = []
  let current: PatchHunk | undefined
  const begin = (oldStart?: number, newStart?: number): PatchHunk => {
    const hunk = { oldStart, newStart, oldLines: [], newLines: [] }
    hunks.push(hunk)
    return hunk
  }
  for (const line of patch.replaceAll("\r\n", "\n").split("\n")) {
    const marker = /^@@(?:\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?)?/.exec(line)
    if (marker) {
      current = begin(marker[1] ? Number(marker[1]) : undefined, marker[2] ? Number(marker[2]) : undefined)
      continue
    }
    if (
      /^(?:diff --git|index |--- |\+\+\+ |\*\*\* (?:Begin Patch|End Patch|Update File:|Add File:|Delete File:))/.test(
        line,
      ) || line === "\\ No newline at end of file"
    ) continue
    if (!/^[ +\-]/.test(line)) continue
    current ??= begin()
    if (line.startsWith(" ")) {
      current.oldLines.push(line.slice(1))
      current.newLines.push(line.slice(1))
    } else if (line.startsWith("-")) current.oldLines.push(line.slice(1))
    else if (line.startsWith("+")) current.newLines.push(line.slice(1))
  }
  return hunks.filter((hunk) => hunk.oldLines.length || hunk.newLines.length)
}

function matchesAt(lines: readonly string[], candidate: readonly string[], index: number): boolean {
  return index >= 0 && index + candidate.length <= lines.length &&
    candidate.every((line, offset) => lines[index + offset] === line)
}

function locate(lines: readonly string[], candidate: readonly string[], expected: number): number {
  if (!candidate.length) return Math.max(0, Math.min(lines.length, expected))
  if (matchesAt(lines, candidate, expected)) return expected
  const matches: number[] = []
  for (let index = 0; index <= lines.length - candidate.length; index += 1) {
    if (matchesAt(lines, candidate, index)) matches.push(index)
  }
  if (!matches.length) throw new Error("The patch no longer matches the current file")
  return matches.sort((left, right) => Math.abs(left - expected) - Math.abs(right - expected) || left - right)[0]!
}

function transform(current: string, patch: string, direction: "forward" | "reverse"): string {
  const text = splitText(current)
  const hunks = patchHunks(patch)
  if (!hunks.length) throw new Error("The patch does not contain any text changes")
  let offset = 0
  for (const hunk of hunks) {
    const source = direction === "forward" ? hunk.oldLines : hunk.newLines
    const target = direction === "forward" ? hunk.newLines : hunk.oldLines
    const start = direction === "forward" ? hunk.oldStart : hunk.newStart
    const expected = start === undefined
      ? Math.max(0, text.lines.length - source.length)
      : Math.max(0, start - 1 + offset)
    const index = locate(text.lines, source, expected)
    text.lines.splice(index, source.length, ...target)
    offset += target.length - source.length
  }
  return joinText(text)
}

/** Reconstructs both sides required by VS Code's native diff editor. */
export function patchTextPair(current: string, patch: string, patchAlreadyApplied: boolean): PatchTextPair {
  return patchAlreadyApplied
    ? { original: transform(current, patch, "reverse"), modified: current }
    : { original: current, modified: transform(current, patch, "forward") }
}
