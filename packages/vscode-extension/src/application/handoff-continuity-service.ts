import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  type ContextReceipt,
  type EvidenceReference,
  sanitizeContextReceipt,
} from "@opencode-workbench/shared";
import { normalizeEvidenceReference } from "./evidence-service.js";
import type { GitRunner } from "./worktree-service.js";
import { processLockCanBeReclaimed } from "./process-lock.js";

export const HANDOFF_CONTINUITY_LIMITS = Object.freeze({
  records: 128,
  receiptsPerRecord: 20,
  evidencePerRecord: 200,
  originReceiptIDsPerRecord: 20,
  recordBytes: 512 * 1024,
  registryBytes: 2 * 1024 * 1024,
  ttlMilliseconds: 30 * 24 * 60 * 60 * 1_000,
});

const AUTHORIZATION_VALUE =
  /\b((?:proxy-)?authorization\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/gi;
const COOKIE_VALUE = /\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi;
const SECRET_VALUE =
  /\b((?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|authorization|cookie|password|secret|token|credential|signature|sig|sas)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi;
const KNOWN_TOKEN =
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]+/g;
const STORE_DIRECTORY = "opencode-workbench";
const STORE_FILENAME = "handoff-continuity-v1.json";
const LOCK_STALE_MILLISECONDS = 10_000;
const LOCK_TIMEOUT_MILLISECONDS = 3_000;

type JsonRecord = Record<string, unknown>;

export type HandoffContinuityErrorCode =
  | "INVALID_METADATA"
  | "CORRUPT_STORE"
  | "UNSUPPORTED_STORE"
  | "STORE_LIMIT"
  | "INSECURE_STORE"
  | "LOCK_TIMEOUT";

export class HandoffContinuityError extends Error {
  constructor(readonly code: HandoffContinuityErrorCode, message: string) {
    super(message);
    this.name = "HandoffContinuityError";
  }
}

export interface HandoffContinuityRecord {
  id: string;
  targetDirectory: string;
  targetSessionID: string;
  originReceiptIDs: string[];
  receipts: ContextReceipt[];
  evidence: EvidenceReference[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface HandoffContinuityRegistry {
  version: 1;
  records: HandoffContinuityRecord[];
}

export interface HandoffStoreMutation<T> {
  registry: HandoffContinuityRegistry;
  value: T;
}

export interface HandoffContinuityStore {
  read(): Promise<unknown>;
  transact<T>(
    mutation: (current: unknown) => HandoffStoreMutation<T>,
  ): Promise<T>;
}

export interface ExportHandoffInput {
  targetDirectory: string;
  targetSessionID: string;
  /** Establishes a session continuity record before it has receipts/evidence. */
  trackingOnly?: boolean;
  originReceiptIDs?: readonly string[];
  receipts?: readonly ContextReceipt[];
  evidence?: readonly EvidenceReference[];
}

export interface ImportHandoffResult {
  records: HandoffContinuityRecord[];
  receipts: ContextReceipt[];
  evidence: EvidenceReference[];
  limitations: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HandoffContinuityError(
      "INVALID_METADATA",
      "Handoff clock is invalid",
    );
  }
  return value;
}

function redactMetadata(value: string, limit: number, label: string): string {
  if (!value.trim() || value.length > limit) {
    throw new HandoffContinuityError(
      "INVALID_METADATA",
      `${label} must contain 1-${limit} characters`,
    );
  }
  return value
    .replace(PRIVATE_KEY, "[redacted-private-key]")
    .replace(AUTHORIZATION_VALUE, "$1[redacted]")
    .replace(COOKIE_VALUE, "$1[redacted]")
    .replace(SECRET_VALUE, "$1[redacted]")
    .replace(URL_CREDENTIAL, "$1[redacted]@")
    .replace(KNOWN_TOKEN, "[redacted-token]")
    .replace(CONTROL_CHARACTER, " ")
    .trim()
    .slice(0, limit);
}

function boundedOpaque(value: string, limit: number, label: string): string {
  const normalized = value.trim();
  if (
    !normalized || normalized.length > limit ||
    CONTROL_CHARACTER.test(normalized)
  ) {
    CONTROL_CHARACTER.lastIndex = 0;
    throw new HandoffContinuityError(
      "INVALID_METADATA",
      `${label} must contain 1-${limit} safe characters`,
    );
  }
  CONTROL_CHARACTER.lastIndex = 0;
  if (redactMetadata(normalized, limit, label) !== normalized) {
    throw new HandoffContinuityError(
      "INVALID_METADATA",
      `${label} appears to contain a credential`,
    );
  }
  return normalized;
}

function normalizedDirectory(
  value: string,
  label = "Target directory",
): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new HandoffContinuityError(
      "INVALID_METADATA",
      `${label} cannot have leading or trailing whitespace`,
    );
  }
  const bounded = boundedOpaque(value, 8_192, label);
  if (!path.isAbsolute(bounded)) {
    throw new HandoffContinuityError(
      "INVALID_METADATA",
      `${label} must be absolute`,
    );
  }
  return path.normalize(path.resolve(bounded));
}

function directoryKey(value: string): string {
  const normalized = normalizedDirectory(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safeReceiptURI(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 4_096 || CONTROL_CHARACTER.test(value)) {
    CONTROL_CHARACTER.lastIndex = 0;
    return undefined;
  }
  CONTROL_CHARACTER.lastIndex = 0;
  try {
    if (redactMetadata(value, 4_096, "Context URI") !== value) return undefined;
    const parsed = new URL(value);
    if (
      !["file:", "http:", "https:"].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.search || parsed.hash
    ) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function sanitizeContinuityReceipt(candidate: ContextReceipt): ContextReceipt {
  const receipt = sanitizeContextReceipt(candidate);
  return sanitizeContextReceipt({
    ...receipt,
    id: boundedOpaque(receipt.id, 1_024, "Receipt ID"),
    sessionID: boundedOpaque(receipt.sessionID, 1_024, "Session ID"),
    promptID: boundedOpaque(receipt.promptID, 1_024, "Prompt ID"),
    items: receipt.items.map((item) => ({
      ...item,
      id: boundedOpaque(item.id, 1_024, "Context item ID"),
      label: redactMetadata(item.label, 1_024, "Context label"),
      uri: safeReceiptURI(item.uri),
      range: item.range ? { ...item.range } : undefined,
      revision: item.revision === undefined
        ? undefined
        : boundedOpaque(item.revision, 256, "Context revision"),
      contentHash: item.contentHash === undefined
        ? undefined
        : boundedOpaque(item.contentHash, 256, "Context hash"),
    })),
  });
}

function sanitizeContinuityEvidence(
  candidate: EvidenceReference,
): EvidenceReference {
  const evidence = normalizeEvidenceReference(candidate);
  return normalizeEvidenceReference({
    ...evidence,
    id: boundedOpaque(evidence.id, 1_024, "Evidence ID"),
    label: redactMetadata(evidence.label, 1_024, "Evidence label"),
    summary: redactMetadata(evidence.summary, 4_000, "Evidence summary"),
    sourceID: evidence.sourceID === undefined
      ? undefined
      : boundedOpaque(evidence.sourceID, 1_024, "Evidence source ID"),
    sessionID: evidence.sessionID === undefined
      ? undefined
      : boundedOpaque(evidence.sessionID, 1_024, "Evidence session ID"),
    runGroupID: evidence.runGroupID === undefined
      ? undefined
      : boundedOpaque(evidence.runGroupID, 1_024, "Evidence run-group ID"),
    runID: evidence.runID === undefined
      ? undefined
      : boundedOpaque(evidence.runID, 1_024, "Evidence run ID"),
    repository: evidence.repository === undefined
      ? undefined
      : normalizedDirectory(evidence.repository, "Evidence repository"),
  });
}

function recordID(targetDirectory: string, targetSessionID: string): string {
  const digest = createHash("sha256").update(directoryKey(targetDirectory))
    .update("\0").update(targetSessionID).digest("hex");
  return `handoff:${digest.slice(0, 32)}`;
}

function compactContinuityEvidence(
  entries: EvidenceReference[],
  targetSessionID: string,
  handoffID: string,
): EvidenceReference[] {
  const markerID = `continuity-evidence-limit:${handoffID.slice("handoff:".length)}`;
  const previousMarker = entries.find((entry) => entry.id === markerID);
  const evidence = entries.filter((entry) => entry.id !== markerID);
  if (evidence.length <= HANDOFF_CONTINUITY_LIMITS.evidencePerRecord && !previousMarker) return evidence;
  const keep = evidence.slice().sort((left, right) =>
    right.observedAt - left.observedAt || left.id.localeCompare(right.id)
  ).slice(0, HANDOFF_CONTINUITY_LIMITS.evidencePerRecord - 1);
  const marker = previousMarker ?? sanitizeContinuityEvidence({
    id: markerID,
    kind: "criterion",
    label: "Cross-workspace evidence limit",
    status: "warning",
    observedAt: 0,
    sourceID: handoffID,
    sessionID: targetSessionID,
    summary: "Older evidence references were omitted from the bounded cross-workspace ledger. The complete durable evidence history remains in its source workspace.",
  });
  return [...keep, marker];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeImmutable<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  label: string,
): T[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const previous = merged.get(entry.id);
    if (previous && !sameValue(previous, entry)) {
      throw new HandoffContinuityError(
        "INVALID_METADATA",
        `${label} ${entry.id} changed after publication`,
      );
    }
    if (!previous) merged.set(entry.id, entry);
  }
  return [...merged.values()];
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

function cloneEvidence(evidence: EvidenceReference): EvidenceReference {
  return { ...evidence };
}

function cloneRecord(record: HandoffContinuityRecord): HandoffContinuityRecord {
  return {
    ...record,
    originReceiptIDs: [...record.originReceiptIDs],
    receipts: record.receipts.map(cloneReceipt),
    evidence: record.evidence.map(cloneEvidence),
  };
}

function emptyRegistry(): HandoffContinuityRegistry {
  return { version: 1, records: [] };
}

function parseRecord(
  value: unknown,
  now: number,
): HandoffContinuityRecord | undefined {
  if (
    !isRecord(value) || !Array.isArray(value.originReceiptIDs) ||
    !Array.isArray(value.receipts) || !Array.isArray(value.evidence)
  ) return undefined;
  if (
    value.originReceiptIDs.length >
      HANDOFF_CONTINUITY_LIMITS.originReceiptIDsPerRecord ||
    value.receipts.length > HANDOFF_CONTINUITY_LIMITS.receiptsPerRecord ||
    value.evidence.length > HANDOFF_CONTINUITY_LIMITS.evidencePerRecord
  ) return undefined;
  try {
    const targetDirectory = normalizedDirectory(
      value.targetDirectory as string,
    );
    const targetSessionID = boundedOpaque(
      value.targetSessionID as string,
      1_024,
      "Target session ID",
    );
    const createdAt = Number(value.createdAt);
    const updatedAt = Number(value.updatedAt);
    const expiresAt = Number(value.expiresAt);
    if (
      ![createdAt, updatedAt, expiresAt].every((item) =>
        Number.isSafeInteger(item) && item >= 0
      ) || createdAt > updatedAt || updatedAt > expiresAt ||
      updatedAt > now + 300_000 ||
      expiresAt - updatedAt > HANDOFF_CONTINUITY_LIMITS.ttlMilliseconds
    ) return undefined;
    if (expiresAt <= now) return undefined;
    const record: HandoffContinuityRecord = {
      id: boundedOpaque(value.id as string, 128, "Handoff ID"),
      targetDirectory,
      targetSessionID,
      originReceiptIDs: value.originReceiptIDs.map((item) =>
        boundedOpaque(item as string, 1_024, "Origin receipt ID")
      ),
      receipts: value.receipts.map((item) =>
        sanitizeContinuityReceipt(item as ContextReceipt)
      ),
      evidence: value.evidence.map((item) =>
        sanitizeContinuityEvidence(item as EvidenceReference)
      ),
      createdAt,
      updatedAt,
      expiresAt,
    };
    if (
      record.id !== recordID(targetDirectory, targetSessionID) ||
      record.receipts.some((receipt) =>
        receipt.sessionID !== targetSessionID
      ) || encodedBytes(record) > HANDOFF_CONTINUITY_LIMITS.recordBytes
    ) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

function parseRegistry(
  value: unknown,
  now: number,
): { registry: HandoffContinuityRegistry; limitations: string[] } {
  if (value === undefined) {
    return { registry: emptyRegistry(), limitations: [] };
  }
  if (!isRecord(value)) {
    throw new HandoffContinuityError(
      "CORRUPT_STORE",
      "Cross-workspace handoff metadata is not an object",
    );
  }
  if (value.version !== 1) {
    throw new HandoffContinuityError(
      "UNSUPPORTED_STORE",
      "Cross-workspace handoff metadata uses an unsupported schema version",
    );
  }
  if (!Array.isArray(value.records)) {
    throw new HandoffContinuityError(
      "CORRUPT_STORE",
      "Cross-workspace handoff metadata has no record list",
    );
  }
  const limitations: string[] = [];
  const records = new Map<string, HandoffContinuityRecord>();
  for (
    const valueRecord of value.records.slice(
      0,
      HANDOFF_CONTINUITY_LIMITS.records * 2,
    )
  ) {
    const record = parseRecord(valueRecord, now);
    if (!record) {
      limitations.push("One invalid or expired handoff record was ignored.");
      continue;
    }
    const previous = records.get(record.id);
    if (previous && !sameValue(previous, record)) {
      limitations.push("One conflicting handoff record was ignored.");
      continue;
    }
    records.set(record.id, record);
  }
  const retained = [...records.values()].sort((left, right) =>
    right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
  ).slice(0, HANDOFF_CONTINUITY_LIMITS.records);
  if (records.size > retained.length) {
    limitations.push("Excess handoff records were ignored.");
  }
  if (value.records.length > HANDOFF_CONTINUITY_LIMITS.records * 2) {
    limitations.push("Excess handoff records were ignored.");
  }
  return {
    registry: { version: 1, records: retained },
    limitations: [...new Set(limitations)],
  };
}

export function rebindContextReceiptForHandoff(
  source: ContextReceipt,
  targetSessionID: string,
  targetPromptID: string,
  admittedAt = Date.now(),
): ContextReceipt {
  const receipt = sanitizeContinuityReceipt(source);
  const promptID = boundedOpaque(targetPromptID, 1_016, "Target prompt ID");
  return sanitizeContinuityReceipt({
    ...receipt,
    id: `context:${promptID}`,
    sessionID: boundedOpaque(targetSessionID, 1_024, "Target session ID"),
    promptID,
    admittedAt,
    items: receipt.items.map((item) => ({
      ...item,
      range: item.range ? { ...item.range } : undefined,
    })),
  });
}

export class HandoffContinuityService {
  private writeTail: Promise<void> = Promise.resolve();
  private queuedWriteFailure: unknown;

  constructor(
    private readonly store: HandoffContinuityStore,
    private readonly clock: () => number = Date.now,
  ) {}

  async exportHandoff(
    input: ExportHandoffInput,
  ): Promise<HandoffContinuityRecord> {
    return await this.enqueueWrite(() => this.exportHandoffOnce(input));
  }

  queueHandoff(input: ExportHandoffInput): void {
    void this.enqueueWrite(
      () => this.exportHandoffOnce(input),
      true,
    ).catch(() => undefined);
  }

  private async exportHandoffOnce(
    input: ExportHandoffInput,
  ): Promise<HandoffContinuityRecord> {
    const now = boundedTime(this.clock());
    const expiresAt = boundedTime(
      now + HANDOFF_CONTINUITY_LIMITS.ttlMilliseconds,
    );
    if (
      (input.receipts?.length ?? 0) >
        HANDOFF_CONTINUITY_LIMITS.receiptsPerRecord ||
      (input.evidence?.length ?? 0) >
        HANDOFF_CONTINUITY_LIMITS.evidencePerRecord ||
      (input.originReceiptIDs?.length ?? 0) >
        HANDOFF_CONTINUITY_LIMITS.originReceiptIDsPerRecord
    ) {
      throw new HandoffContinuityError(
        "STORE_LIMIT",
        "Cross-workspace handoff input exceeds its item limits",
      );
    }
    const targetDirectory = normalizedDirectory(input.targetDirectory);
    const targetSessionID = boundedOpaque(
      input.targetSessionID,
      1_024,
      "Target session ID",
    );
    const receipts = (input.receipts ?? []).map(sanitizeContinuityReceipt);
    if (receipts.some((receipt) => receipt.sessionID !== targetSessionID)) {
      throw new HandoffContinuityError(
        "INVALID_METADATA",
        "A handoff receipt belongs to a different session",
      );
    }
    const evidence = (input.evidence ?? []).map(sanitizeContinuityEvidence);
    const originReceiptIDs = [
      ...new Set(
        (input.originReceiptIDs ?? []).map((id) =>
          boundedOpaque(id, 1_024, "Origin receipt ID")
        ),
      ),
    ];
    if (!receipts.length && !evidence.length && input.trackingOnly !== true) {
      throw new HandoffContinuityError(
        "INVALID_METADATA",
        "A handoff must contain receipt or evidence metadata",
      );
    }
    const id = recordID(targetDirectory, targetSessionID);

    return await this.store.transact((current) => {
      const parsed = parseRegistry(current, now);
      const previous = parsed.registry.records.find((record) =>
        record.id === id
      );
      const merged: HandoffContinuityRecord = {
        id,
        targetDirectory,
        targetSessionID,
        originReceiptIDs: [
          ...new Set([
            ...(previous?.originReceiptIDs ?? []),
            ...originReceiptIDs,
          ]),
        ],
        receipts: mergeImmutable(
          previous?.receipts ?? [],
          receipts,
          "Context receipt",
        ).sort((left, right) =>
          left.admittedAt - right.admittedAt ||
          left.id.localeCompare(right.id)
        ),
        evidence: compactContinuityEvidence(mergeImmutable(
          previous?.evidence ?? [],
          evidence,
          "Evidence reference",
        ), targetSessionID, id).sort((left, right) =>
          left.observedAt - right.observedAt ||
          left.id.localeCompare(right.id)
        ),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        expiresAt,
      };
      if (
        merged.originReceiptIDs.length >
          HANDOFF_CONTINUITY_LIMITS.originReceiptIDsPerRecord ||
        merged.receipts.length >
          HANDOFF_CONTINUITY_LIMITS.receiptsPerRecord ||
        merged.evidence.length >
          HANDOFF_CONTINUITY_LIMITS.evidencePerRecord ||
        encodedBytes(merged) > HANDOFF_CONTINUITY_LIMITS.recordBytes
      ) {
        throw new HandoffContinuityError(
          "STORE_LIMIT",
          "Cross-workspace handoff record exceeds its explicit limit",
        );
      }
      let records = [
        merged,
        ...parsed.registry.records.filter((record) => record.id !== id).sort((
          left,
          right,
        ) => right.updatedAt - left.updatedAt),
      ].slice(0, HANDOFF_CONTINUITY_LIMITS.records);
      let registry: HandoffContinuityRegistry = { version: 1, records };
      while (
        encodedBytes(registry) > HANDOFF_CONTINUITY_LIMITS.registryBytes &&
        records.length > 1
      ) {
        records = records.slice(0, -1);
        registry = { version: 1, records };
      }
      if (encodedBytes(registry) > HANDOFF_CONTINUITY_LIMITS.registryBytes) {
        throw new HandoffContinuityError(
          "STORE_LIMIT",
          "Cross-workspace handoff registry exceeds its explicit byte limit",
        );
      }
      return { registry, value: cloneRecord(merged) };
    });
  }

  async importHandoff(
    targetDirectory: string,
    targetSessionID?: string,
  ): Promise<ImportHandoffResult> {
    await this.flush();
    const now = boundedTime(this.clock());
    const key = directoryKey(targetDirectory);
    const sessionID = targetSessionID === undefined
      ? undefined
      : boundedOpaque(targetSessionID, 1_024, "Target session ID");
    let parsed: { registry: HandoffContinuityRegistry; limitations: string[] };
    try {
      parsed = parseRegistry(await this.store.read(), now);
    } catch (error) {
      if (
        error instanceof HandoffContinuityError &&
        error.code === "CORRUPT_STORE"
      ) {
        return {
          records: [],
          receipts: [],
          evidence: [],
          limitations: [error.message],
        };
      }
      throw error;
    }
    const records = parsed.registry.records.filter((record) =>
      directoryKey(record.targetDirectory) === key &&
      (sessionID === undefined || record.targetSessionID === sessionID)
    ).map(cloneRecord);
    const receipts = mergeImmutable(
      [],
      records.flatMap((record) => record.receipts),
      "Context receipt",
    ).map(cloneReceipt);
    const evidence = mergeImmutable(
      [],
      records.flatMap((record) => record.evidence),
      "Evidence reference",
    ).map(cloneEvidence);
    return { records, receipts, evidence, limitations: parsed.limitations };
  }

  async removeHandoff(
    targetDirectory: string,
    targetSessionID?: string,
  ): Promise<number> {
    return await this.enqueueWrite(() =>
      this.removeHandoffOnce(targetDirectory, targetSessionID)
    );
  }

  private async removeHandoffOnce(
    targetDirectory: string,
    targetSessionID?: string,
  ): Promise<number> {
    const now = boundedTime(this.clock());
    const key = directoryKey(targetDirectory);
    const sessionID = targetSessionID === undefined
      ? undefined
      : boundedOpaque(targetSessionID, 1_024, "Target session ID");
    return await this.store.transact((current) => {
      const parsed = parseRegistry(current, now);
      const retained = parsed.registry.records.filter((record) =>
        directoryKey(record.targetDirectory) !== key ||
        (sessionID !== undefined && record.targetSessionID !== sessionID)
      );
      return {
        registry: { version: 1, records: retained },
        value: parsed.registry.records.length - retained.length,
      };
    });
  }

  async flush(): Promise<void> {
    await this.writeTail;
    if (this.queuedWriteFailure !== undefined) {
      const failure = this.queuedWriteFailure;
      this.queuedWriteFailure = undefined;
      throw failure;
    }
  }

  async dispose(): Promise<void> {
    await this.flush();
  }

  private enqueueWrite<T>(
    operation: () => Promise<T>,
    retainFailure = false,
  ): Promise<T> {
    const scheduled = this.writeTail.then(operation, operation);
    this.writeTail = scheduled.then(
      () => undefined,
      (error) => {
        if (retainFailure && this.queuedWriteFailure === undefined) {
          this.queuedWriteFailure = error;
        }
      },
    );
    return scheduled;
  }
}

export class GitCommonDirectoryHandoffStore implements HandoffContinuityStore {
  readonly registryPath: string;
  private readonly metadataDirectory: string;

  private constructor(readonly commonDirectory: string) {
    this.metadataDirectory = path.join(commonDirectory, STORE_DIRECTORY);
    this.registryPath = path.join(this.metadataDirectory, STORE_FILENAME);
  }

  static async create(
    git: GitRunner,
    repositoryDirectory: string,
  ): Promise<GitCommonDirectoryHandoffStore> {
    const output = await git.run([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ], normalizedDirectory(repositoryDirectory, "Repository directory"));
    const reported = output.stdout.replace(/\r?\n$/, "");
    if (!reported || /[\r\n]/.test(reported) || !path.isAbsolute(reported)) {
      throw new HandoffContinuityError(
        "INVALID_METADATA",
        "Git did not return an absolute common directory",
      );
    }
    const commonDirectory = await fs.realpath(reported);
    return new GitCommonDirectoryHandoffStore(commonDirectory);
  }

  async read(): Promise<unknown> {
    try {
      await this.validateExistingDirectory();
      return await this.readUnlocked();
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  async transact<T>(
    mutation: (current: unknown) => HandoffStoreMutation<T>,
  ): Promise<T> {
    await this.ensurePrivateDirectory();
    const release = await this.acquireLock();
    try {
      const current = await this.readUnlocked();
      const result = mutation(current);
      const serialized = `${JSON.stringify(result.registry)}\n`;
      if (
        Buffer.byteLength(serialized, "utf8") >
          HANDOFF_CONTINUITY_LIMITS.registryBytes
      ) {
        throw new HandoffContinuityError(
          "STORE_LIMIT",
          "Cross-workspace handoff registry exceeds its on-disk limit",
        );
      }
      await this.writeAtomic(serialized);
      return result.value;
    } finally {
      await release();
    }
  }

  private async validateExistingDirectory(): Promise<void> {
    const info = await fs.lstat(this.metadataDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new HandoffContinuityError(
        "INSECURE_STORE",
        "Cross-workspace handoff metadata directory is not a private directory",
      );
    }
    const actual = await fs.realpath(this.metadataDirectory);
    if (
      actual !== this.metadataDirectory ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
      throw new HandoffContinuityError(
        "INSECURE_STORE",
        "Cross-workspace handoff metadata directory has unsafe permissions or indirection",
      );
    }
  }

  private async ensurePrivateDirectory(): Promise<void> {
    await fs.mkdir(this.metadataDirectory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.metadataDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new HandoffContinuityError(
        "INSECURE_STORE",
        "Cross-workspace handoff metadata directory is not a directory",
      );
    }
    const actual = await fs.realpath(this.metadataDirectory);
    if (actual !== this.metadataDirectory) {
      throw new HandoffContinuityError(
        "INSECURE_STORE",
        "Cross-workspace handoff metadata directory cannot be a symbolic link",
      );
    }
    await fs.chmod(this.metadataDirectory, 0o700);
  }

  private async readUnlocked(): Promise<unknown> {
    let info;
    try {
      info = await fs.lstat(this.registryPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new HandoffContinuityError(
        "INSECURE_STORE",
        "Cross-workspace handoff registry is not a regular file",
      );
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new HandoffContinuityError(
        "INSECURE_STORE",
        "Cross-workspace handoff registry is not owner-only",
      );
    }
    if (info.size > HANDOFF_CONTINUITY_LIMITS.registryBytes) {
      throw new HandoffContinuityError(
        "STORE_LIMIT",
        "Cross-workspace handoff registry exceeds its on-disk limit",
      );
    }
    const payload = await fs.readFile(this.registryPath, "utf8");
    if (
      Buffer.byteLength(payload, "utf8") >
        HANDOFF_CONTINUITY_LIMITS.registryBytes
    ) {
      throw new HandoffContinuityError(
        "STORE_LIMIT",
        "Cross-workspace handoff registry exceeds its on-disk limit",
      );
    }
    try {
      return JSON.parse(payload);
    } catch {
      throw new HandoffContinuityError(
        "CORRUPT_STORE",
        "Cross-workspace handoff registry contains invalid JSON",
      );
    }
  }

  private async writeAtomic(payload: string): Promise<void> {
    const temporary = path.join(
      this.metadataDirectory,
      `.${STORE_FILENAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, this.registryPath);
      await fs.chmod(this.registryPath, 0o600);
      if (process.platform !== "win32") {
        const directory = await fs.open(this.metadataDirectory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch((error) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.registryPath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS;
    const owner = `${process.pid}:${randomUUID()}`;
    while (true) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(owner, "utf8");
          await handle.sync();
        } catch (error) {
          await handle.close();
          await fs.unlink(lockPath).catch(() => undefined);
          throw error;
        }
        return async () => {
          await handle.close();
          const current = await fs.readFile(lockPath, "utf8").catch(() => "");
          if (current === owner) {
            await fs.unlink(lockPath).catch((error) => {
              if (errorCode(error) !== "ENOENT") throw error;
            });
          }
        };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        try {
          const info = await fs.lstat(lockPath);
          if (!info.isFile() || info.isSymbolicLink()) {
            throw new HandoffContinuityError(
              "INSECURE_STORE",
              "Cross-workspace handoff lock is not a regular file",
            );
          }
          const currentOwner = await fs.readFile(lockPath, "utf8").catch(() =>
            ""
          );
          if (processLockCanBeReclaimed(currentOwner, info.mtimeMs, Date.now(), LOCK_STALE_MILLISECONDS, processIsAlive)) {
            const confirmedOwner = await fs.readFile(lockPath, "utf8").catch(
              () => "",
            );
            if (confirmedOwner !== currentOwner) continue;
            const quarantine = `${lockPath}.stale-${randomUUID()}`;
            try {
              await fs.rename(lockPath, quarantine);
              await fs.unlink(quarantine);
            } catch (takeoverError) {
              if (errorCode(takeoverError) !== "ENOENT") throw takeoverError;
            }
            continue;
          }
        } catch (statError) {
          if (errorCode(statError) === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new HandoffContinuityError(
            "LOCK_TIMEOUT",
            "Timed out waiting for the cross-workspace handoff registry lock",
          );
        }
        await pause(25);
      }
    }
  }
}
