import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type ContextReceipt,
  type ContextReceiptItem,
  sanitizeDurableMetadataUri,
} from "@opencode-workbench/shared";

const MAX_ID_CHARACTERS = 1_024;
const MAX_DIRECTORY_CHARACTERS = 8_192;
const MAX_URI_CHARACTERS = 4_096;
const MAX_RECEIPT_ITEMS = 100;
const FILE_REVISION = /^(-?(?:0|[1-9]\d*)):(0|[1-9]\d*)$/;

export interface ContextReceiptSourceFileInfo {
  mtimeMs: number;
  size: number;
  isFile(): boolean;
}

/** The complete filesystem authority used by source inspection. It intentionally has no content-reading method. */
export interface ContextReceiptSourceFileSystem {
  realpath(candidate: string): Promise<string>;
  stat(candidate: string): Promise<ContextReceiptSourceFileInfo>;
}

export interface ContextReceiptSourceInspectionInput {
  sessionID: string;
  directory: string;
  receipt: ContextReceipt;
  itemID: string;
}

export interface ContextReceiptSourceInspection {
  receiptID: string;
  itemID: string;
  /** HTTP(S) availability means safely navigable; the service never probes the network. */
  availability: "available" | "unavailable";
  uri?: string;
  range?: ContextReceiptItem["range"];
  storedRevision?: string;
  currentRevision?: string;
  /** Undefined means the receipt did not contain a comparable `mtime:size` revision. */
  stale?: boolean;
}

const nodeFileSystem: ContextReceiptSourceFileSystem = {
  realpath,
  stat,
};

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > MAX_ID_CHARACTERS || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedDirectory(value: unknown): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > MAX_DIRECTORY_CHARACTERS ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw new Error("Context source directory must be a bounded absolute path");
  }
  return path.resolve(value);
}

function resolvedPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > MAX_DIRECTORY_CHARACTERS ||
    /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value)
  ) throw new Error(`${label} is unsafe`);
  return path.resolve(value);
}

function rangeMetadata(
  range: ContextReceiptItem["range"],
): ContextReceiptItem["range"] {
  if (!range) return undefined;
  const { startLine, startColumn, endLine, endColumn } = range;
  if (
    ![startLine, startColumn, endLine, endColumn].every((value) =>
      Number.isSafeInteger(value) && value >= 1
    ) ||
    endLine < startLine || (endLine === startLine && endColumn < startColumn)
  ) {
    throw new Error("Context receipt source range is invalid");
  }
  return { startLine, startColumn, endLine, endColumn };
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
}

function parsedFileRevision(value: string | undefined): string | undefined {
  if (!value || value.length > 256) return undefined;
  const match = FILE_REVISION.exec(value);
  if (!match) return undefined;
  const mtime = Number(match[1]);
  const size = Number(match[2]);
  if (!Number.isSafeInteger(mtime) || !Number.isSafeInteger(size) || size < 0) {
    return undefined;
  }
  const normalized = `${mtime}:${size}`;
  return normalized === value ? normalized : undefined;
}

function fileRevision(info: ContextReceiptSourceFileInfo): string | undefined {
  const mtime = Math.trunc(info.mtimeMs);
  if (
    !Number.isFinite(info.mtimeMs) || !Number.isSafeInteger(mtime) ||
    !Number.isSafeInteger(info.size) || info.size < 0
  ) return undefined;
  return `${mtime}:${info.size}`;
}

function safeUri(value: string): { uri: string; parsed: URL } {
  if (
    value.length < 1 || value.length > MAX_URI_CHARACTERS ||
    value !== value.trim()
  ) throw new Error("Context receipt source URI is unsafe");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Context receipt source URI is unsafe");
  }
  const sanitized = sanitizeDurableMetadataUri(value);
  if (
    !sanitized || sanitized !== parsed.toString() || parsed.search ||
    parsed.hash || parsed.username || parsed.password ||
    !["file:", "http:", "https:"].includes(parsed.protocol)
  ) {
    throw new Error("Context receipt source URI is unsafe");
  }
  return { uri: sanitized, parsed };
}

function receiptItem(
  input: ContextReceiptSourceInspectionInput,
): ContextReceiptItem {
  const sessionID = boundedIdentifier(
    input.sessionID,
    "Context source session ID",
  );
  const receiptSessionID = boundedIdentifier(
    input.receipt.sessionID,
    "Context receipt session ID",
  );
  if (receiptSessionID !== sessionID) {
    throw new Error("Context receipt does not belong to the requested session");
  }
  const itemID = boundedIdentifier(input.itemID, "Context source item ID");
  if (
    !Array.isArray(input.receipt.items) ||
    input.receipt.items.length > MAX_RECEIPT_ITEMS
  ) throw new Error("Context receipt item limit exceeded");
  const matches = input.receipt.items.filter((item) => item?.id === itemID);
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? "Context receipt item ID is ambiguous"
        : "Context receipt item was not found",
    );
  }
  return matches[0]!;
}

function unavailable(
  input: ContextReceiptSourceInspectionInput,
  item: ContextReceiptItem,
  uri?: string,
): ContextReceiptSourceInspection {
  return {
    receiptID: boundedIdentifier(input.receipt.id, "Context receipt ID"),
    itemID: input.itemID,
    availability: "unavailable",
    uri,
    range: rangeMetadata(item.range),
    storedRevision: item.revision,
    stale: undefined,
  };
}

/**
 * Inspects whether one admitted context source can be opened without reading or
 * fetching its content. Unsafe authorities, schemes, and containment escapes
 * are rejected rather than returned to callers as navigable metadata.
 */
export async function inspectContextReceiptSource(
  input: ContextReceiptSourceInspectionInput,
  fileSystem: ContextReceiptSourceFileSystem = nodeFileSystem,
): Promise<ContextReceiptSourceInspection> {
  const item = receiptItem(input);
  const receiptID = boundedIdentifier(input.receipt.id, "Context receipt ID");
  const range = rangeMetadata(item.range);
  if (
    item.revision !== undefined &&
    (typeof item.revision !== "string" || item.revision.length > 256)
  ) throw new Error("Context receipt source revision is invalid");
  if (item.uri === undefined) return unavailable(input, item);
  if (typeof item.uri !== "string") {
    throw new Error("Context receipt source URI is unsafe");
  }

  const source = safeUri(item.uri);
  if (
    source.parsed.protocol === "http:" || source.parsed.protocol === "https:"
  ) {
    return {
      receiptID,
      itemID: input.itemID,
      availability: "available",
      uri: source.uri,
      range,
      storedRevision: item.revision,
      stale: undefined,
    };
  }

  const requestedDirectory = boundedDirectory(input.directory);
  let requestedPath: string;
  try {
    requestedPath = resolvedPath(
      fileURLToPath(source.parsed),
      "Context receipt file path",
    );
  } catch {
    throw new Error("Context receipt file URI is unsafe");
  }
  let canonicalDirectory: string;
  try {
    canonicalDirectory = resolvedPath(
      await fileSystem.realpath(requestedDirectory),
      "Context source directory",
    );
  } catch {
    throw new Error("Context source directory is unavailable");
  }
  if (
    !isContained(requestedDirectory, requestedPath) &&
    !isContained(canonicalDirectory, requestedPath)
  ) {
    throw new Error("Context receipt source escapes the session directory");
  }

  let canonicalSource: string;
  try {
    canonicalSource = resolvedPath(
      await fileSystem.realpath(requestedPath),
      "Context receipt source path",
    );
  } catch {
    return unavailable(input, item, source.uri);
  }
  if (
    !isContained(canonicalDirectory, canonicalSource)
  ) {
    throw new Error("Context receipt source escapes the session directory");
  }

  let info: ContextReceiptSourceFileInfo;
  try {
    info = await fileSystem.stat(canonicalSource);
  } catch {
    return unavailable(input, item, source.uri);
  }
  if (!info.isFile()) return unavailable(input, item, source.uri);

  const storedRevision = parsedFileRevision(item.revision);
  const currentRevision = fileRevision(info);
  return {
    receiptID,
    itemID: input.itemID,
    availability: "available",
    // Return the exact canonical path we inspected. Opening the original URI
    // would leave a symlink-swap window between containment validation and the
    // VS Code open operation.
    uri: pathToFileURL(canonicalSource).toString(),
    range,
    storedRevision: item.revision,
    currentRevision,
    stale: storedRevision !== undefined && currentRevision !== undefined
      ? storedRevision !== currentRevision
      : undefined,
  };
}
