export const BRIDGE_OPERATIONS = {
  vscode_list_open_editors: { permission: "vscode.read", sideEffect: false },
  vscode_get_selection: { permission: "vscode.read", sideEffect: false },
  vscode_get_active_buffer: { permission: "vscode.read_buffer", sideEffect: false },
  vscode_get_definitions: { permission: "vscode.language", sideEffect: false },
  vscode_get_references: { permission: "vscode.language", sideEffect: false },
  vscode_get_symbols: { permission: "vscode.language", sideEffect: false },
  vscode_get_diagnostics: { permission: "vscode.read", sideEffect: false },
  vscode_open_file: { permission: "vscode.open_file", sideEffect: true },
  vscode_get_debug_context: { permission: "vscode.read", sideEffect: false },
  vscode_execute_terminal: { permission: "vscode.execute_terminal", sideEffect: true },
  vscode_list_tasks: { permission: "vscode.tasks", sideEffect: false },
  vscode_run_task: { permission: "vscode.execute_task", sideEffect: true },
  vscode_get_code_actions: { permission: "vscode.language", sideEffect: false },
  vscode_preview_rename: { permission: "vscode.language", sideEffect: false },
  vscode_open_url: { permission: "vscode.open_url", sideEffect: true },
  vscode_request_opencode_reload: { permission: "vscode.reload_opencode", sideEffect: true },
} as const

export type BridgeOperation = keyof typeof BRIDGE_OPERATIONS

export interface BridgeEntry {
  id: string
  worktree: string
  endpoint: string
  token: string
  pid: number
  updatedAt: number
  operations: BridgeOperation[]
}

export interface BridgeRegistry {
  version: 1
  entries: BridgeEntry[]
}

export const BRIDGE_STALE_AFTER_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseBridgeRegistry(value: unknown): BridgeRegistry {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 256) {
    throw new Error("Invalid VS Code bridge registry")
  }
  const ids = new Set<string>()
  const entries = value.entries.map((entry): BridgeEntry => {
    if (
      !isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 128 ||
      typeof entry.worktree !== "string" || entry.worktree.length === 0 || entry.worktree.length > 4_096 ||
      typeof entry.endpoint !== "string" || entry.endpoint.length === 0 || entry.endpoint.length > 2_048 ||
      typeof entry.token !== "string" || entry.token.length < 32 || entry.token.length > 512 ||
      !Number.isSafeInteger(entry.pid) || Number(entry.pid) <= 0 || !Number.isSafeInteger(entry.updatedAt) ||
      Number(entry.updatedAt) < 0 ||
      !Array.isArray(entry.operations) || entry.operations.length === 0 ||
      entry.operations.length > Object.keys(BRIDGE_OPERATIONS).length ||
      !entry.operations.every((operation) =>
        typeof operation === "string" && Object.hasOwn(BRIDGE_OPERATIONS, operation)
      ) ||
      new Set(entry.operations).size !== entry.operations.length || ids.has(entry.id)
    ) {
      throw new Error("Invalid VS Code bridge entry")
    }
    assertLoopbackEndpoint(entry.endpoint)
    ids.add(entry.id)
    return entry as unknown as BridgeEntry
  })
  return { version: 1, entries }
}

export function assertLoopbackEndpoint(endpoint: string): URL {
  const url = new URL(endpoint)
  if (
    url.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("VS Code bridge endpoint must be unauthenticated loopback HTTP")
  }
  return url
}

export function bridgeEntryIsFresh(entry: BridgeEntry, now: number, isAlive: (pid: number) => boolean): boolean {
  return now - entry.updatedAt <= BRIDGE_STALE_AFTER_MS && entry.updatedAt <= now + BRIDGE_STALE_AFTER_MS &&
    isAlive(entry.pid)
}
