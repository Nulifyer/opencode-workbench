export type StateUpdate = (
  key: string,
  value: unknown,
) => void | PromiseLike<void>;

interface QueuedFailure {
  sequence: number;
  error: unknown;
}

function cloneStateValue<T>(value: T): T {
  // VS Code uses `undefined` to remove a Memento entry.
  if (value === undefined) return value;

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("Workspace state values must be JSON-serializable", {
      cause: error,
    });
  }
  if (serialized === undefined) {
    throw new TypeError("Workspace state values must be JSON-serializable");
  }
  return JSON.parse(serialized) as T;
}

/**
 * Serializes Memento updates so an older, slower write cannot overwrite newer
 * state. Values are snapshotted when queued rather than when persistence starts.
 */
export class SerializedStateWriter {
  private tail: Promise<void> = Promise.resolve();
  private failures: QueuedFailure[] = [];
  private sequence = 0;
  private disposed = false;

  constructor(private readonly update: StateUpdate) {}

  write(key: string, value: unknown): void {
    if (this.disposed) {
      throw new Error("Serialized state writer is disposed");
    }
    const snapshot = cloneStateValue(value);
    const sequence = ++this.sequence;
    const scheduled = this.tail.then(async () => {
      await this.update(key, snapshot);
    });
    this.tail = scheduled.catch((error) => {
      this.failures.push({ sequence, error });
    });
  }

  async flush(): Promise<void> {
    const throughSequence = this.sequence;
    const barrier = this.tail;
    await barrier;

    const drained: unknown[] = [];
    const retained: QueuedFailure[] = [];
    for (const failure of this.failures) {
      if (failure.sequence <= throughSequence) {
        drained.push(failure.error);
      } else {
        retained.push(failure);
      }
    }
    this.failures = retained;

    if (drained.length === 1) throw drained[0];
    if (drained.length > 1) {
      throw new AggregateError(
        drained,
        `${drained.length} workspace state writes failed`,
      );
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.flush();
  }
}
