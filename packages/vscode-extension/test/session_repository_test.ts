import { assertEquals } from "jsr:@std/assert"
import { SessionRepository } from "../src/application/session-repository.ts"

Deno.test("session repository owns reducer state and deterministic subscriptions", () => {
  const repository = new SessionRepository()
  const updates: string[] = []
  const subscription = repository.subscribe((update) => updates.push(update.type))
  assertEquals(repository.dispatch({ type: "connected", connected: true, connectionState: "connected" }), true)
  assertEquals(repository.snapshot.connected, true)
  assertEquals(updates, ["connected"])
  subscription.dispose()
  repository.dispatch({ type: "connected", connected: false, connectionState: "reconnecting" })
  assertEquals(updates, ["connected"])
})
