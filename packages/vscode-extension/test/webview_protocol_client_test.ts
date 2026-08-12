import { capabilitiesForRuntime, PROTOCOL_V2_SCHEMA_SOURCE } from "@opencode-workbench/shared"
import { WorkbenchProtocolClient } from "../src/webview/transport/protocol-v2-client.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

interface Message {
  type: string
  value?: number
  message?: string
}

function parseMessage(value: unknown): Message | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  return typeof candidate.type === "string" ? candidate as unknown as Message : undefined
}

class Target {
  listener?: EventListener
  addEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listener = typeof listener === "function" ? listener : (event) => listener.handleEvent(event)
  }
  removeEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const candidate = typeof listener === "function" ? listener : undefined
    if (!candidate || candidate === this.listener) this.listener = undefined
  }
  dispatch(data: unknown): void {
    this.listener?.({ data } as MessageEvent)
  }
}

function ready(epoch = "epoch"): unknown {
  return {
    protocol: 2,
    epoch,
    capabilities: capabilitiesForRuntime("managed", "connected"),
    runtime: {
      mode: "managed",
      authority: "opencode",
      companion: "connected",
      nativeAgentHost: "deferred",
    },
    limits: PROTOCOL_V2_SCHEMA_SOURCE.defaultLimits,
  }
}

function event(
  sequence: number,
  baseRevision: number,
  message: Message,
  epoch = "epoch",
): unknown {
  return {
    protocol: 2,
    kind: "event",
    epoch,
    sequence,
    type: "workbench.message",
    revision: baseRevision + 1,
    payload: {
      throughSequence: sequence,
      baseRevision,
      nextRevision: baseRevision + 1,
      message,
    },
  }
}

Deno.test("production webview client negotiates, correlates, and replays sequence gaps", async () => {
  const posted: unknown[] = []
  const received: Message[] = []
  const target = new Target()
  const client = new WorkbenchProtocolClient<Message, Message, {}>(
    {
      postMessage: (message) => posted.push(message),
      getState: () => ({}),
      setState: () => undefined,
    },
    target as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    {
      surfaceID: "surface",
      extensionVersion: "test",
      legacyReady: { type: "ready" },
      parseInbound: parseMessage,
      protocolError: (message) => ({ type: "error", message }),
    },
  )
  client.listen((message) => received.push(message))
  client.post({ type: "ready" })
  const hello = posted[0] as { protocolRange?: { minimum?: number; maximum?: number }; client?: { surfaceID?: string } }
  assert(
    hello.protocolRange?.minimum === 2 && hello.protocolRange.maximum === 2 && hello.client?.surfaceID === "surface",
    "Client did not initiate v2 negotiation",
  )

  target.dispatch(ready())
  target.dispatch({
    protocol: 2,
    kind: "event",
    epoch: "epoch",
    sequence: 0,
    type: "workbench.snapshot",
    revision: 0,
    payload: { snapshot: { epoch: "epoch", sequence: 0, revision: 0, state: [{ type: "snapshot", value: 0 }] } },
  })
  assert(client.protocol === 2 && received[0]?.type === "snapshot", "Client did not apply negotiated initial state")

  client.post({ type: "act", value: 1 })
  const action = posted.at(-1) as { kind?: string; id?: string; type?: string; mutationID?: string; payload?: Message }
  assert(
    action.kind === "request" && action.type === "workbench.dispatch" && action.id && action.mutationID &&
      action.payload?.value === 1,
    "Client action was not wrapped in a correlated mutation request",
  )
  target.dispatch({ protocol: 2, kind: "response", id: action.id, ok: true, result: { admitted: true } })

  target.dispatch(event(2, 1, { type: "patch", value: 2 }))
  await Promise.resolve()
  const resync = posted.at(-1) as { id?: string; type?: string; payload?: { lastSeenSequence?: number } }
  assert(
    resync.type === "protocol.resync" && resync.payload?.lastSeenSequence === 0,
    "Sequence gap did not request deterministic recovery",
  )
  target.dispatch(event(3, 2, { type: "patch", value: 3 }))
  target.dispatch({
    protocol: 2,
    kind: "response",
    id: resync.id,
    ok: true,
    result: {
      kind: "replay",
      events: [
        event(1, 0, { type: "patch", value: 1 }),
        event(2, 1, { type: "patch", value: 2 }),
      ],
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert(
    received.slice(-3).map((message) => message.value).join(",") === "1,2,3",
    "Replay did not restore missing events and drain an interleaved live event",
  )

  target.dispatch({
    protocol: 2,
    kind: "event",
    epoch: "new-epoch",
    sequence: 0,
    type: "workbench.snapshot",
    revision: 0,
    payload: { snapshot: { epoch: "new-epoch", sequence: 0, revision: 0, state: [{ type: "snapshot", value: 3 }] } },
  })
  target.dispatch(event(3, 2, { type: "stale", value: 99 }, "epoch"))
  assert(received.at(-1)?.value === 3, "Event from a replaced epoch mutated current state")
  target.dispatch({
    protocol: 2,
    kind: "event",
    epoch: "epoch",
    sequence: 3,
    type: "workbench.snapshot",
    revision: 3,
    payload: {
      snapshot: { epoch: "epoch", sequence: 3, revision: 3, state: [{ type: "stale-snapshot", value: 100 }] },
    },
  })
  assert(received.at(-1)?.value === 3, "Snapshot from a retired epoch replaced current state")
  client.dispose()
})

Deno.test("new webview client falls back when a legacy host answers hello", () => {
  const posted: unknown[] = []
  const received: Message[] = []
  const target = new Target()
  const client = new WorkbenchProtocolClient<Message, Message, {}>(
    {
      postMessage: (message) => posted.push(message),
      getState: () => ({}),
      setState: () => undefined,
    },
    target as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    {
      surfaceID: "legacy",
      extensionVersion: "test",
      legacyReady: { type: "ready" },
      parseInbound: parseMessage,
      protocolError: (message) => ({ type: "error", message }),
    },
  )
  client.listen((message) => received.push(message))
  client.post({ type: "ready" })
  target.dispatch({ type: "error", message: "Ignored an invalid webview message" })
  assert(
    client.protocol === 1 && received[0]?.type === "error",
    "Legacy host response did not select v1 compatibility mode",
  )
  assert((posted.at(-1) as Message).type === "ready", "Client did not retry the legacy ready handshake")
  client.post({ type: "act", value: 4 })
  assert((posted.at(-1) as Message).value === 4, "Legacy action was not posted directly after fallback")
  client.dispose()
})

Deno.test("disposing a v2 webview requests cancellation for in-flight host work", () => {
  const posted: unknown[] = []
  const target = new Target()
  const client = new WorkbenchProtocolClient<Message, Message, {}>(
    {
      postMessage: (message) => posted.push(message),
      getState: () => ({}),
      setState: () => undefined,
    },
    target as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    {
      surfaceID: "dispose",
      extensionVersion: "test",
      legacyReady: { type: "ready" },
      parseInbound: parseMessage,
      protocolError: (message) => ({ type: "error", message }),
    },
  )
  client.post({ type: "ready" })
  target.dispatch(ready())
  client.post({ type: "long-running" })
  const pending = posted.at(-1) as { id?: string; type?: string }
  client.dispose()
  const cancellation = posted.at(-1) as { type?: string; payload?: { requestID?: string } }
  assert(
    pending.type === "workbench.dispatch" && cancellation.type === "protocol.cancel" &&
      cancellation.payload?.requestID === pending.id,
    "Webview disposal did not cancel its in-flight request",
  )
})
