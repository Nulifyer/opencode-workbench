import type { MessagePart, PermissionRequest } from "@opencode-workbench/shared"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function patchFileMatches(left: string, right: string): boolean {
  const a = left.replaceAll("\\", "/")
  const b = right.replaceAll("\\", "/")
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export function applyPatchFiles(patch: string): string[] {
  return Array.from(patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm), (match) => match[1]!.trim()).slice(
    0,
    100,
  )
}

export function applyPatchSection(patch: string, file: string): string {
  const lines = patch.split("\n")
  const section: string[] = []
  let found = false
  let active = false
  for (const line of lines) {
    const marker = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/.exec(line)
    if (marker) {
      if (active) break
      active = patchFileMatches(marker[1]!.trim(), file)
      found ||= active
      continue
    }
    if (active && line === "*** End Patch") break
    if (active && line !== "*** Begin Patch") section.push(line)
  }
  return found ? section.join("\n").replace(/^\n|\n$/g, "") : patch
}

export function patchFromPart(part: MessagePart, file: string): string | undefined {
  const state = record(part.state)
  const input = record(state.input)
  const patch = [input.patchText, input.patch, input.diff, state.output]
    .find((value) =>
      typeof value === "string" &&
      (/^\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)/m.test(value) || /^@@/m.test(value))
    )
  return typeof patch === "string" ? applyPatchSection(patch, file) : undefined
}

export function partFileReferences(part: MessagePart): string[] {
  const state = record(part.state)
  const input = record(state.input)
  const metadata = record(state.metadata)
  const patch = [input.patchText, input.patch, input.diff, state.output].find((value) => typeof value === "string")
  const files = typeof patch === "string" ? applyPatchFiles(patch) : []
  if (Array.isArray(part.files)) files.push(...part.files.filter((file): file is string => typeof file === "string"))
  for (const candidate of [input.filePath, input.path, input.pattern, input.name, metadata.name]) {
    if (typeof candidate === "string" && candidate.trim()) files.push(candidate.trim())
  }
  return [...new Set(files)].slice(0, 100)
}

export function partFileReference(part: MessagePart, requested: string): string | undefined {
  return partFileReferences(part).find((candidate) => patchFileMatches(candidate, requested))
}

export function patchFromPermission(request: PermissionRequest, file: string): string | undefined {
  const metadata = record(request.metadata)
  const input = { ...metadata, ...record(metadata.input) }
  const patch = text(input.diff)
  if (!patch) return undefined
  const candidate = text(input.filePath) || text(input.filepath) || text(input.path) ||
    (typeof request.pattern === "string" ? request.pattern : request.pattern?.[0]) || ""
  return !candidate || patchFileMatches(candidate, file) ? applyPatchSection(patch, file) : undefined
}

export function permissionFileReference(request: PermissionRequest, requested: string): string | undefined {
  const metadata = record(request.metadata)
  const input = { ...metadata, ...record(metadata.input) }
  const candidates = [
    input.filePath,
    input.filepath,
    input.path,
    ...(typeof request.pattern === "string" ? [request.pattern] : request.pattern ?? []),
  ]
  return candidates.find((candidate): candidate is string =>
    typeof candidate === "string" && patchFileMatches(candidate, requested)
  )
}
