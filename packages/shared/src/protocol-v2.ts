import {
  PROTOCOL_V2_ERROR_CODES,
  PROTOCOL_V2_SCHEMA_SOURCE,
  type ProtocolV2ErrorCode,
  WORKBENCH_CAPABILITIES,
  type WorkbenchCapability,
} from "./protocol-schema.ts";

type JsonRecord = Record<string, unknown>;

export interface ProtocolRange {
  minimum: number;
  maximum: number;
}

export interface HelloMessage {
  protocolRange: ProtocolRange;
  client: { surfaceID: string; extensionVersion: string };
}

export type WorkbenchCapabilities = Record<WorkbenchCapability, boolean>;

export interface RuntimeDescriptor {
  mode: "managed" | "external";
  authority: "opencode";
  opencodeVersion?: string;
  companion: "connected" | "missing" | "incompatible";
  nativeAgentHost: "deferred";
}

export interface ProtocolLimits {
  maxRequestBytes: number;
  maxPendingRequests: number;
  maxEventQueue: number;
  maxStringCharacters: number;
  maxErrorDetailsBytes: number;
}

export interface ReadyMessage {
  protocol: number;
  epoch: string;
  capabilities: WorkbenchCapabilities;
  runtime: RuntimeDescriptor;
  limits: ProtocolLimits;
}

export interface Request<TType extends string = string, TPayload = unknown> {
  protocol: 2;
  kind: "request";
  id: string;
  type: TType;
  sessionID?: string;
  expectedRevision?: number;
  mutationID?: string;
  payload: TPayload;
}

export interface SuccessResponse<TResult = unknown> {
  protocol: 2;
  kind: "response";
  id: string;
  ok: true;
  result: TResult;
}

export interface StructuredError {
  code: ProtocolV2ErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface ErrorResponse {
  protocol: 2;
  kind: "response";
  id: string;
  ok: false;
  error: StructuredError;
}

export type Response<TResult = unknown> =
  | SuccessResponse<TResult>
  | ErrorResponse;

export interface Event<TType extends string = string, TPayload = unknown> {
  protocol: 2;
  kind: "event";
  epoch: string;
  sequence: number;
  type: TType;
  sessionID?: string;
  revision?: number;
  payload: TPayload;
}

export type ProtocolV2Message =
  | HelloMessage
  | ReadyMessage
  | Request
  | Response
  | Event;

export class ProtocolValidationError extends Error {
  readonly code: ProtocolV2ErrorCode;

  constructor(
    message: string,
    code: ProtocolV2ErrorCode = "VALIDATION_FAILED",
  ) {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new ProtocolValidationError(
      `${label} contains unknown field ${unknown}`,
    );
  }
}

function requiredString(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new ProtocolValidationError(
      `${label} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new ProtocolValidationError(
      `${label} must be a safe integer >= ${minimum}`,
    );
  }
  return Number(value);
}

function optionalInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : integer(value, label);
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

function protocol2(value: unknown): 2 {
  if (value !== 2) {
    throw new ProtocolValidationError(
      `Unsupported protocol ${
        String(value)
      }; this endpoint supports protocol 2`,
      "CAPABILITY_UNAVAILABLE",
    );
  }
  return 2;
}

export function parseHelloMessage(value: unknown): HelloMessage {
  const message = record(value, "hello");
  exactKeys(message, ["protocolRange", "client"], "hello");
  const range = record(message.protocolRange, "hello.protocolRange");
  exactKeys(range, ["minimum", "maximum"], "hello.protocolRange");
  const minimum = integer(range.minimum, "hello.protocolRange.minimum", 1);
  const maximum = integer(range.maximum, "hello.protocolRange.maximum", 1);
  if (minimum > maximum) {
    throw new ProtocolValidationError(
      "hello.protocolRange minimum exceeds maximum",
    );
  }
  const client = record(message.client, "hello.client");
  exactKeys(client, ["surfaceID", "extensionVersion"], "hello.client");
  return {
    protocolRange: { minimum, maximum },
    client: {
      surfaceID: requiredString(client.surfaceID, "hello.client.surfaceID"),
      extensionVersion: requiredString(
        client.extensionVersion,
        "hello.client.extensionVersion",
      ),
    },
  };
}

export function negotiateProtocol(range: ProtocolRange): 2 {
  const { minimum, maximum } = PROTOCOL_V2_SCHEMA_SOURCE.protocol;
  if (range.maximum < minimum || range.minimum > maximum) {
    throw new ProtocolValidationError(
      `No compatible Workbench protocol: client supports ${range.minimum}-${range.maximum}; host supports ${minimum}-${maximum}`,
      "CAPABILITY_UNAVAILABLE",
    );
  }
  return 2;
}

export function parseProtocolLimits(value: unknown): ProtocolLimits {
  const limits = record(value, "limits");
  const keys = Object.keys(PROTOCOL_V2_SCHEMA_SOURCE.defaultLimits) as Array<
    keyof ProtocolLimits
  >;
  exactKeys(limits, keys, "limits");
  return Object.fromEntries(
    keys.map((key) => [key, integer(limits[key], `limits.${key}`, 1)]),
  ) as unknown as ProtocolLimits;
}

export function parseCapabilities(value: unknown): WorkbenchCapabilities {
  const capabilities = record(value, "capabilities");
  exactKeys(capabilities, WORKBENCH_CAPABILITIES, "capabilities");
  const result = Object.create(null) as WorkbenchCapabilities;
  for (const capability of WORKBENCH_CAPABILITIES) {
    if (typeof capabilities[capability] !== "boolean") {
      throw new ProtocolValidationError(
        `capabilities.${capability} must be boolean`,
      );
    }
    result[capability] = capabilities[capability] as boolean;
  }
  return result;
}

export function capabilitiesForRuntime(
  mode: RuntimeDescriptor["mode"],
  companion: RuntimeDescriptor["companion"],
): WorkbenchCapabilities {
  const values = Object.fromEntries(
    WORKBENCH_CAPABILITIES.map((capability) => [capability, true]),
  ) as WorkbenchCapabilities;
  values["native.agentHost"] = false;
  const companionAvailable = companion === "connected";
  values["goal.lifecycle"] = companionAvailable;
  values["preference.memory"] = companionAvailable;
  values["skill.candidates"] = companionAvailable;
  values["context.editorBridge"] = mode === "managed" && companionAvailable;
  return values;
}

export function parseRuntimeDescriptor(value: unknown): RuntimeDescriptor {
  const runtime = record(value, "runtime");
  exactKeys(runtime, [
    "mode",
    "authority",
    "opencodeVersion",
    "companion",
    "nativeAgentHost",
  ], "runtime");
  if (runtime.mode !== "managed" && runtime.mode !== "external") {
    throw new ProtocolValidationError(
      "runtime.mode must be managed or external",
    );
  }
  if (runtime.authority !== "opencode") {
    throw new ProtocolValidationError("runtime.authority must be opencode");
  }
  if (
    !["connected", "missing", "incompatible"].includes(
      String(runtime.companion),
    )
  ) throw new ProtocolValidationError("runtime.companion is invalid");
  if (runtime.nativeAgentHost !== "deferred") {
    throw new ProtocolValidationError(
      "runtime.nativeAgentHost must be deferred",
    );
  }
  return {
    mode: runtime.mode,
    authority: "opencode",
    opencodeVersion: optionalString(
      runtime.opencodeVersion,
      "runtime.opencodeVersion",
    ),
    companion: runtime.companion as RuntimeDescriptor["companion"],
    nativeAgentHost: "deferred",
  };
}

export function parseReadyMessage(value: unknown): ReadyMessage {
  const message = record(value, "ready");
  exactKeys(
    message,
    ["protocol", "epoch", "capabilities", "runtime", "limits"],
    "ready",
  );
  return {
    protocol: protocol2(message.protocol),
    epoch: requiredString(message.epoch, "ready.epoch"),
    capabilities: parseCapabilities(message.capabilities),
    runtime: parseRuntimeDescriptor(message.runtime),
    limits: parseProtocolLimits(message.limits),
  };
}

export function parseRequest(value: unknown): Request {
  const message = record(value, "request");
  exactKeys(message, [
    "protocol",
    "kind",
    "id",
    "type",
    "sessionID",
    "expectedRevision",
    "mutationID",
    "payload",
  ], "request");
  if (message.kind !== "request") {
    throw new ProtocolValidationError("request.kind must be request");
  }
  if (!("payload" in message)) {
    throw new ProtocolValidationError("request.payload is required");
  }
  return {
    protocol: protocol2(message.protocol),
    kind: "request",
    id: requiredString(message.id, "request.id"),
    type: requiredString(message.type, "request.type"),
    sessionID: optionalString(message.sessionID, "request.sessionID"),
    expectedRevision: optionalInteger(
      message.expectedRevision,
      "request.expectedRevision",
    ),
    mutationID: optionalString(message.mutationID, "request.mutationID"),
    payload: message.payload,
  };
}

export function encodedBytes(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ProtocolValidationError(
      "Protocol value is not JSON serializable",
    );
  }
  if (serialized === undefined) {
    throw new ProtocolValidationError(
      "Protocol value is not JSON serializable",
    );
  }
  return new TextEncoder().encode(serialized).byteLength;
}

export function parseStructuredError(
  value: unknown,
  limits: ProtocolLimits = PROTOCOL_V2_SCHEMA_SOURCE.defaultLimits,
): StructuredError {
  const error = record(value, "error");
  exactKeys(error, ["code", "message", "retryable", "details"], "error");
  if (!PROTOCOL_V2_ERROR_CODES.includes(error.code as ProtocolV2ErrorCode)) {
    throw new ProtocolValidationError("error.code is not recognized");
  }
  if (typeof error.retryable !== "boolean") {
    throw new ProtocolValidationError("error.retryable must be boolean");
  }
  if (
    error.details !== undefined &&
    encodedBytes(error.details) > limits.maxErrorDetailsBytes
  ) {
    throw new ProtocolValidationError(
      "error.details exceeds maxErrorDetailsBytes",
    );
  }
  return {
    code: error.code as ProtocolV2ErrorCode,
    message: requiredString(error.message, "error.message", 20_000),
    retryable: error.retryable,
    details: error.details,
  };
}

export function parseResponse(value: unknown): Response {
  const message = record(value, "response");
  if (message.kind !== "response") {
    throw new ProtocolValidationError("response.kind must be response");
  }
  if (message.ok === true) {
    exactKeys(
      message,
      ["protocol", "kind", "id", "ok", "result"],
      "success response",
    );
    if (!("result" in message)) {
      throw new ProtocolValidationError("success response.result is required");
    }
    return {
      protocol: protocol2(message.protocol),
      kind: "response",
      id: requiredString(message.id, "response.id"),
      ok: true,
      result: message.result,
    };
  }
  if (message.ok === false) {
    exactKeys(
      message,
      ["protocol", "kind", "id", "ok", "error"],
      "error response",
    );
    return {
      protocol: protocol2(message.protocol),
      kind: "response",
      id: requiredString(message.id, "response.id"),
      ok: false,
      error: parseStructuredError(message.error),
    };
  }
  throw new ProtocolValidationError("response.ok must be boolean");
}

export function parseEvent(value: unknown): Event {
  const message = record(value, "event");
  exactKeys(message, [
    "protocol",
    "kind",
    "epoch",
    "sequence",
    "type",
    "sessionID",
    "revision",
    "payload",
  ], "event");
  if (message.kind !== "event") {
    throw new ProtocolValidationError("event.kind must be event");
  }
  if (!("payload" in message)) {
    throw new ProtocolValidationError("event.payload is required");
  }
  return {
    protocol: protocol2(message.protocol),
    kind: "event",
    epoch: requiredString(message.epoch, "event.epoch"),
    // Snapshot control events describe the current position and can therefore
    // legitimately use the initial sequence (zero). Ordered mutations still
    // begin at one in SequencedEventLog.
    sequence: integer(message.sequence, "event.sequence"),
    type: requiredString(message.type, "event.type"),
    sessionID: optionalString(message.sessionID, "event.sessionID"),
    revision: optionalInteger(message.revision, "event.revision"),
    payload: message.payload,
  };
}

export function parseProtocolMessage(value: unknown): ProtocolV2Message {
  const message = record(value, "message");
  if (message.kind === "request") return parseRequest(message);
  if (message.kind === "response") return parseResponse(message);
  if (message.kind === "event") return parseEvent(message);
  if ("protocolRange" in message) return parseHelloMessage(message);
  if ("capabilities" in message && "runtime" in message) {
    return parseReadyMessage(message);
  }
  throw new ProtocolValidationError("Unrecognized protocol message envelope");
}

export function enforceProtocolLimits(
  value: unknown,
  limits: ProtocolLimits,
): void {
  if (encodedBytes(value) > limits.maxRequestBytes) {
    throw new ProtocolValidationError(
      "Protocol message exceeds maxRequestBytes",
      "OVERLOADED",
    );
  }
  const visit = (entry: unknown): void => {
    if (
      typeof entry === "string" && entry.length > limits.maxStringCharacters
    ) {
      throw new ProtocolValidationError(
        "Protocol string exceeds maxStringCharacters",
      );
    }
    if (Array.isArray(entry)) { for (const item of entry) visit(item); }
    else if (typeof entry === "object" && entry !== null) {
      for (const item of Object.values(entry)) {
        visit(item);
      }
    }
  };
  visit(value);
}

export function structuredError(
  code: ProtocolV2ErrorCode,
  message: string,
  retryable: boolean,
  details?: unknown,
): StructuredError {
  return parseStructuredError({
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details }),
  });
}
