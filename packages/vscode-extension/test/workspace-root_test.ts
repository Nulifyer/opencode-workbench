import { resolveWorkspaceRoot } from "../src/workspace-root.ts"

Deno.test("folderless windows do not authorize the user home directory", () => {
  if (resolveWorkspaceRoot(undefined) !== undefined) throw new Error("Folderless window authorized an implicit root")
  if (resolveWorkspaceRoot("/work/project") !== "/work/project") throw new Error("Workspace folder was not retained")
})
