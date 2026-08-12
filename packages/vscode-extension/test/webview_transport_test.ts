import { WebviewTransportClient } from "../src/webview/transport/client.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
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

Deno.test("webview transport owns parsing, posting, and listener disposal", () => {
  const posted: unknown[] = []
  const received: string[] = []
  const target = new Target()
  const transport = new WebviewTransportClient<
    { type: string },
    { type: string },
    {}
  >(
    {
      postMessage: (message) => posted.push(message),
      getState: () => ({}),
      setState: () => undefined,
    },
    target as unknown as Pick<
      Window,
      "addEventListener" | "removeEventListener"
    >,
    (value) =>
      typeof value === "object" && value !== null && "type" in value &&
        typeof value.type === "string"
        ? { type: value.type }
        : undefined,
  )
  transport.listen((message) => received.push(message.type))
  transport.post({ type: "ready" })
  target.dispatch({ nope: true })
  target.dispatch({ type: "snapshot" })
  assert(
    JSON.stringify(posted) === JSON.stringify([{ type: "ready" }]),
    "Transport did not post exact message",
  )
  assert(
    JSON.stringify(received) === JSON.stringify(["snapshot"]),
    "Transport did not validate inbound messages",
  )
  transport.dispose()
  target.dispatch({ type: "ignored" })
  assert(received.length === 1, "Disposed transport retained its listener")
})

Deno.test("webview request registry correlates, times out, and rejects on disposal", async () => {
  const target = new Target()
  const transport = new WebviewTransportClient<unknown, unknown, {}>(
    {
      postMessage: () => undefined,
      getState: () => ({}),
      setState: () => undefined,
    },
    target as unknown as Pick<
      Window,
      "addEventListener" | "removeEventListener"
    >,
    (value) => value,
    2,
  )
  const correlated = transport.register<{ ok: boolean }>("request")
  assert(
    transport.resolve("request", { ok: true }),
    "Request was not correlated",
  )
  assert((await correlated).ok, "Correlated response was lost")
  const timeout = transport.register("timeout", 1).catch((error) => error)
  assert((await timeout) instanceof Error, "Timed-out request resolved")
  const disposed = transport.register("dispose").catch((error) => error)
  transport.dispose()
  assert((await disposed) instanceof Error, "Disposed request resolved")
})
