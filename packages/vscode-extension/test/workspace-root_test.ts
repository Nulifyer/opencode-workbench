import { resolveWorkspaceRoot } from "../src/workspace-root.ts"

Deno.test("folderless sessions use the user home directory", () => {
  if (resolveWorkspaceRoot(undefined, "/home/user") !== "/home/user") throw new Error("Folderless session did not use the home directory")
  if (resolveWorkspaceRoot("/work/project", "/home/user") !== "/work/project") throw new Error("Workspace folder did not take precedence")
})
