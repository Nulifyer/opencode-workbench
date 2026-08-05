import { configureGoalCommand, configureNativeLsp } from "../src/config.ts"
import * as PluginModule from "../src/index.ts"
import { join } from "node:path"

Deno.test("plugin entry exports only plugin factories", () => {
  const exports = Object.keys(PluginModule)
  if (exports.join(",") !== "default") throw new Error(`Plugin entry exposed non-plugin exports: ${exports.join(", ")}`)
  if (typeof PluginModule.default !== "object" || PluginModule.default.id !== "opencode-workbench" || typeof PluginModule.default.server !== "function") {
    throw new Error("Plugin entry does not use the isolated OpenCode server-module contract")
  }
})

Deno.test("native LSP defaults on without overriding explicit configuration", () => {
  const omitted: { lsp?: unknown } = {}
  configureNativeLsp(omitted)
  if (!omitted.lsp || typeof omitted.lsp !== "object") throw new Error("Omitted native LSP configuration was not enabled")

  const disabled: { lsp?: unknown } = { lsp: false }
  configureNativeLsp(disabled)
  if (disabled.lsp !== false) throw new Error("Explicit native LSP disable was overridden")

  const custom = { lsp: { deno: { disabled: true } } }
  const configured = custom.lsp
  configureNativeLsp(custom)
  if (custom.lsp !== configured) throw new Error("Custom native LSP configuration was replaced")
})

Deno.test("goal commands are registered without overriding user configuration", () => {
  const omitted: { command?: Record<string, unknown> } = {}
  configureGoalCommand(omitted, "template", "unlimited")
  if ((omitted.command?.goal as { template?: string })?.template !== "template") throw new Error("Goal command was not registered")
  if ((omitted.command?.["goal-unlimited"] as { template?: string })?.template !== "unlimited") throw new Error("Unlimited goal command was not registered")

  const existing = { command: { goal: { template: "custom" }, "goal-unlimited": { template: "custom-unlimited" } } }
  configureGoalCommand(existing, "replacement", "replacement-unlimited")
  if (existing.command.goal.template !== "custom") throw new Error("Existing goal command was overridden")
  if (existing.command["goal-unlimited"].template !== "custom-unlimited") throw new Error("Existing unlimited goal command was overridden")
})

Deno.test("bundled plugin registers native goal tools and migrates legacy state", async () => {
  const root = await Deno.makeTempDir()
  const legacy = join(root, "legacy-goals.json")
  await Deno.writeTextFile(legacy, JSON.stringify({
    version: 1,
    goals: {
      session: {
        sessionID: "session",
        objective: "Migrate this goal",
        status: "paused",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
        lastAccountedAt: null,
        autoTurns: 0,
        maxAutoTurns: null,
        maxDurationSeconds: null,
        lastStatus: "paused",
        stopReason: "paused",
        completionEvidence: null,
        blocker: null,
        closedAt: null,
        history: [],
        checkpoints: [],
      },
    },
  }))
  const previousData = Deno.env.get("XDG_DATA_HOME")
  const previousLegacy = Deno.env.get("OPENCODE_GOAL_STATE_PATH")
  Deno.env.set("XDG_DATA_HOME", root)
  Deno.env.set("OPENCODE_GOAL_STATE_PATH", legacy)
  try {
    const hooks = await PluginModule.default.server({ worktree: "/work" } as never) as unknown as { tool: Record<string, unknown> }
    for (const name of ["get_goal", "get_goal_history", "create_goal", "set_goal", "update_goal_objective", "update_goal", "update_goal_status", "update_goal_checkpoint", "clear_goal"]) {
      if (!hooks.tool[name]) throw new Error(`Bundled plugin omitted ${name}`)
    }
    const migrated = JSON.parse(await Deno.readTextFile(join(root, "opencode-workbench", "plugin", "goals.json")))
    if (migrated.goals?.session?.objective !== "Migrate this goal") throw new Error("Legacy goal state was not migrated")
  } finally {
    if (previousData === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previousData)
    if (previousLegacy === undefined) Deno.env.delete("OPENCODE_GOAL_STATE_PATH")
    else Deno.env.set("OPENCODE_GOAL_STATE_PATH", previousLegacy)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("approved preference injection uses an OpenCode-compatible part ID", async () => {
  const root = await Deno.makeTempDir()
  const previous = Deno.env.get("XDG_DATA_HOME")
  Deno.env.set("XDG_DATA_HOME", root)
  try {
    const stateDirectory = join(root, "opencode-workbench", "plugin")
    await Deno.mkdir(stateDirectory, { recursive: true })
    await Deno.writeTextFile(join(stateDirectory, "state.json"), JSON.stringify({
      version: 1,
      preferences: [{
        id: "preference",
        scope: { kind: "project", project: "/work" },
        category: "workflow",
        key: "source",
        value: "Use the canonical source.",
        status: "approved",
        provenance: { sessionID: "session", messageID: "msg_source", source: "explicit_tool" },
        createdAt: 1,
        approvedAt: 1,
      }],
      evidence: [],
      skillCandidates: [],
    }))
    const hooks = await PluginModule.default.server({ worktree: "/work" } as never) as unknown as {
      "chat.message": (input: { sessionID: string }, output: { message: { id: string }; parts: Array<Record<string, unknown>> }) => Promise<void>
    }
    const output = { message: { id: "msg_target" }, parts: [] as Array<Record<string, unknown>> }
    await hooks["chat.message"]({ sessionID: "session" }, output)
    const injected = output.parts[0]
    if (typeof injected?.id !== "string" || !/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(injected.id)) {
      throw new Error("Preference injection produced an invalid OpenCode part ID")
    }
    if (injected.sessionID !== "session" || injected.messageID !== "msg_target" || injected.synthetic !== true) {
      throw new Error("Preference injection omitted required OpenCode part fields")
    }
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})
