import { randomUUID } from "node:crypto";
import type {
  DiffSnapshot,
  EvidenceReference,
} from "@opencode-workbench/shared";
import { sanitizeDurableMetadataText } from "@opencode-workbench/shared";

export interface EvidenceFilter {
  sessionID?: string;
  runGroupID?: string;
  runID?: string;
  repository?: string;
}

function bounded(
  value: string | undefined,
  limit: number,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > limit) {
    throw new Error(`${label} exceeds its evidence limit`);
  }
  return value;
}

function boundedOpaque(value: string | undefined, limit: number, label: string): string | undefined {
  const normalized = bounded(value, limit, label);
  if (normalized === undefined) return undefined;
  if (sanitizeDurableMetadataText(normalized, limit, label) !== normalized) {
    throw new Error(`${label} contains credential-shaped metadata`);
  }
  return normalized;
}

const EVIDENCE_KINDS = new Set<EvidenceReference["kind"]>([
  "task",
  "terminal",
  "test",
  "diagnostics",
  "diff",
  "todo",
  "criterion",
]);
const EVIDENCE_STATUSES = new Set<EvidenceReference["status"]>([
  "passed",
  "failed",
  "warning",
  "unknown",
]);

export function normalizeEvidenceReference(
  entry: EvidenceReference,
): EvidenceReference {
  if (!EVIDENCE_KINDS.has(entry.kind) || !EVIDENCE_STATUSES.has(entry.status)) {
    throw new Error("Evidence has an invalid kind or status");
  }
  if (!entry.label.trim() || !entry.summary.trim()) {
    throw new Error("Evidence requires a label and summary");
  }
  if (entry.label.length > 1_024 || entry.summary.length > 4_000) {
    throw new Error("Evidence label or summary exceeds its explicit limit");
  }
  if (!Number.isSafeInteger(entry.observedAt) || entry.observedAt < 0) {
    throw new Error("Evidence has an invalid observation time");
  }
  return {
    id: boundedOpaque(entry.id, 1_024, "Evidence ID")!,
    kind: entry.kind,
    label: sanitizeDurableMetadataText(entry.label, 1_024, "Evidence label"),
    status: entry.status,
    observedAt: entry.observedAt,
    sourceID: boundedOpaque(entry.sourceID, 1_024, "Source ID"),
    sessionID: boundedOpaque(entry.sessionID, 1_024, "Session ID"),
    runGroupID: boundedOpaque(entry.runGroupID, 1_024, "Run-group ID"),
    runID: boundedOpaque(entry.runID, 1_024, "Run ID"),
    repository: boundedOpaque(entry.repository, 8_192, "Repository path"),
    summary: sanitizeDurableMetadataText(entry.summary, 4_000, "Evidence summary"),
  };
}

function sameEvidence(
  left: EvidenceReference,
  right: EvidenceReference,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class EvidenceService {
  private readonly entries = new Map<string, EvidenceReference>();

  constructor(
    initial: EvidenceReference[] = [],
    private readonly persist?: (entries: EvidenceReference[]) => void,
    private readonly capacity = 2_000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
      throw new Error("Evidence capacity must be between 1 and 10,000");
    }
    for (const candidate of initial.slice(-capacity)) {
      try {
        const entry = normalizeEvidenceReference(candidate);
        this.entries.delete(entry.id);
        this.entries.set(entry.id, entry);
      } catch {
        // Corrupt metadata must not prevent the Workbench from opening.
      }
    }
  }

  record(
    input: Omit<EvidenceReference, "id" | "observedAt"> & {
      observedAt?: number;
    },
  ): EvidenceReference {
    const entry = normalizeEvidenceReference({
      id: randomUUID(),
      kind: input.kind,
      label: input.label,
      status: input.status,
      observedAt: input.observedAt ?? Date.now(),
      sourceID: input.sourceID,
      sessionID: input.sessionID,
      runGroupID: input.runGroupID,
      runID: input.runID,
      repository: input.repository,
      summary: input.summary,
    });
    this.entries.set(entry.id, entry);
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.persist?.(this.list());
    return { ...entry };
  }

  merge(candidates: readonly EvidenceReference[]): EvidenceReference[] {
    const imported: EvidenceReference[] = [];
    for (const candidate of candidates) {
      const entry = normalizeEvidenceReference(candidate);
      const previous = this.entries.get(entry.id);
      if (previous && !sameEvidence(previous, entry)) {
        throw new Error(
          `Evidence ${entry.id} conflicts with persisted metadata`,
        );
      }
      if (previous) continue;
      this.entries.set(entry.id, entry);
      imported.push({ ...entry });
    }
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    if (imported.length) this.persist?.(this.list());
    return imported;
  }

  recordDiff(
    snapshot: DiffSnapshot,
    scope: Omit<EvidenceFilter, "repository"> = {},
  ): EvidenceReference {
    return this.record({
      kind: "diff",
      label: `${snapshot.scope} diff`,
      status: snapshot.complete ? "passed" : "warning",
      sourceID: snapshot.id,
      repository: snapshot.repository,
      ...scope,
      summary:
        `${snapshot.files.length} changed files · ${snapshot.unifiedDiffHash}${
          snapshot.complete
            ? ""
            : ` · incomplete: ${snapshot.truncationReason ?? "unknown"}`
        }`,
    });
  }

  list(filter: EvidenceFilter = {}): EvidenceReference[] {
    return [...this.entries.values()].filter((entry) => {
      if (
        filter.sessionID !== undefined && entry.sessionID !== filter.sessionID
      ) return false;
      if (
        filter.runGroupID !== undefined &&
        entry.runGroupID !== filter.runGroupID
      ) return false;
      if (filter.runID !== undefined && entry.runID !== filter.runID) {
        return false;
      }
      if (
        filter.repository !== undefined &&
        entry.repository !== filter.repository
      ) return false;
      return true;
    }).map((entry) => ({ ...entry }));
  }
}
