import { assertEquals, assertThrows } from "jsr:@std/assert"
import { parseHostMessage } from "@opencode-workbench/shared"
import { HealthService, workbenchHealthSummary } from "../src/application/health-service.ts"
import { controllerTraceCategory, TraceService } from "../src/application/trace-service.ts"

Deno.test("health center reports bounded current runtime state", () => {
  const service = new HealthService(() => ({
    workbenchVersion: "1", vscodeVersion: "2", experienceMode: "workbench", transportMode: "http-sse", serverMode: "managed", serverState: "connected", pluginState: "available",
    capabilities: ["questions", "permissions", "questions"], eventStreamState: "connected", requestQueueDepth: 2, protocol: { version: 2, epoch: "epoch" }, authorizedRoots: ["/repo"],
  }))
  service.eventObserved(10)
  service.reconciled(11)
  service.reconnected()
  const snapshot = service.snapshot()
  assertEquals(snapshot.capabilities, ["permissions", "questions"])
  assertEquals(snapshot.eventStream, { state: "connected", lastEventAt: 10, lastReconciliationAt: 11, reconnectCount: 1 })
  const summary = workbenchHealthSummary(snapshot)
  assertEquals(Object.keys(summary), [
    "workbenchVersion", "vscodeVersion", "openCodeVersion", "serverMode", "serverState", "pluginState", "capabilities", "eventStream", "requestQueueDepth", "protocol",
  ])
  assertEquals(parseHostMessage({
    type: "snapshot",
    snapshot: { connected: false, connectionState: "connecting", sessions: [], agents: [], models: [], health: summary },
  })?.type, "snapshot")
})

Deno.test("session traces are bounded and reject sensitive event categories", () => {
  const trace = new TraceService(2, () => 5)
  trace.record({ type: "request.started", requestID: "one" })
  trace.record({ type: "permission.waiting", sessionID: "session" })
  trace.record({ type: "settlement.changed", transition: "active->settled" })
  assertEquals(trace.snapshot().map((entry) => entry.sequence), [2, 3])
  assertThrows(() => trace.record({ type: "prompt.content" }), Error, "Unsafe")
  assertEquals(trace.toJsonLines().includes("password"), false)
  const redacted = new TraceService().record({ type: "request.failed", error: "Authorization: \"Bearer abc123\"\nProxy-Authorization: 'Basic proxy-secret'\nCookie: first=one; second=two\nhttps://user:pass@example.com/path" })
  assertEquals(redacted.error, "Authorization: [redacted] Proxy-Authorization: [redacted] Cookie: [redacted] https://[redacted]@example.com/path")
})

Deno.test("controller trace categories map protocol event names without retaining sensitive names", () => {
  assertEquals(controllerTraceCategory("event", "session.next.prompt.admitted"), "controller.admission.event")
  assertEquals(controllerTraceCategory("permissions"), "controller.permission.update")
  assertEquals(controllerTraceCategory("event", "future.private.payload"), "controller.runtime.event")
})
