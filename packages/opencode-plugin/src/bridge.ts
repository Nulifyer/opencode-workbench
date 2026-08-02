import { readFile, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  BRIDGE_OPERATIONS,
  type BridgeEntry,
  type BridgeOperation,
  assertLoopbackEndpoint,
  bridgeEntryIsFresh,
  parseBridgeRegistry,
} from "./bridge-policy.ts"
import { LIMITS } from "./security.ts"

export { BRIDGE_OPERATIONS, type BridgeOperation } from "./bridge-policy.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readLimitedResponse(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("VS Code bridge returned an empty response")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let result = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new Error("VS Code bridge response exceeds the size limit")
      }
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
    return code === "EPERM"
  }
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

export async function selectBridge(registryPath: string, worktree: string, operation: BridgeOperation, affinity?: string): Promise<BridgeEntry> {
  let contents: string
  try {
    contents = await readFile(registryPath, "utf8")
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
    if (code === "ENOENT") throw new Error("No VS Code bridge is registered")
    throw error
  }
  if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error("VS Code bridge registry exceeds the size limit")
  const registry = parseBridgeRegistry(JSON.parse(contents))
  const target = await canonical(worktree)
  const now = Date.now()
  const candidates: BridgeEntry[] = []
  for (const entry of registry.entries) {
    if (!bridgeEntryIsFresh(entry, now, processIsAlive)) continue
    if (!entry.operations.includes(operation) || await canonical(entry.worktree) !== target || (affinity && entry.id !== affinity)) continue
    assertLoopbackEndpoint(entry.endpoint)
    candidates.push(entry)
  }
  if (!affinity && candidates.length > 1) throw new Error("Multiple VS Code bridges are registered for this worktree; use the managed Workbench server for exact window affinity")
  const selected = candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0]
  if (!selected) throw new Error(`No fresh VS Code bridge for this worktree supports ${operation}`)
  return selected
}

export async function proxyBridge(
  registryPath: string,
  operation: BridgeOperation,
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  const policy = BRIDGE_OPERATIONS[operation]
  const parameterPattern = JSON.stringify(params)
  await context.ask({
    permission: policy.permission,
    patterns: [operation, context.worktree, parameterPattern],
    always: operation === "vscode_request_opencode_reload" ? [] : [operation, context.worktree],
    metadata: { operation, parameters: params, sideEffect: policy.sideEffect, worktree: context.worktree },
  })
  const affinity = process.env.OPENCODE_WORKBENCH_BRIDGE_ID
  if (affinity !== undefined && (!affinity || affinity.length > 128)) throw new Error("Invalid VS Code bridge affinity")
  const bridge = await selectBridge(registryPath, context.worktree, operation, affinity)
  const encoded = JSON.stringify({
    version: 1,
    bridgeID: bridge.id,
    operation,
    params,
    context: { worktree: context.worktree, directory: context.directory, sessionID: context.sessionID },
  })
  if (Buffer.byteLength(encoded) > LIMITS.bridgeRequest) throw new Error("VS Code bridge request exceeds the size limit")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("VS Code bridge timed out")), 10_000)
  const abort = () => controller.abort(context.abort.reason)
  context.abort.addEventListener("abort", abort, { once: true })
  if (context.abort.aborted) controller.abort(context.abort.reason)
  try {
    const response = await fetch(assertLoopbackEndpoint(bridge.endpoint), {
      method: "POST",
      headers: { "authorization": `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: encoded,
      signal: controller.signal,
    })
    const body = await readLimitedResponse(response, LIMITS.bridgeResponse)
    const result: unknown = JSON.parse(body)
    if (!isRecord(result) || result.version !== 1 || typeof result.ok !== "boolean") throw new Error("Invalid VS Code bridge response")
    if (!result.ok) {
      const code = isRecord(result.error) && typeof result.error.code === "string" ? result.error.code.slice(0, 128) : "bridge_error"
      throw new Error(`VS Code bridge failed: ${code}`)
    }
    if (!response.ok) throw new Error(`VS Code bridge returned HTTP ${response.status}`)
    return JSON.stringify(result.result ?? null)
  } finally {
    clearTimeout(timeout)
    context.abort.removeEventListener("abort", abort)
  }
}
