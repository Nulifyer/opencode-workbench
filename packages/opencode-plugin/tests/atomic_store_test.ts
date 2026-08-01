import { AtomicJsonStore, type AtomicAdapter } from "../src/atomic-store.ts"
import { equal, rejects } from "./assert.ts"

class FakeAdapter implements AtomicAdapter {
  files = new Map<string, string>()
  operations: string[] = []
  locked = false
  failRename = false

  async read(path: string) { return this.files.get(path) }
  async writeExclusive(path: string, contents: string) {
    this.operations.push(`write:${path}`)
    if (this.files.has(path)) throw new Error("exists")
    this.files.set(path, contents)
  }
  async rename(from: string, to: string) {
    this.operations.push(`rename:${from}:${to}`)
    if (this.failRename) throw new Error("rename failed")
    this.files.set(to, this.files.get(from)!)
    this.files.delete(from)
  }
  async remove(path: string) { this.operations.push(`remove:${path}`); this.files.delete(path) }
  async acquireLock() {
    if (this.locked) throw new Error("concurrent lock")
    this.locked = true
    return async () => { this.locked = false }
  }
}

Deno.test("atomic store serializes mutations and renames temporary state", async () => {
  const adapter = new FakeAdapter()
  let nextID = 0
  const store = new AtomicJsonStore("state.json", adapter, () => ({ count: 0 }), (value) => value as { count: number }, () => String(++nextID))
  await Promise.all([
    store.mutate(async (state) => { await Promise.resolve(); state.count += 1 }),
    store.mutate((state) => { state.count += 1 }),
  ])
  equal(await store.read(), { count: 2 })
  equal(adapter.operations, [
    "write:state.json.tmp-1", "rename:state.json.tmp-1:state.json",
    "write:state.json.tmp-2", "rename:state.json.tmp-2:state.json",
  ])
})

Deno.test("atomic store preserves old state when rename fails and releases lock", async () => {
  const adapter = new FakeAdapter()
  adapter.files.set("state.json", "{\"count\":1}\n")
  adapter.failRename = true
  const store = new AtomicJsonStore("state.json", adapter, () => ({ count: 0 }), (value) => value as { count: number }, () => "failed")
  await rejects(() => store.mutate((state) => { state.count = 2 }), /rename failed/)
  equal(JSON.parse(adapter.files.get("state.json")!), { count: 1 })
  equal(adapter.locked, false)
  equal(adapter.files.has("state.json.tmp-failed"), false)
})
