import {
  type ContextReceipt,
  type ContextReceiptItem,
  sanitizeContextReceipt,
} from "@opencode-workbench/shared";

interface PendingReceipt {
  sessionID: string;
  promptID: string;
  items: ContextReceiptItem[];
  truncation: ContextReceipt["truncation"];
}

function cloneReceipt(receipt: ContextReceipt): ContextReceipt {
  return {
    ...receipt,
    items: receipt.items.map((item) => ({
      ...item,
      range: item.range ? { ...item.range } : undefined,
    })),
  };
}

function sameReceipt(left: ContextReceipt, right: ContextReceipt): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ContextReceiptService {
  private readonly pending = new Map<string, PendingReceipt>();
  private readonly receipts = new Map<string, ContextReceipt>();

  constructor(
    initial: ContextReceipt[] = [],
    private readonly persist?: (receipts: ContextReceipt[]) => void,
    private readonly capacity = 2_000,
  ) {
    for (const receipt of initial.slice(-capacity)) {
      try {
        const sanitized = sanitizeContextReceipt(receipt);
        this.receipts.set(sanitized.id, cloneReceipt(sanitized));
      } catch {
        // Ignore corrupt metadata without preventing the Workbench from starting.
      }
    }
  }

  stage(
    sessionID: string,
    promptID: string,
    items: ContextReceiptItem[],
    truncation: ContextReceipt["truncation"],
  ): void {
    const candidate = sanitizeContextReceipt({
      id: `pending:${promptID}`,
      sessionID,
      promptID,
      admittedAt: 0,
      items,
      truncation,
    });
    this.pending.set(promptID, {
      sessionID,
      promptID,
      items: candidate.items,
      truncation,
    });
  }

  reject(promptID: string): void {
    this.pending.delete(promptID);
  }

  admit(
    sessionID: string,
    promptID: string,
    admittedAt = Date.now(),
  ): ContextReceipt | undefined {
    const pending = this.pending.get(promptID);
    if (!pending || pending.sessionID !== sessionID) return undefined;
    this.pending.delete(promptID);
    const receipt = sanitizeContextReceipt({
      ...pending,
      id: `context:${promptID}`,
      admittedAt,
    });
    this.receipts.set(receipt.id, cloneReceipt(receipt));
    while (this.receipts.size > this.capacity) {
      this.receipts.delete(this.receipts.keys().next().value!);
    }
    this.persist?.([...this.receipts.values()].map(cloneReceipt));
    return cloneReceipt(receipt);
  }

  merge(receipts: readonly ContextReceipt[]): ContextReceipt[] {
    const imported: ContextReceipt[] = [];
    for (const candidate of receipts) {
      const receipt = sanitizeContextReceipt(candidate);
      const previous = this.receipts.get(receipt.id);
      if (previous && !sameReceipt(previous, receipt)) {
        throw new Error(
          `Context receipt ${receipt.id} conflicts with persisted metadata`,
        );
      }
      if (previous) continue;
      const cloned = cloneReceipt(receipt);
      this.receipts.set(cloned.id, cloned);
      imported.push(cloneReceipt(cloned));
    }
    while (this.receipts.size > this.capacity) {
      this.receipts.delete(this.receipts.keys().next().value!);
    }
    if (imported.length) {
      this.persist?.([...this.receipts.values()].map(cloneReceipt));
    }
    return imported;
  }

  get(receiptID: string): ContextReceipt | undefined {
    const receipt = this.receipts.get(receiptID);
    return receipt ? cloneReceipt(receipt) : undefined;
  }

  forSession(sessionID: string): ContextReceipt[] {
    return [...this.receipts.values()].filter((receipt) =>
      receipt.sessionID === sessionID
    ).sort((left, right) => left.admittedAt - right.admittedAt).map(
      cloneReceipt,
    );
  }
}
