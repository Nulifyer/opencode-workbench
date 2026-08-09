import type { DiffAnchor, DiffSnapshot } from "@opencode-workbench/shared"

export interface DiffNavigationPaths {
  basePath: string
  modifiedPath: string
  focusPath: string
}

export function diffNavigationPaths(snapshot: DiffSnapshot, anchor: DiffAnchor): DiffNavigationPaths {
  const file = snapshot.files.find((candidate) => candidate.path === anchor.file)
  if (!file) throw new Error(`Diff anchor references an unknown file: ${anchor.file}`)
  const basePath = file.previousPath ?? file.path
  const modifiedPath = file.path
  return { basePath, modifiedPath, focusPath: anchor.side === "base" ? basePath : modifiedPath }
}
