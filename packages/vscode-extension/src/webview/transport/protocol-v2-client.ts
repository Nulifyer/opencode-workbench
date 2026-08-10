/// <reference lib="dom" />
import {
  enforceProtocolLimits,
  EventCursor,
  parseEvent,
  parseReadyMessage,
  parseResponse,
  type ReadyMessage,
  type Request,
  type StructuredError,
  type WorkbenchSnapshot,
} from "@opencode-workbench/shared";
import {
  WebviewTransportClient,
  type WebviewApi,
} from "./client.js";

type ClientMode = "negotiating" | "v1" | "v2";

export interface WorkbenchProtocolClientOptions<TOutbound, TInbound> {
  surfaceID: string;
  extensionVersion: string;
  legacyReady: TOutbound;
  parseInbound(value: unknown): TInbound | undefined;
  protocolError(message: string): TInbound | undefined;
  onReady?(ready: ReadyMessage): void;
}

interface WorkbenchEventPayload {
  throughSequence: number;
  baseRevision?: number;
  nextRevision?: number;
  message: unknown;
}

interface RecoveryResult {
  kind: "replay" | "snapshot";
  events?: unknown[];
  snapshot?: WorkbenchSnapshot<unknown>;
}

export class ProtocolResponseError extends Error {
  constructor(readonly responseError: StructuredError) {
    super(responseError.message);
    this.name = "ProtocolResponseError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function identifier(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export class WorkbenchProtocolClient<TOutbound, TInbound, TState = unknown> {
  private readonly raw: WebviewTransportClient<unknown, unknown, TState>;
  private readonly cursor = new EventCursor();
  private readonly queued: TOutbound[] = [];
  private readonly activeRequestIDs = new Set<string>();
  private readonly bufferedEvents: Array<ReturnType<typeof parseEvent>> = [];
  private readonly retiredEpochs = new Set<string>();
  private handler?: (message: TInbound) => void;
  private mode: ClientMode = "negotiating";
  private started = false;
  private disposed = false;
  private resyncing = false;
  private recoveryGeneration = 0;
  private recoveryBufferOverflowed = false;
  private ready?: ReadyMessage;

  constructor(
    api: WebviewApi<unknown, TState>,
    target: Pick<Window, "addEventListener" | "removeEventListener">,
    private readonly options: WorkbenchProtocolClientOptions<TOutbound, TInbound>,
    maximumPending = 128,
  ) {
    this.raw = new WebviewTransportClient(
      api,
      target,
      (value) => value,
      maximumPending,
    );
    this.raw.listen((value) => this.receive(value));
  }

  get protocol(): 1 | 2 | undefined {
    return this.mode === "v1" ? 1 : this.mode === "v2" ? 2 : undefined;
  }

  get capabilities(): ReadyMessage["capabilities"] | undefined {
    return this.ready?.capabilities;
  }

  post(message: TOutbound): void {
    if (this.disposed) return;
    if (!this.started) this.start();
    if (message === this.options.legacyReady || this.isLegacyReady(message)) return;
    if (this.mode === "negotiating") {
      this.queued.push(message);
      return;
    }
    if (this.mode === "v1") {
      this.raw.post(message);
      return;
    }
    void this.dispatch(message);
  }

  listen(handler: (message: TInbound) => void): void {
    this.handler = handler;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queued.length = 0;
    this.bufferedEvents.length = 0;
    this.handler = undefined;
    if (this.mode === "v2") {
      for (const requestID of this.activeRequestIDs) {
        this.raw.post({
          protocol: 2,
          kind: "request",
          id: identifier("cancel"),
          type: "protocol.cancel",
          payload: { requestID },
        });
      }
    }
    this.activeRequestIDs.clear();
    this.raw.dispose();
  }

  private isLegacyReady(message: TOutbound): boolean {
    return record(message) && message.type === "ready";
  }

  private start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.raw.post({
      protocolRange: { minimum: 2, maximum: 2 },
      client: {
        surfaceID: this.options.surfaceID,
        extensionVersion: this.options.extensionVersion,
      },
    });
  }

  private receive(value: unknown): void {
    if (this.disposed) return;
    if (this.mode === "negotiating") {
      if (record(value) && "capabilities" in value && "runtime" in value) {
        try {
          const ready = parseReadyMessage(value);
          this.mode = "v2";
          this.ready = ready;
          this.options.onReady?.(ready);
          this.flush();
        } catch (error) {
          this.emitError(error instanceof Error ? error.message : "Invalid protocol ready message");
        }
        return;
      }
      const legacy = this.options.parseInbound(value);
      if (legacy !== undefined) {
        this.mode = "v1";
        this.handler?.(legacy);
        this.raw.post(this.options.legacyReady);
        this.flush();
        return;
      }
      if (record(value) && value.kind === "response") {
        try {
          const response = parseResponse(value);
          if (!response.ok) this.emitError(response.error.message);
        } catch (error) {
          this.emitError(error instanceof Error ? error.message : "Protocol negotiation failed");
        }
      }
      return;
    }

    if (this.mode === "v1") {
      const legacy = this.options.parseInbound(value);
      if (legacy !== undefined) this.handler?.(legacy);
      return;
    }

    if (!record(value)) return;
    try {
      enforceProtocolLimits(value, this.ready!.limits);
    } catch (error) {
      this.emitError(error instanceof Error ? error.message : "Protocol message exceeded negotiated limits");
      return;
    }
    if (value.kind === "response") {
      try {
        const response = parseResponse(value);
        if (response.ok) this.raw.resolve(response.id, response.result);
        else this.raw.reject(response.id, new ProtocolResponseError(response.error));
      } catch (error) {
        this.emitError(error instanceof Error ? error.message : "Invalid protocol response");
      }
      return;
    }
    if (value.kind === "event") {
      try {
        const event = parseEvent(value);
        if (this.resyncing && event.type !== "workbench.snapshot") {
          this.bufferRecoveryEvent(event);
        } else this.applyEvent(event);
      } catch (error) {
        this.emitError(error instanceof Error ? error.message : "Invalid protocol event");
        this.requestResync();
      }
    }
  }

  private flush(): void {
    const queued = this.queued.splice(0);
    for (const message of queued) this.post(message);
  }

  private dispatch(message: TOutbound): Promise<unknown> {
    const id = identifier("request");
    const request: Request<"workbench.dispatch", TOutbound> = {
      protocol: 2,
      kind: "request",
      id,
      type: "workbench.dispatch",
      mutationID: this.mutationID(message, id),
      ...(record(message) && typeof message.sessionID === "string"
        ? { sessionID: message.sessionID }
        : {}),
      ...(record(message) && message.type === "setComposerPayload" && counter(message.revision)
        ? { expectedRevision: message.revision }
        : {}),
      payload: message,
    };
    return this.request(request, 10 * 60_000).catch((error) => {
      this.emitError(error instanceof Error ? error.message : "Workbench request failed");
      return undefined;
    });
  }

  private mutationID(message: TOutbound, fallback: string): string {
    return record(message) && typeof message.mutationID === "string" && message.mutationID
      ? message.mutationID
      : fallback;
  }

  private request<TResult>(request: Request, timeoutMilliseconds = 30_000): Promise<TResult> {
    try {
      if (this.ready) enforceProtocolLimits(request, this.ready.limits);
    } catch (error) {
      return Promise.reject(error);
    }
    const pending = this.raw.register<TResult>(request.id, timeoutMilliseconds);
    this.activeRequestIDs.add(request.id);
    this.raw.post(request);
    void pending.then(
      () => this.activeRequestIDs.delete(request.id),
      () => this.activeRequestIDs.delete(request.id),
    );
    return pending;
  }

  private applyEvent(event: ReturnType<typeof parseEvent>): void {
    if (event.type === "workbench.snapshot") {
      const snapshot = record(event.payload) ? event.payload.snapshot : undefined;
      if (!record(snapshot) || typeof snapshot.epoch !== "string" ||
        !counter(snapshot.sequence) || !counter(snapshot.revision) ||
        snapshot.epoch !== event.epoch || snapshot.sequence !== event.sequence ||
        event.revision !== snapshot.revision) {
        throw new Error("Invalid Workbench snapshot event");
      }
      this.applySnapshot(snapshot as unknown as WorkbenchSnapshot<unknown>);
      return;
    }
    if (event.type !== "workbench.message" || !record(event.payload)) {
      throw new Error(`Unsupported Workbench event ${event.type}`);
    }
    if (this.retiredEpochs.has(event.epoch)) return;
    const payload = event.payload as unknown as WorkbenchEventPayload;
    if (!counter(payload.throughSequence) ||
      (payload.baseRevision !== undefined && !counter(payload.baseRevision)) ||
      (payload.nextRevision !== undefined && !counter(payload.nextRevision))) {
      throw new Error("Invalid Workbench event position");
    }
    const accepted = this.cursor.accept({
      epoch: event.epoch,
      sequence: event.sequence,
      throughSequence: payload.throughSequence,
      type: event.type,
      payload: payload.message,
      ...(payload.baseRevision === undefined ? {} : { baseRevision: payload.baseRevision }),
      ...(payload.nextRevision === undefined ? {} : { nextRevision: payload.nextRevision }),
    });
    if (accepted.kind === "stale-epoch") return;
    if (accepted.kind === "resync") {
      this.requestResync();
      return;
    }
    const message = this.options.parseInbound(payload.message);
    if (message === undefined) throw new Error("Invalid Workbench event payload");
    this.handler?.(message);
  }

  private applySnapshot(snapshot: WorkbenchSnapshot<unknown>): boolean {
    const currentEpoch = this.cursor.position().epoch;
    if (
      currentEpoch && currentEpoch !== snapshot.epoch &&
      this.retiredEpochs.has(snapshot.epoch)
    ) return false;
    if (!Array.isArray(snapshot.state)) throw new Error("Workbench snapshot state must be a message array");
    const messages = snapshot.state.map((value) => this.options.parseInbound(value));
    const invalidIndex = messages.findIndex((value) => value === undefined);
    if (invalidIndex >= 0) {
      const raw = snapshot.state[invalidIndex];
      const type = record(raw) && typeof raw.type === "string" ? raw.type : "unknown";
      throw new Error(`Workbench snapshot contains an invalid ${type} message at index ${invalidIndex}`);
    }
    if (currentEpoch && currentEpoch !== snapshot.epoch) {
      this.retiredEpochs.add(currentEpoch);
    }
    this.cursor.applySnapshot(snapshot);
    this.recoveryGeneration += 1;
    this.resyncing = false;
    for (const message of messages) this.handler?.(message!);
    this.drainRecoveryEvents();
    return true;
  }

  private requestResync(): void {
    if (this.resyncing || this.mode !== "v2" || !this.ready) return;
    this.resyncing = true;
    const generation = ++this.recoveryGeneration;
    const position = this.cursor.position();
    const id = identifier("resync");
    void this.request<RecoveryResult>({
      protocol: 2,
      kind: "request",
      id,
      type: "protocol.resync",
      payload: {
        epoch: position.epoch,
        lastSeenSequence: position.sequence,
      },
    }).then((result) => {
      if (generation !== this.recoveryGeneration) return;
      if (!record(result)) throw new Error("Invalid protocol recovery result");
      if (result.kind === "snapshot" && record(result.snapshot)) {
        this.applySnapshot(result.snapshot as unknown as WorkbenchSnapshot<unknown>);
        return;
      }
      if (result.kind !== "replay" || !Array.isArray(result.events)) {
        throw new Error("Invalid protocol recovery result");
      }
      for (const value of result.events) {
        this.applyEvent(parseEvent(value));
        if (generation !== this.recoveryGeneration) return;
      }
      this.resyncing = false;
      this.drainRecoveryEvents();
    }).catch((error) => {
      if (generation !== this.recoveryGeneration) return;
      this.resyncing = false;
      this.bufferedEvents.length = 0;
      this.recoveryBufferOverflowed = false;
      this.emitError(error instanceof Error ? error.message : "Protocol resynchronization failed");
    });
  }

  private bufferRecoveryEvent(event: ReturnType<typeof parseEvent>): void {
    if (this.recoveryBufferOverflowed) return;
    if (this.bufferedEvents.length >= this.ready!.limits.maxEventQueue) {
      this.bufferedEvents.length = 0;
      this.recoveryBufferOverflowed = true;
      return;
    }
    this.bufferedEvents.push(event);
  }

  private drainRecoveryEvents(): void {
    if (this.resyncing) return;
    const buffered = this.bufferedEvents.splice(0);
    const overflowed = this.recoveryBufferOverflowed;
    this.recoveryBufferOverflowed = false;
    for (let index = 0; index < buffered.length; index += 1) {
      const event = buffered[index]!;
      const position = this.cursor.position();
      const payload = record(event.payload)
        ? event.payload as unknown as WorkbenchEventPayload
        : undefined;
      if (
        event.epoch === position.epoch && payload &&
        counter(payload.throughSequence) &&
        payload.throughSequence <= position.sequence
      ) continue;
      if (this.retiredEpochs.has(event.epoch)) continue;
      this.applyEvent(event);
      if (this.resyncing) {
        for (const pending of buffered.slice(index + 1)) this.bufferRecoveryEvent(pending);
        break;
      }
    }
    if (overflowed && !this.resyncing) this.requestResync();
  }

  private emitError(message: string): void {
    const inbound = this.options.protocolError(message.slice(0, 20_000));
    if (inbound !== undefined) this.handler?.(inbound);
  }
}
