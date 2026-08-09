import { assertEquals } from "jsr:@std/assert"
import { processLockCanBeReclaimed } from "../src/application/process-lock.ts"

Deno.test("process locks reclaim confirmed dead owners immediately but preserve live or fresh ambiguous owners", () => {
  const now = 20_000
  assertEquals(processLockCanBeReclaimed("42:owner", now - 1, now, 10_000, () => false), true)
  assertEquals(processLockCanBeReclaimed("42:owner", 0, now, 10_000, () => true), false)
  assertEquals(processLockCanBeReclaimed("", now - 1, now, 10_000, () => false), false)
  assertEquals(processLockCanBeReclaimed("", now - 500, now, 10_000, () => false), true)
  assertEquals(processLockCanBeReclaimed("invalid", 0, now, 10_000, () => false), true)
})
