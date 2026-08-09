import { promises as fs } from "node:fs"
import path from "node:path"

export function pathIsContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export async function bridgeContextIsContained(
  workspaceRealPath: string,
  context: { worktree: string; directory: string },
): Promise<boolean> {
  const worktree = await fs.realpath(context.worktree).catch(() => undefined)
  const directory = await fs.realpath(context.directory).catch(() => undefined)
  return worktree === workspaceRealPath && Boolean(directory && pathIsContained(workspaceRealPath, directory))
}
