import { assertEquals } from "jsr:@std/assert"
import {
  applyPatchSection,
  partFileReference,
  patchFileMatches,
  patchFromPart,
  patchFromPermission,
  permissionFileReference,
} from "../src/application/patch-source.ts"

Deno.test("patch sources resolve exact transcript and permission diffs", () => {
  const envelope =
    "*** Begin Patch\n*** Update File: src/one.ts\n@@\n-old\n+new\n*** Update File: src/two.ts\n@@\n-before\n+after\n*** End Patch"
  assertEquals(patchFileMatches("/work/src/one.ts", "src/one.ts"), true)
  assertEquals(applyPatchSection(envelope, "/work/src/two.ts"), "@@\n-before\n+after")
  assertEquals(
    patchFromPart({
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "tool",
      tool: "apply_patch",
      state: { status: "failed", input: { patchText: envelope } },
    }, "src/one.ts"),
    "@@\n-old\n+new",
  )
  assertEquals(
    partFileReference({
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "tool",
      tool: "edit",
      state: { status: "completed", input: { filePath: "/outside/project/file.ts" } },
    }, "project/file.ts"),
    "/outside/project/file.ts",
  )
  assertEquals(
    patchFromPermission({
      id: "request",
      sessionID: "session",
      title: "Edit",
      type: "edit",
      protocol: "current",
      metadata: { input: { filepath: "/work/src/one.ts", diff: "@@\n-old\n+new" } },
    }, "src/one.ts"),
    "@@\n-old\n+new",
  )
  assertEquals(
    permissionFileReference({
      id: "request",
      sessionID: "session",
      title: "Edit",
      type: "edit",
      protocol: "current",
      metadata: { input: { filepath: "/outside/src/one.ts" } },
    }, "src/one.ts"),
    "/outside/src/one.ts",
  )
})

Deno.test("patch sources reject a mismatched permission file", () => {
  assertEquals(
    patchFromPermission({
      id: "request",
      sessionID: "session",
      title: "Edit",
      type: "edit",
      protocol: "current",
      metadata: { filepath: "src/one.ts", diff: "-old\n+new" },
    }, "src/two.ts"),
    undefined,
  )
})
