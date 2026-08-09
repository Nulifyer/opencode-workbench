export const PROTOCOL_V2_ERROR_CODES = [
  "VALIDATION_FAILED",
  "CAPABILITY_UNAVAILABLE",
  "STALE_REVISION",
  "SESSION_BUSY",
  "SESSION_NOT_FOUND",
  "WORKSPACE_MISMATCH",
  "UPSTREAM_DISCONNECTED",
  "AUTH_REQUIRED",
  "OPERATION_CONFLICT",
  "OVERLOADED",
  "CANCELLED",
  "TIMEOUT",
  "INTERNAL",
] as const;

export const WORKBENCH_CAPABILITIES = [
  "session.create",
  "session.resume",
  "session.fork",
  "session.delete",
  "prompt.steer",
  "prompt.followUp",
  "prompt.replace",
  "prompt.cancel",
  "input.permissions.exact",
  "input.questions",
  "context.ledger",
  "context.editorBridge",
  "review.exactDiff",
  "goal.lifecycle",
  "preference.memory",
  "skill.candidates",
  "native.agentHost",
] as const;

export const PROTOCOL_V2_SCHEMA_SOURCE = {
  schemaVersion: 1,
  protocol: {
    current: 2,
    minimum: 2,
    maximum: 2,
    compatibilityDecision:
      "Protocol v1 remains a legacy in-process webview contract; v2 requires hello/ready negotiation.",
  },
  envelopes: {
    hello: ["protocolRange", "client"],
    ready: ["protocol", "epoch", "capabilities", "runtime", "limits"],
    request: [
      "protocol",
      "kind",
      "id",
      "type",
      "sessionID?",
      "expectedRevision?",
      "mutationID?",
      "payload",
    ],
    successResponse: ["protocol", "kind", "id", "ok", "result"],
    errorResponse: ["protocol", "kind", "id", "ok", "error"],
    event: [
      "protocol",
      "kind",
      "epoch",
      "sequence",
      "type",
      "sessionID?",
      "revision?",
      "payload",
    ],
  },
  errorCodes: PROTOCOL_V2_ERROR_CODES,
  capabilities: WORKBENCH_CAPABILITIES,
  defaultLimits: {
    // A validated prompt can contain up to 20 MB of inline attachment data in
    // addition to its bounded transcript/action envelope.
    maxRequestBytes: 33_554_432,
    maxPendingRequests: 128,
    maxEventQueue: 2_000,
    maxStringCharacters: 20_000_000,
    maxErrorDetailsBytes: 16_384,
  },
} as const;

export type ProtocolV2ErrorCode = typeof PROTOCOL_V2_ERROR_CODES[number];
export type WorkbenchCapability = typeof WORKBENCH_CAPABILITIES[number];
