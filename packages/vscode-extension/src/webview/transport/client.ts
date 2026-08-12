/// <reference lib="dom" />
import { WebviewRequestRegistry } from "./request-registry.js"

export interface WebviewApi<TOutbound, TState> {
  postMessage(message: TOutbound): void
  getState(): TState | undefined
  setState(state: TState): void
}

export class WebviewTransportClient<TOutbound, TInbound, TState = unknown> {
  private listener?: (event: MessageEvent) => void
  private readonly requests: WebviewRequestRegistry
  constructor(
    readonly api: WebviewApi<TOutbound, TState>,
    private readonly target: Pick<Window, "addEventListener" | "removeEventListener">,
    private readonly parse: (value: unknown) => TInbound | undefined,
    readonly maximumPending = 128,
  ) {
    this.requests = new WebviewRequestRegistry(maximumPending)
  }
  post(message: TOutbound): void {
    this.api.postMessage(message)
  }
  listen(handler: (message: TInbound) => void): void {
    this.stopListening()
    this.listener = (event) => {
      const message = this.parse(event.data)
      if (message !== undefined) handler(message)
    }
    this.target.addEventListener("message", this.listener as EventListener)
  }
  stopListening(): void {
    if (!this.listener) return
    this.target.removeEventListener("message", this.listener as EventListener)
    this.listener = undefined
  }
  register<TResult>(requestID: string, timeoutMilliseconds = 30_000): Promise<TResult> {
    return this.requests.register(requestID, timeoutMilliseconds)
  }
  resolve(requestID: string, value: unknown): boolean {
    return this.requests.resolve(requestID, value)
  }
  reject(requestID: string, error: Error): boolean {
    return this.requests.reject(requestID, error)
  }
  dispose(): void {
    this.stopListening()
    this.requests.dispose()
  }
}
