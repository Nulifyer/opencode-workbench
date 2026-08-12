import { createSessionLifecycle, type SettlementReason, type WorkbenchState } from "@opencode-workbench/shared"
import { DeferredOpenCodeReload } from "../src/deferred-reload.ts"

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => resolve = next)
  return { promise, resolve }
}

Deno.test("deferred reload waits for lifecycle settlement and deduplicates requests", async () => {
  const pauses: boolean[] = []
  const snapshot = {
    connected: true,
    connectionState: "connected",
    selectedID: "one",
    order: ["one"],
    sessions: { one: { info: { id: "one" }, status: { type: "busy" }, queue: [] } },
  } as unknown as WorkbenchState
  const controller = {
    snapshot,
    waitForSettlement: () => idle.promise,
    setPromptAdmissionPaused(paused: boolean) {
      pauses.push(paused)
    },
  }
  const release = deferred<void>()
  const started = deferred<void>()
  const idle = deferred<ReturnType<typeof createSessionLifecycle>>()
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
    idle.resolve(createSessionLifecycle({ epoch: "one", generation: 0 }))
    await started.promise
    if (pauses.join(",") !== "true") throw new Error("Prompt admission resumed before reload completed")
    release.resolve(undefined)
    await release.promise
    await Promise.resolve()
    if (completed !== 1 || pauses.join(",") !== "true,false") {
      throw new Error("Reload completion did not resume prompt admission exactly once")
    }
  } finally {
    coordinator.dispose()
  }
})

Deno.test("deferred reload rejects unknown sessions", () => {
  const controller = {
    snapshot: { sessions: {} } as unknown as WorkbenchState,
    waitForSettlement: async () => createSessionLifecycle({ epoch: "missing", generation: 0 }),
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

Deno.test("delegated reload waits for root session to settle", async () => {
  const started = deferred<void>()
  const rootSettled = deferred<ReturnType<typeof createSessionLifecycle>>()
  let waitedFor = ""
  let ignored: readonly SettlementReason[] = []
  const controller = {
    snapshot: {
      sessions: {
        root: { info: { id: "root" }, status: { type: "busy" }, queue: [] },
        child: { info: { id: "child", parentID: "root" }, status: { type: "busy" }, queue: [] },
      },
    } as unknown as WorkbenchState,
    waitForSettlement(sessionID: string, _signal?: AbortSignal, ignoredReasons?: readonly SettlementReason[]) {
      waitedFor = sessionID
      ignored = ignoredReasons ?? []
      return rootSettled.promise
    },
    setPromptAdmissionPaused: () => undefined,
  }
  const coordinator = new DeferredOpenCodeReload(controller, { reload: async () => started.resolve(undefined) })
  try {
    coordinator.request({ sessionID: "child", reason: "skill-activation" })
    let began = false
    void started.promise.then(() => began = true)
    await Promise.resolve()
    if (began) throw new Error("Child session idle triggered reload before root completed")
    if (waitedFor !== "root" || ignored.join(",") !== "QUEUED_PROMPT") {
      throw new Error("Reload did not use the root lifecycle barrier with its explicit queue policy")
    }
    rootSettled.resolve(createSessionLifecycle({ epoch: "root", generation: 0 }))
    await started.promise
  } finally {
    coordinator.dispose()
  }
})
