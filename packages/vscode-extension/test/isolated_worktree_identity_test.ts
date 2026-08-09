import { assertEquals, assertNotEquals } from "jsr:@std/assert"
import { createIsolatedWorktreeIdentity } from "../src/application/isolated-worktree-identity.ts"

Deno.test("concurrent isolated worktree identities remain unique within the same millisecond", () => {
  const first = createIsolatedWorktreeIdentity("Same task", 1_000, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
  const second = createIsolatedWorktreeIdentity("Same task", 1_000, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
  assertNotEquals(first.name, second.name)
  assertNotEquals(first.branch, second.branch)
  assertEquals(first.name.startsWith("same-task-rs-"), true)
})
