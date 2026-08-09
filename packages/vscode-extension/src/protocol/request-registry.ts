export interface PendingHostRequest {
  id: string;
  surfaceID: string;
  type: string;
  startedAt: number;
  disposition: "cancel" | "detach";
}

export class RequestRegistry {
  private readonly pending = new Map<string, PendingHostRequest>();

  constructor(readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("Request registry maximum must be positive");
    }
  }

  get size(): number {
    return this.pending.size;
  }

  has(requestID: string): boolean {
    return this.pending.has(requestID);
  }

  register(
    request: PendingHostRequest,
  ): "registered" | "duplicate" | "overloaded" {
    if (this.pending.has(request.id)) return "duplicate";
    if (this.pending.size >= this.maximum) return "overloaded";
    this.pending.set(request.id, { ...request });
    return "registered";
  }

  finish(requestID: string): void {
    this.pending.delete(requestID);
  }

  forSurface(surfaceID: string): PendingHostRequest[] {
    return [...this.pending.values()].filter((request) =>
      request.surfaceID === surfaceID
    ).map((request) => ({ ...request }));
  }
}
