import {
  encodedBytes,
  enforceProtocolLimits,
  parseRequest,
  type ProtocolLimits,
  ProtocolValidationError,
  type Request,
  type Response,
  structuredError,
  type WorkbenchCapabilities,
  type WorkbenchCapability,
} from "@opencode-workbench/shared"
import { CancellationRegistry } from "./cancellation-registry.js"
import { IdempotencyStore, MutationConflictError } from "./idempotency-store.js"
import { RequestRegistry } from "./request-registry.js"

export interface HostRequestContext {
  request: Request
  surfaceID: string
  signal: AbortSignal
  inputDisposition(): "pending" | "admitted" | "rejected"
  admitInput(): void
  rejectInput(): void
}

export interface HostRouteDefinition {
  capability?: WorkbenchCapability
  mutation?: boolean
  longRunning?: boolean
  surfaceDisposition?: "cancel" | "detach"
  timeoutMilliseconds?: number
  preservesInputUntilAdmission?: boolean
  handler(context: HostRequestContext, payload: unknown): Promise<unknown>
}

export interface HostRouterOptions {
  capabilities: WorkbenchCapabilities
  limits: ProtocolLimits
  defaultTimeoutMilliseconds?: number
}

function fingerprint(request: Request): string {
  return JSON.stringify({
    type: request.type,
    sessionID: request.sessionID,
    expectedRevision: request.expectedRevision,
    payload: request.payload,
  })
}

function failure(
  requestID: string,
  code: Parameters<typeof structuredError>[0],
  message: string,
  retryable: boolean,
  details?: unknown,
): Response {
  return {
    protocol: 2,
    kind: "response",
    id: requestID,
    ok: false,
    error: structuredError(code, message, retryable, details),
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 20_000) : "Internal host routing failure"
}

export class HostRouter {
  private readonly definitions = new Map<string, HostRouteDefinition>()
  private readonly requests: RequestRegistry
  private readonly cancellations = new CancellationRegistry()
  private readonly idempotency = new IdempotencyStore<Response>()
  private readonly defaultTimeoutMilliseconds: number

  constructor(private readonly options: HostRouterOptions) {
    this.requests = new RequestRegistry(options.limits.maxPendingRequests)
    this.defaultTimeoutMilliseconds = options.defaultTimeoutMilliseconds ??
      30_000
  }

  get pendingRequests(): number {
    return this.requests.size
  }

  register(type: string, definition: HostRouteDefinition): void {
    if (!type || this.definitions.has(type)) {
      throw new Error(`Host route already registered: ${type}`)
    }
    this.definitions.set(type, definition)
  }

  cancel(requestID: string): boolean {
    return this.cancellations.cancel(requestID)
  }

  disposeSurface(
    surfaceID: string,
  ): { cancelled: string[]; detached: string[] } {
    return this.cancellations.disposeSurface(surfaceID)
  }

  async route(surfaceID: string, input: unknown): Promise<Response> {
    let request: Request
    try {
      enforceProtocolLimits(input, this.options.limits)
      request = parseRequest(input)
    } catch (error) {
      const requestID = typeof input === "object" && input !== null && "id" in input &&
          typeof input.id === "string"
        ? input.id.slice(0, 256) || "invalid"
        : "invalid"
      if (error instanceof ProtocolValidationError) {
        return failure(
          requestID,
          error.code,
          error.message,
          error.code === "OVERLOADED",
        )
      }
      return failure(
        requestID,
        "VALIDATION_FAILED",
        "Invalid protocol request",
        false,
      )
    }
    const definition = this.definitions.get(request.type)
    if (!definition) {
      return failure(
        request.id,
        "CAPABILITY_UNAVAILABLE",
        `Unsupported request type ${request.type}`,
        false,
      )
    }
    if (
      definition.capability && !this.options.capabilities[definition.capability]
    ) {
      return failure(
        request.id,
        "CAPABILITY_UNAVAILABLE",
        `Capability ${definition.capability} is unavailable`,
        false,
        { capability: definition.capability },
      )
    }
    if (definition.mutation && !request.mutationID) {
      return failure(
        request.id,
        "VALIDATION_FAILED",
        "Mutation request requires mutationID",
        false,
      )
    }
    const status = this.requests.register({
      id: request.id,
      surfaceID,
      type: request.type,
      startedAt: Date.now(),
      disposition: definition.surfaceDisposition ?? "cancel",
    })
    if (status === "duplicate") {
      return failure(
        request.id,
        "OPERATION_CONFLICT",
        `Request ${request.id} is already pending`,
        false,
      )
    }
    if (status === "overloaded") {
      return failure(
        request.id,
        "OVERLOADED",
        "Host request queue is full",
        true,
        { maximum: this.requests.maximum },
      )
    }

    const execute = () => this.execute(surfaceID, request, definition)
    try {
      const response = definition.mutation
        ? await this.idempotency.execute(
          request.mutationID!,
          fingerprint(request),
          execute,
        )
        : await execute()
      return response.id === request.id ? response : { ...response, id: request.id }
    } catch (error) {
      if (error instanceof MutationConflictError) {
        return failure(request.id, "OPERATION_CONFLICT", error.message, false)
      }
      return failure(request.id, "INTERNAL", message(error), false)
    } finally {
      this.requests.finish(request.id)
      this.cancellations.finish(request.id)
    }
  }

  private async execute(
    surfaceID: string,
    request: Request,
    definition: HostRouteDefinition,
  ): Promise<Response> {
    const signal = this.cancellations.create(
      request.id,
      surfaceID,
      definition.surfaceDisposition ?? "cancel",
    )
    let disposition: "pending" | "admitted" | "rejected" = "pending"
    const deadline = definition.timeoutMilliseconds ??
      this.defaultTimeoutMilliseconds
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ProtocolValidationError(
          `Request timed out after ${deadline}ms`,
          "TIMEOUT",
        )
        this.cancellations.cancel(request.id, error)
        reject(error)
      }, deadline)
    })
    const cancelled = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("Request cancelled")),
        { once: true },
      )
    })
    const context: HostRequestContext = {
      request,
      surfaceID,
      signal,
      inputDisposition: () => disposition,
      admitInput: () => disposition = "admitted",
      rejectInput: () => disposition = "rejected",
    }
    try {
      const result = await Promise.race([
        definition.handler(context, request.payload),
        timeout,
        cancelled,
      ])
      if (
        definition.preservesInputUntilAdmission && disposition === "pending"
      ) {
        return failure(
          request.id,
          "INTERNAL",
          "Prompt handler returned without admitting or rejecting input",
          false,
          { inputDisposition: "preserved" },
        )
      }
      return {
        protocol: 2,
        kind: "response",
        id: request.id,
        ok: true,
        result,
      }
    } catch (error) {
      const inputDetails = definition.preservesInputUntilAdmission && disposition === "pending"
        ? { inputDisposition: "preserved" }
        : undefined
      if (error instanceof ProtocolValidationError) {
        return failure(
          request.id,
          error.code,
          error.message,
          error.code === "TIMEOUT",
          inputDetails,
        )
      }
      if (signal.aborted) {
        return failure(
          request.id,
          "CANCELLED",
          "Request cancelled",
          true,
          inputDetails,
        )
      }
      return failure(
        request.id,
        "INTERNAL",
        message(error),
        false,
        inputDetails,
      )
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

export function requestFingerprintBytes(request: Request): number {
  return encodedBytes(fingerprint(request))
}
