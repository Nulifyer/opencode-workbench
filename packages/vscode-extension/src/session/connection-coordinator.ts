export interface ConnectionCoordinatorOptions<TEvent> {
  connect(
    signal: AbortSignal,
    opened: () => Promise<void>,
    event: (value: TEvent) => void,
  ): Promise<void>;
  flush(): void;
  opened(signal: AbortSignal): Promise<void>;
  event(value: TEvent): void;
  disconnected(): void;
  error(error: unknown): void;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export class ConnectionCoordinator<TEvent> {
  private stream?: AbortController;
  private disposed = false;

  constructor(private readonly options: ConnectionCoordinatorOptions<TEvent>) {}

  start(): void {
    if (this.stream || this.disposed) return;
    this.stream = new AbortController();
    void this.run(this.stream.signal);
  }

  reconnect(): void {
    if (this.disposed) return;
    this.stream?.abort(new Error("Connection replaced"));
    this.stream = undefined;
    this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.stream?.abort(new Error("Connection coordinator disposed"));
    this.stream = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        await this.options.connect(
          signal,
          async () => {
            this.options.flush();
            attempt = 0;
            await this.options.opened(signal);
          },
          (event) => {
            if (!signal.aborted) this.options.event(event);
          },
        );
        this.options.flush();
        if (signal.aborted) return;
        this.options.disconnected();
        await delay(250, signal);
      } catch (error) {
        this.options.flush();
        if (signal.aborted) return;
        this.options.disconnected();
        if (attempt === 0) this.options.error(error);
        attempt += 1;
        try {
          await delay(
            Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)),
            signal,
          );
        } catch {
          return;
        }
      }
    }
  }
}
