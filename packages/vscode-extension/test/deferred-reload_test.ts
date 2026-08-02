import type { WorkbenchState } from "@opencode-workbench/shared"
import { DeferredOpenCodeReload } from "../src/deferred-reload.ts"
import type { ControllerUpdate } from "../src/session-controller.ts"

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => resolve = next)
  return { promise, resolve }
}

Deno.test("deferred reload waits for terminal session event and deduplicates requests", async () => {
  const listeners = new Set<(update: ControllerUpdate) => void>()
  const pauses: boolean[] = []
  const snapshot = {
    connected: true,
    selectedID: "one",
    order: ["one"],
    sessions: { one: { info: { id: "one" }, status: { type: "busy" }, queue: [] } },
  } as unknown as WorkbenchState
  const controller = {
    snapshot,
    subscribe(listener: (update: ControllerUpdate) => void) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    setPromptAdmissionPaused(paused: boolean) {
      pauses.push(paused)
    },
  }
  const release = deferred<void>()
  const started = deferred<void>()
  let completed = 0
  const coordinator = new DeferredOpenCodeReload(controller, {
    reload: async () => {
      started.resolve(undefined)
      await release.promise
    },
    completed: () => completed += 1,
  })
  try {
    const request = { sessionID: "one", reason: "skill-activation" as const }
    const first = coordinator.request(request)
    const duplicate = coordinator.request(request)
    if (first.when !== "session-idle" || !duplicate.deduplicated || pauses.join(",") !== "true") {
      throw new Error("Reload request was not paused and deduplicated")
    }
    let conflicting = false
    try {
      coordinator.request({ sessionID: "one", reason: "configuration-change" })
    } catch {
      conflicting = true
    }
    if (!conflicting) throw new Error("Conflicting reload request was accepted")
    for (const listener of listeners) listener({ type: "event", event: { type: "session.status", properties: { sessionID: "one", status: { type: "idle" } } } })
    await started.promise
    if (pauses.join(",") !== "true") throw new Error("Prompt admission resumed before reload completed")
    release.resolve(undefined)
    await release.promise
    await Promise.resolve()
    if (completed !== 1 || pauses.join(",") !== "true,false") throw new Error("Reload completion did not resume prompt admission exactly once")
  } finally {
    coordinator.dispose()
  }
})

Deno.test("deferred reload rejects unknown sessions", () => {
  const controller = {
    snapshot: { sessions: {} } as unknown as WorkbenchState,
    subscribe: () => ({ dispose: () => undefined }),
    setPromptAdmissionPaused: () => undefined,
  }
  const coordinator = new DeferredOpenCodeReload(controller, { reload: async () => undefined })
  try {
    let rejected = false
    try {
      coordinator.request({ sessionID: "missing", reason: "skill-activation" })
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error("Unknown reload session was accepted")
  } finally {
    coordinator.dispose()
  }
})

Deno.test("delegated reload waits for root session to become idle", async () => {
  const listeners = new Set<(update: ControllerUpdate) => void>()
  const started = deferred<void>()
  const controller = {
    snapshot: {
      sessions: {
        root: { info: { id: "root" }, status: { type: "busy" }, queue: [] },
        child: { info: { id: "child", parentID: "root" }, status: { type: "busy" }, queue: [] },
      },
    } as unknown as WorkbenchState,
    subscribe(listener: (update: ControllerUpdate) => void) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    setPromptAdmissionPaused: () => undefined,
  }
  const coordinator = new DeferredOpenCodeReload(controller, { reload: async () => started.resolve(undefined) })
  try {
    coordinator.request({ sessionID: "child", reason: "skill-activation" })
    for (const listener of listeners) listener({ type: "event", event: { type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } } })
    let began = false
    void started.promise.then(() => began = true)
    await Promise.resolve()
    if (began) throw new Error("Child session idle triggered reload before root completed")
    for (const listener of listeners) listener({ type: "event", event: { type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } } })
    await started.promise
  } finally {
    coordinator.dispose()
  }
})
