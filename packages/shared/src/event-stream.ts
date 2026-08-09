export interface SequencedWorkbenchEvent<TPayload = unknown> {
  epoch: string;
  sequence: number;
  throughSequence: number;
  type: string;
  payload: TPayload;
  baseRevision?: number;
  nextRevision?: number;
  coalesceKey?: string;
}

export interface WorkbenchSnapshot<TState> {
  epoch: string;
  sequence: number;
  revision: number;
  state: TState;
}

export type ReplayResult<TState> =
  | { kind: "replay"; events: SequencedWorkbenchEvent[] }
  | { kind: "snapshot"; snapshot: WorkbenchSnapshot<TState> };

export type EventCursorResult =
  | { kind: "applied" }
  | { kind: "stale-epoch" }
  | { kind: "resync"; reason: "epoch" | "sequence-gap" | "revision-gap" };

function validCounter(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

export function createEventEpoch(
  generation: number,
  nonce: string = crypto.randomUUID(),
): string {
  validCounter(generation, "generation");
  if (!nonce || nonce.length > 256) {
    throw new Error("epoch nonce must be non-empty and bounded");
  }
  return `${generation}:${nonce}`;
}

export class SequencedEventLog<TState> {
  private sequence = 0;
  private revision = 0;
  private readonly retained: SequencedWorkbenchEvent[] = [];

  constructor(
    readonly epoch: string,
    private readonly state: () => TState,
    readonly maximumRetained = 10_000,
  ) {
    if (!epoch) throw new Error("Event log epoch is required");
    if (!Number.isSafeInteger(maximumRetained) || maximumRetained < 1) {
      throw new Error("maximumRetained must be positive");
    }
  }

  get currentSequence(): number {
    return this.sequence;
  }

  get currentRevision(): number {
    return this.revision;
  }

  publishTransient(
    type: string,
    payload: unknown,
    coalesceKey?: string,
  ): SequencedWorkbenchEvent {
    return this.append({
      epoch: this.epoch,
      sequence: ++this.sequence,
      throughSequence: this.sequence,
      type,
      payload,
      ...(coalesceKey ? { coalesceKey } : {}),
    });
  }

  publishPatch(
    type: string,
    payload: unknown,
    baseRevision = this.revision,
  ): SequencedWorkbenchEvent {
    if (baseRevision !== this.revision) {
      throw new Error(
        `Patch base revision ${baseRevision} does not match ${this.revision}`,
      );
    }
    const nextRevision = ++this.revision;
    return this.append({
      epoch: this.epoch,
      sequence: ++this.sequence,
      throughSequence: this.sequence,
      type,
      payload,
      baseRevision,
      nextRevision,
    });
  }

  snapshot(): WorkbenchSnapshot<TState> {
    return {
      epoch: this.epoch,
      sequence: this.sequence,
      revision: this.revision,
      state: structuredClone(this.state()),
    };
  }

  replay(lastSeenSequence: number): ReplayResult<TState> {
    validCounter(lastSeenSequence, "lastSeenSequence");
    if (lastSeenSequence > this.sequence) {
      return { kind: "snapshot", snapshot: this.snapshot() };
    }
    if (lastSeenSequence === this.sequence) {
      return { kind: "replay", events: [] };
    }
    const first = this.retained[0]?.sequence ?? this.sequence + 1;
    if (lastSeenSequence + 1 < first) {
      return { kind: "snapshot", snapshot: this.snapshot() };
    }
    return {
      kind: "replay",
      events: this.retained.filter((event) => event.sequence > lastSeenSequence)
        .map((event) => structuredClone(event)),
    };
  }

  private append(event: SequencedWorkbenchEvent): SequencedWorkbenchEvent {
    this.retained.push(event);
    while (this.retained.length > this.maximumRetained) this.retained.shift();
    return structuredClone(event);
  }
}

export class SurfaceEventQueue {
  private readonly events: SequencedWorkbenchEvent[] = [];
  private snapshotRequired = false;

  constructor(readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("Surface event queue maximum must be positive");
    }
  }

  get size(): number {
    return this.events.length;
  }

  get requiresSnapshot(): boolean {
    return this.snapshotRequired;
  }

  enqueue(event: SequencedWorkbenchEvent): void {
    if (this.snapshotRequired) return;
    const previous = this.events.at(-1);
    if (
      event.coalesceKey && previous?.coalesceKey === event.coalesceKey &&
      previous.epoch === event.epoch &&
      previous.throughSequence + 1 === event.sequence &&
      previous.baseRevision === undefined && event.baseRevision === undefined
    ) {
      this.events[this.events.length - 1] = {
        ...event,
        sequence: previous.sequence,
        throughSequence: event.throughSequence,
      };
      return;
    }
    if (this.events.length >= this.maximum) {
      this.events.length = 0;
      this.snapshotRequired = true;
      return;
    }
    this.events.push(structuredClone(event));
  }

  drain(): { requiresSnapshot: boolean; events: SequencedWorkbenchEvent[] } {
    const result = {
      requiresSnapshot: this.snapshotRequired,
      events: this.events.splice(0).map((event) => structuredClone(event)),
    };
    this.snapshotRequired = false;
    return result;
  }
}

export class EventCursor {
  private epoch?: string;
  private sequence = 0;
  private revision = 0;

  applySnapshot<T>(snapshot: WorkbenchSnapshot<T>): void {
    this.epoch = snapshot.epoch;
    this.sequence = snapshot.sequence;
    this.revision = snapshot.revision;
  }

  accept(event: SequencedWorkbenchEvent): EventCursorResult {
    if (!this.epoch) return { kind: "resync", reason: "epoch" };
    if (event.epoch !== this.epoch) {
      return event.sequence <= this.sequence
        ? { kind: "stale-epoch" }
        : { kind: "resync", reason: "epoch" };
    }
    if (
      event.sequence !== this.sequence + 1 ||
      event.throughSequence < event.sequence
    ) return { kind: "resync", reason: "sequence-gap" };
    if (event.baseRevision !== undefined || event.nextRevision !== undefined) {
      if (
        event.baseRevision !== this.revision ||
        event.nextRevision !== this.revision + 1
      ) return { kind: "resync", reason: "revision-gap" };
      this.revision = event.nextRevision;
    }
    this.sequence = event.throughSequence;
    return { kind: "applied" };
  }

  position(): { epoch?: string; sequence: number; revision: number } {
    return {
      epoch: this.epoch,
      sequence: this.sequence,
      revision: this.revision,
    };
  }
}
