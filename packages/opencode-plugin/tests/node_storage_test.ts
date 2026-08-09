import { join } from "node:path"
import { NodeAtomicAdapter } from "../src/node-storage.ts"
import { assert, rejects } from "./assert.ts"

Deno.test("node storage refuses state larger than its readable limit", async () => {
  const directory = await Deno.makeTempDir({ prefix: "opencode-workbench-test-" })
  try {
    const adapter = new NodeAtomicAdapter()
    await rejects(
      () => adapter.writeExclusive(join(directory, "state.json"), "x".repeat(2 * 1024 * 1024 + 1)),
      /size limit/,
    )
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test("node storage immediately takes over a young lock whose owner is dead", async () => {
  const directory = await Deno.makeTempDir({ prefix: "opencode-workbench-dead-lock-" })
  const lockPath = join(directory, "state.json.lock")
  try {
    await Deno.mkdir(lockPath)
    await Deno.writeTextFile(join(lockPath, "owner"), "2147483647:dead-owner")
    const started = Date.now()
    const release = await new NodeAtomicAdapter().acquireLock(lockPath)
    assert(Date.now() - started < 1_000, "dead-owner takeover waited for the stale-lock timeout")
    await release()
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test("node storage recovers an ownerless crash after the owner-write grace period", async () => {
  const directory = await Deno.makeTempDir({ prefix: "opencode-workbench-empty-lock-" })
  const lockPath = join(directory, "state.json.lock")
  try {
    await Deno.mkdir(lockPath)
    const started = Date.now()
    const release = await new NodeAtomicAdapter().acquireLock(lockPath)
    const elapsed = Date.now() - started
    assert(elapsed >= 200 && elapsed < 2_000, `ownerless lock recovery used an unexpected grace period: ${elapsed}ms`)
    await release()
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})
