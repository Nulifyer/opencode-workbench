import { join } from "node:path"
import { NodeAtomicAdapter } from "../src/node-storage.ts"
import { rejects } from "./assert.ts"

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
