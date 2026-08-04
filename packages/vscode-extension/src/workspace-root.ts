export function resolveWorkspaceRoot(workspacePath: string | undefined, homeDirectory: string): string {
  return workspacePath ?? homeDirectory
}
