import {
  capabilitiesForRuntime,
  createEventEpoch,
  enforceProtocolLimits,
  type Event,
  type HelloMessage,
  negotiateProtocol,
  parseHelloMessage,
  type ProtocolLimits,
  PROTOCOL_V2_SCHEMA_SOURCE,
  ProtocolValidationError,
  type ReadyMessage,
  type RuntimeDescriptor,
  SequencedEventLog,
  type SequencedWorkbenchEvent,
  structuredError,
  SurfaceEventQueue,
  type WorkbenchCapabilities,
  type WorkbenchCapability,
  type WorkbenchSnapshot,
} from "@opencode-workbench/shared";
import type { HostRequestContext } from "./host-router.js";
import { HostRouter } from "./host-router.js";

export interface ProtocolSurface {
  postMessage(message: unknown): PromiseLike<unknown> | unknown;
}

export interface ProtocolDispatchContext {
  readonly signal: AbortSignal;
  readonly requestID: string;
}

export interface ProtocolObservation {
  type: "protocol.negotiated" | "protocol.request.started" | "protocol.request.completed" | "protocol.request.failed" | "protocol.request.cancelled" | "protocol.resync.recovered" | "protocol.event.published" | "protocol.snapshot.sent" | "protocol.epoch.rotated"
  requestID?: string
  mutationID?: string
  revision?: number
  durationMilliseconds?: number
  transition?: string
}

export interface WebviewProtocolHostOptions<TState, TInbound, TOutbound> {
  state(): TState;
  runtime(): RuntimeDescriptor;
  parseInbound(value: unknown): TInbound | undefined;
  dispatch(
    surfaceID: string,
    message: TInbound,
    context: ProtocolDispatchContext,
  ): Promise<void>;
  requiredCapability?(message: TInbound): WorkbenchCapability | undefined;
  eventDisposition?(message: TOutbound): "patch" | "transient";
  snapshotFollowups?(): TOutbound[];
  observe?(observation: ProtocolObservation): void;
  limits?: ProtocolLimits;
}

interface SurfaceState<TState> {
  target: ProtocolSurface;
  mode: "pending" | "v1" | "v2";
  visible: boolean;
  log: SequencedEventLog<TState>;
  queue: SurfaceEventQueue;
  delivery: Promise<void>;
}

interface WorkbenchEventPayload<TOutbound> {
  throughSequence: number;
  baseRevision?: number;
  nextRevision?: number;
  message: TOutbound;
}

export type ProtocolRecovery<TState, TOutbound> =
  | { kind: "replay"; events: Array<Event<"workbench.message", WorkbenchEventPayload<TOutbound>>> }
  | { kind: "snapshot"; snapshot: WorkbenchSnapshot<TState> };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedCounter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ProtocolValidationError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function requestID(value: unknown): string {
  return record(value) && typeof value.id === "string" && value.id
    ? value.id.slice(0, 256)
    : "invalid";
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined
}

function requestCategory(value: unknown): string {
  return value === "workbench.dispatch" ? "dispatch" : value === "protocol.resync" ? "resync" : value === "protocol.cancel" ? "cancel" : "unknown"
}

function responseError(
  id: string,
  error: unknown,
): {
  protocol: 2;
  kind: "response";
  id: string;
  ok: false;
  error: ReturnType<typeof structuredError>;
} {
  const failure = error instanceof ProtocolValidationError
    ? error
    : new ProtocolValidationError(
      error instanceof Error ? error.message.slice(0, 20_000) : "Protocol negotiation failed",
      "INTERNAL",
    );
  return {
    protocol: 2,
    kind: "response",
    id,
    ok: false,
    error: structuredError(
      failure.code,
      failure.message,
      failure.code === "OVERLOADED" || failure.code === "TIMEOUT",
    ),
  };
}

export class WebviewProtocolHost<TState, TInbound, TOutbound> {
  readonly limits: ProtocolLimits;
  readonly capabilities: WorkbenchCapabilities;
  private readonly router: HostRouter;
  private readonly surfaces = new Map<string, SurfaceState<TState>>();
  private generation = 1;
  private epoch = createEventEpoch(this.generation);

  constructor(private readonly options: WebviewProtocolHostOptions<TState, TInbound, TOutbound>) {
    this.limits = options.limits ?? { ...PROTOCOL_V2_SCHEMA_SOURCE.defaultLimits };
    const runtime = options.runtime();
    this.capabilities = capabilitiesForRuntime(runtime.mode, runtime.companion);
    this.router = new HostRouter({
      capabilities: this.capabilities,
      limits: this.limits,
      defaultTimeoutMilliseconds: 10 * 60_000,
    });
    this.router.register("workbench.dispatch", {
      mutation: true,
      longRunning: true,
      preservesInputUntilAdmission: true,
      handler: async (context, payload) => {
        const message = this.options.parseInbound(payload);
        if (message === undefined) {
          context.rejectInput();
          throw new ProtocolValidationError("Invalid Workbench action payload");
        }
        const capability = this.options.requiredCapability?.(message);
        if (capability && !this.capabilities[capability]) {
          context.rejectInput();
          throw new ProtocolValidationError(
            `Capability ${capability} is unavailable`,
            "CAPABILITY_UNAVAILABLE",
          );
        }
        await this.options.dispatch(context.surfaceID, message, {
          signal: context.signal,
          requestID: context.request.id,
        });
        context.admitInput();
        return { admitted: true };
      },
    });
    this.router.register("protocol.resync", {
      handler: async (context, payload) => this.recovery(context, payload),
    });
    this.router.register("protocol.cancel", {
      handler: async (_context, payload) => {
        if (!record(payload) || typeof payload.requestID !== "string" || !payload.requestID) {
          throw new ProtocolValidationError("protocol.cancel requires requestID");
        }
        return { cancelled: this.router.cancel(payload.requestID) };
      },
    });
  }

  get currentEpoch(): string {
    return this.epoch;
  }

  get pendingRequests(): number {
    return this.router.pendingRequests;
  }

  attach(
    surfaceID: string,
    target: ProtocolSurface,
    visible: boolean,
  ): void {
    if (!surfaceID || this.surfaces.has(surfaceID)) {
      throw new Error(`Protocol surface already attached: ${surfaceID || "<empty>"}`);
    }
    this.surfaces.set(surfaceID, {
      target,
      mode: "pending",
      visible,
      log: this.eventLog(),
      queue: new SurfaceEventQueue(this.limits.maxEventQueue),
      delivery: Promise.resolve(),
    });
  }

  detach(surfaceID: string): void {
    this.router.disposeSurface(surfaceID);
    this.surfaces.delete(surfaceID);
  }

  markLegacy(surfaceID: string): void {
    const surface = this.requireSurface(surfaceID);
    if (surface.mode === "pending") surface.mode = "v1";
  }

  isV2(surfaceID: string): boolean {
    return this.surfaces.get(surfaceID)?.mode === "v2";
  }

  async receive(surfaceID: string, input: unknown): Promise<boolean> {
    const surface = this.requireSurface(surfaceID);
    // Some validated v1 actions contain an application-level `protocol`
    // discriminator (for example permission replies). Only envelope markers
    // identify transport v2 here; treating any `protocol` field as an envelope
    // would break those legacy actions.
    const protocolShaped = record(input) && (
      "protocolRange" in input ||
      input.kind === "request" || input.kind === "response" || input.kind === "event"
    );
    if (!protocolShaped) return false;

    if (record(input) && "protocolRange" in input) {
      try {
        const hello = parseHelloMessage(input);
        this.validateHello(surfaceID, hello);
        negotiateProtocol(hello.protocolRange);
        surface.mode = "v2";
        this.observe({ type: "protocol.negotiated", transition: "hello->ready" });
        await this.post(surface, this.ready());
        await this.sendSnapshot(surface);
      } catch (error) {
        await this.post(surface, responseError("hello", error));
      }
      return true;
    }

    if (surface.mode !== "v2") {
      await this.post(
        surface,
        responseError(
          requestID(input),
          new ProtocolValidationError(
            "Protocol v2 requests require hello/ready negotiation",
            "CAPABILITY_UNAVAILABLE",
          ),
        ),
      );
      return true;
    }
    const startedAt = Date.now();
    const request = record(input) ? input : undefined;
    const category = requestCategory(request?.type);
    const observation = {
      requestID: safeIdentifier(request?.id),
      mutationID: safeIdentifier(request?.mutationID),
      revision: Number.isSafeInteger(request?.expectedRevision) && Number(request?.expectedRevision) >= 0 ? Number(request?.expectedRevision) : undefined,
    };
    this.observe({ type: "protocol.request.started", ...observation, transition: category });
    const response = await this.router.route(surfaceID, input);
    this.observe({
      type: response.ok ? "protocol.request.completed" : "protocol.request.failed",
      ...observation,
      durationMilliseconds: Date.now() - startedAt,
      transition: `${category}:${response.ok ? "ok" : response.error.code}`,
    });
    if (category === "cancel") {
      const targetRequestID = record(request?.payload) ? safeIdentifier(request.payload.requestID) : undefined;
      const cancelled = response.ok && record(response.result) && response.result.cancelled === true;
      this.observe({ type: "protocol.request.cancelled", requestID: targetRequestID, durationMilliseconds: Date.now() - startedAt, transition: cancelled ? "cancelled" : "not-found" });
    }
    if (category === "resync" && response.ok && record(response.result)) {
      const recovery = response.result.kind === "snapshot" ? "snapshot" : response.result.kind === "replay" ? "replay" : "unknown";
      const revision = recovery === "snapshot" && record(response.result.snapshot) && Number.isSafeInteger(response.result.snapshot.revision)
        ? Number(response.result.snapshot.revision)
        : undefined;
      this.observe({ type: "protocol.resync.recovered", requestID: observation.requestID, revision, durationMilliseconds: Date.now() - startedAt, transition: recovery });
    }
    await this.post(surface, response);
    if (
      record(input) && input.type === "protocol.resync" && response.ok &&
      record(response.result) && response.result.kind === "snapshot"
    ) await this.sendSnapshotFollowups(surface);
    return true;
  }

  async publishTo(surfaceID: string, message: TOutbound): Promise<void> {
    const surface = this.requireSurface(surfaceID);
    if (surface.mode === "pending") return;
    if (surface.mode === "v1") {
      await this.post(surface, message);
      return;
    }
    const event = this.recordEvent(surface, message);
    this.observe({ type: "protocol.event.published", revision: event.nextRevision, transition: surface.visible ? "visible" : "queued-hidden" });
    const envelope = this.eventEnvelope(event);
    if (!surface.visible) {
      surface.queue.enqueue(event);
      return;
    }
    await this.post(surface, envelope);
  }

  async setVisible(surfaceID: string, visible: boolean): Promise<void> {
    const surface = this.requireSurface(surfaceID);
    surface.visible = visible;
    if (!visible || surface.mode !== "v2") return;
    const queued = surface.queue.drain();
    if (queued.requiresSnapshot) {
      await this.sendSnapshot(surface);
      return;
    }
    // Chain the complete drain synchronously so a newly published visible
    // event cannot be inserted between older queued sequence numbers.
    await Promise.all(
      queued.events.map((event) => this.post(surface, this.eventEnvelope(event))),
    );
  }

  async rotateEpoch(): Promise<void> {
    this.epoch = createEventEpoch(++this.generation);
    this.observe({ type: "protocol.epoch.rotated", transition: "runtime-generation" });
    const publications: Promise<void>[] = [];
    for (const surface of this.surfaces.values()) {
      surface.log = this.eventLog();
      surface.queue = new SurfaceEventQueue(this.limits.maxEventQueue);
      if (surface.mode === "v2") publications.push(this.sendSnapshot(surface));
    }
    await Promise.all(publications);
  }

  private eventLog(): SequencedEventLog<TState> {
    return new SequencedEventLog(
      this.epoch,
      () => this.options.state(),
      Math.max(this.limits.maxEventQueue * 2, 128),
    );
  }

  private ready(): ReadyMessage {
    return {
      protocol: 2,
      epoch: this.epoch,
      capabilities: { ...this.capabilities },
      runtime: this.options.runtime(),
      limits: { ...this.limits },
    };
  }

  private validateHello(surfaceID: string, hello: HelloMessage): void {
    if (hello.client.surfaceID !== surfaceID) {
      throw new ProtocolValidationError(
        "hello.client.surfaceID does not match the attached surface",
      );
    }
  }

  private requireSurface(surfaceID: string): SurfaceState<TState> {
    const surface = this.surfaces.get(surfaceID);
    if (!surface) throw new Error(`Unknown protocol surface ${surfaceID}`);
    return surface;
  }

  private async recovery(
    context: HostRequestContext,
    payload: unknown,
  ): Promise<ProtocolRecovery<TState, TOutbound>> {
    if (!record(payload)) {
      throw new ProtocolValidationError("protocol.resync payload must be an object");
    }
    const surface = this.requireSurface(context.surfaceID);
    const lastSeenSequence = boundedCounter(
      payload.lastSeenSequence,
      "protocol.resync.lastSeenSequence",
    );
    if (payload.epoch !== this.epoch) {
      return { kind: "snapshot", snapshot: surface.log.snapshot() };
    }
    const replay = surface.log.replay(lastSeenSequence);
    return replay.kind === "snapshot"
      ? replay
      : {
        kind: "replay",
        events: replay.events.map((event) => this.eventEnvelope(event)),
      };
  }

  private eventEnvelope(
    event: SequencedWorkbenchEvent,
  ): Event<"workbench.message", WorkbenchEventPayload<TOutbound>> {
    return {
      protocol: 2,
      kind: "event",
      epoch: event.epoch,
      sequence: event.sequence,
      type: "workbench.message",
      ...(event.nextRevision === undefined ? {} : { revision: event.nextRevision }),
      payload: {
        throughSequence: event.throughSequence,
        ...(event.baseRevision === undefined ? {} : { baseRevision: event.baseRevision }),
        ...(event.nextRevision === undefined ? {} : { nextRevision: event.nextRevision }),
        message: event.payload as TOutbound,
      },
    };
  }

  private recordEvent(
    surface: SurfaceState<TState>,
    message: TOutbound,
  ): SequencedWorkbenchEvent {
    const transient = this.options.eventDisposition?.(message) === "transient";
    const sequence = surface.log.currentSequence + 1;
    const preview: SequencedWorkbenchEvent = {
      epoch: this.epoch,
      sequence,
      throughSequence: sequence,
      type: "workbench.message",
      payload: message,
      ...(transient
        ? {}
        : {
          baseRevision: surface.log.currentRevision,
          nextRevision: surface.log.currentRevision + 1,
        }),
    };
    enforceProtocolLimits(this.eventEnvelope(preview), this.limits);
    return transient
      ? surface.log.publishTransient("workbench.message", message)
      : surface.log.publishPatch("workbench.message", message);
  }

  private snapshotEnvelope(
    snapshot: WorkbenchSnapshot<TState>,
  ): Event<"workbench.snapshot", { snapshot: WorkbenchSnapshot<TState> }> {
    return {
      protocol: 2,
      kind: "event",
      epoch: snapshot.epoch,
      sequence: snapshot.sequence,
      type: "workbench.snapshot",
      revision: snapshot.revision,
      payload: { snapshot },
    };
  }

  private async sendSnapshot(surface: SurfaceState<TState>): Promise<void> {
    surface.queue.drain();
    const snapshot = surface.log.snapshot();
    this.observe({ type: "protocol.snapshot.sent", revision: snapshot.revision, transition: "authoritative" });
    await this.post(surface, this.snapshotEnvelope(snapshot));
    await this.sendSnapshotFollowups(surface);
  }

  private async sendSnapshotFollowups(surface: SurfaceState<TState>): Promise<void> {
    for (const message of this.options.snapshotFollowups?.() ?? []) {
      const event = this.recordEvent(surface, message);
      await this.post(surface, this.eventEnvelope(event));
    }
  }

  private post(surface: SurfaceState<TState>, message: unknown): Promise<void> {
    if (surface.mode === "v2") enforceProtocolLimits(message, this.limits);
    const deliver = async (): Promise<void> => {
      await surface.target.postMessage(message);
    };
    const publication = surface.delivery.then(deliver, deliver);
    surface.delivery = publication.catch(() => undefined);
    return publication;
  }

  private observe(observation: ProtocolObservation): void {
    try {
      this.options.observe?.(observation)
    } catch {
      // Diagnostics must never alter protocol delivery or admission.
    }
  }
}
