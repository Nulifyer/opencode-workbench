import path from "node:path"
import { GOAL_CONTINUATION_METADATA, GOAL_CONTINUATION_PROMPT } from "../src/goal-prompts.ts"
import PluginModule from "../src/index.ts"

interface GoalTool {
  execute(args: Record<string, unknown>, context: unknown): Promise<string>
}

interface GoalHooks {
  dispose(): Promise<void>
  config(config: Record<string, unknown>): Promise<void>
  tool: Record<string, GoalTool>
  event(input: { event: { type: string; properties: Record<string, unknown> } }): Promise<void>
  "experimental.chat.system.transform"(input: Record<string, unknown>, output: { system: string[] }): Promise<void>
  "experimental.session.compacting"(input: { sessionID: string }, output: { context: string[] }): Promise<void>
}

function context(sessionID: string, agent = "build"): unknown {
  return { sessionID, messageID: "message", agent, worktree: "/workspace", ask: async () => undefined }
}

function parsed(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => resolve = next)
  return { promise, resolve }
}

function transcriptMessage(request: Record<string, unknown>, sessionID: string): Record<string, unknown> {
  const body = request.body as { messageID?: string; parts?: Array<Record<string, unknown>> }
  if (!body?.messageID || !body.parts?.length) throw new Error("Continuation request did not carry stable message and part IDs")
  return {
    info: { id: body.messageID, sessionID, role: "user", time: { created: Date.now() } },
    parts: body.parts.map((part) => ({ ...part, sessionID, messageID: body.messageID })),
  }
}

async function eventually(condition: () => Promise<boolean>, milliseconds = 1_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${milliseconds}ms`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

Deno.test("goal configure tool applies one atomic form with generation and Plan safety", async () => {
  const root = await Deno.makeTempDir({ prefix: "workbench-goal-configure-" })
  const previous = Deno.env.get("XDG_DATA_HOME")
  Deno.env.set("XDG_DATA_HOME", root)
  let hooks: GoalHooks | undefined
  try {
    const client = { session: {
      status: async () => ({ data: {}, error: undefined }),
      promptAsync: async () => ({ data: undefined, error: undefined }),
    } }
    hooks = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks

    const sessionID = "ses_atomic_configure"
    const created = parsed(await hooks.tool.create_goal.execute({ objective: "Original objective" }, context(sessionID))).goal as { settlementGeneration?: number }
    const configured = parsed(await hooks.tool.configure_goal_verification.execute({
      objective: "Updated objective",
      acceptance_criteria: ["Tests pass", "No diagnostics remain"],
      token_budget: 2_000,
      max_auto_turns: 4,
      max_duration_seconds: 600,
      enabled: true,
      model: "provider/model",
      agent: "verify",
      repeated_block_threshold: 2,
      expected_generation: created.settlementGeneration,
    }, context(sessionID, "plan"))).goal as {
      objective?: string
      acceptanceCriteria?: string[]
      tokenBudget?: number
      status?: string
      stopReason?: string
      verifier?: { enabled?: boolean; model?: string; agent?: string; repeatedBlockThreshold?: number }
      settlementGeneration?: number
    }
    if (configured.objective !== "Updated objective" || configured.acceptanceCriteria?.length !== 2 || configured.tokenBudget !== 2_000) {
      throw new Error("Configure tool did not apply the objective and verification fields together")
    }
    if (configured.status !== "paused" || configured.stopReason !== "plan mode") {
      throw new Error("Configure tool did not preserve Plan-agent pause safety")
    }
    if (!configured.verifier?.enabled || configured.verifier.model !== "provider/model" || configured.verifier.agent !== "verify" || configured.verifier.repeatedBlockThreshold !== 2) {
      throw new Error("Configure tool did not forward verifier settings")
    }

    const statePath = path.join(root, "opencode-workbench", "plugin", "goals.json")
    const beforeStale = await Deno.readTextFile(statePath)
    let staleRejected = false
    try {
      await hooks.tool.configure_goal_verification.execute({
        objective: "Stale objective",
        acceptance_criteria: ["Stale criterion"],
        expected_generation: created.settlementGeneration,
      }, context(sessionID, "build"))
    } catch (error) {
      staleRejected = error instanceof Error && /stale/.test(error.message)
    }
    if (!staleRejected) throw new Error("Configure tool accepted a stale settlement generation")
    if (await Deno.readTextFile(statePath) !== beforeStale) throw new Error("A stale configure tool call mutated persisted goal state")

    const legacySessionID = "ses_legacy_configure"
    await hooks.tool.create_goal.execute({ objective: "Keep the legacy objective" }, context(legacySessionID))
    const legacy = parsed(await hooks.tool.configure_goal_verification.execute({
      acceptance_criteria: ["Legacy fields remain accepted"],
      enabled: true,
    }, context(legacySessionID))).goal as { objective?: string; status?: string; acceptanceCriteria?: string[]; verifier?: { enabled?: boolean } }
    if (legacy.objective !== "Keep the legacy objective" || legacy.status !== "active" || legacy.acceptanceCriteria?.[0] !== "Legacy fields remain accepted" || !legacy.verifier?.enabled) {
      throw new Error("Legacy configure tool calls changed behavior")
    }
  } finally {
    if (hooks) await hooks.dispose()
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("native goal hooks integrate lifecycle, persistence, policy, compaction, and cleanup", async () => {
  const root = await Deno.makeTempDir({ prefix: "workbench-goal-integration-" })
  const previous = Deno.env.get("XDG_DATA_HOME")
  const activePlugins: GoalHooks[] = []
  Deno.env.set("XDG_DATA_HOME", root)
  try {
    const prompts: Array<Record<string, unknown>> = []
    let promptAdmission = deferred()
    let admissionError: unknown
    const client = { session: {
      status: async () => ({ data: {}, error: undefined }),
      promptAsync: async (request: Record<string, unknown>) => {
        prompts.push(request)
        promptAdmission.resolve()
        return admissionError === undefined ? { data: undefined, error: undefined } : { data: undefined, error: admissionError }
      },
    } }
    const hooks = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    activePlugins.push(hooks)
    const config: Record<string, unknown> = {}
    await hooks.config(config)
    const commands = config.command as Record<string, unknown>
    if (!commands?.goal || !commands["goal-unlimited"]) throw new Error("Goal commands were not registered through the plugin config hook")

    const policy = { system: ["base policy"] }
    await hooks["experimental.chat.system.transform"]({}, policy)
    if (!policy.system[0]?.includes("OpenCode Workbench goal policy")) throw new Error("Goal policy was not injected")

    const sessionID = "ses_goal_integration"
    const created = parsed(await hooks.tool.create_goal.execute({ objective: "Implement and verify native goal integration", max_auto_turns: 2 }, context(sessionID)))
    if ((created.goal as { status?: string })?.status !== "active") throw new Error("Goal tool did not create an active goal")

    await hooks.tool.update_goal_checkpoint.execute({ summary: "Native goal tools loaded and persisted state." }, context(sessionID))
    const current = parsed(await hooks.tool.get_goal.execute({}, context(sessionID))).goal as { lastCheckpoint?: { summary?: string } }
    if (current.lastCheckpoint?.summary !== "Native goal tools loaded and persisted state.") throw new Error("Goal checkpoint was not persisted")

    const firstPrompt = promptAdmission.promise
    await Promise.all([
      hooks.event({ event: { type: "session.idle", properties: { sessionID } } }),
      hooks.event({ event: { type: "session.idle", properties: { sessionID } } }),
    ])
    await firstPrompt
    if (prompts.length !== 1) throw new Error(`Duplicate idle events admitted ${prompts.length} continuation prompts`)
    const firstRequest = prompts[0] as { path?: { id?: string }; query?: { directory?: string }; body?: { parts?: Array<{ type?: string; text?: string; synthetic?: boolean; metadata?: unknown }> } }
    if (firstRequest.path?.id !== sessionID || firstRequest.query?.directory !== "/workspace" || firstRequest.body?.parts?.length !== 1 ||
      firstRequest.body.parts[0]?.type !== "text" || firstRequest.body.parts[0]?.text !== GOAL_CONTINUATION_PROMPT || firstRequest.body.parts[0]?.synthetic !== true ||
      JSON.stringify(firstRequest.body.parts[0]?.metadata) !== JSON.stringify(GOAL_CONTINUATION_METADATA)) {
      throw new Error(`Idle continuation did not admit the complete goal prompt: ${JSON.stringify(firstRequest)}`)
    }
    const afterFirst = parsed(await hooks.tool.get_goal.execute({}, context(sessionID))).goal as { autoTurns?: number }
    if (afterFirst.autoTurns !== 1) throw new Error("Admitted continuation was not persisted before prompting")
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await hooks.tool.get_goal.execute({}, context(sessionID))
    if (Number(prompts.length) !== 1) throw new Error("A repeated idle event admitted another prompt before the prior prompt started")

    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    promptAdmission = deferred()
    const secondPrompt = promptAdmission.promise
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await secondPrompt
    const afterSecond = parsed(await hooks.tool.get_goal.execute({}, context(sessionID))).goal as { autoTurns?: number }
    const promptCountAfterSecond: number = prompts.length
    if (promptCountAfterSecond !== 2 || afterSecond.autoTurns !== 2) throw new Error("A completed goal turn did not admit and persist exactly one follow-up prompt")

    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => (parsed(await hooks.tool.get_goal.execute({}, context(sessionID))).goal as { status?: string }).status === "usageLimited")
    const limited = parsed(await hooks.tool.get_goal.execute({}, context(sessionID))).goal as { status?: string }
    const promptCountAtLimit: number = prompts.length
    if (promptCountAtLimit !== 2 || limited.status !== "usageLimited") throw new Error("The persisted auto-turn limit did not stop further prompts")

    const compaction = { context: [] as string[] }
    await hooks["experimental.session.compacting"]({ sessionID }, compaction)
    if (!compaction.context[0]?.includes("Implement and verify native goal integration")) throw new Error("Goal context was not preserved for compaction")

    const restarted = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    activePlugins.push(restarted)
    const restored = parsed(await restarted.tool.get_goal.execute({}, context(sessionID))).goal as { objective?: string }
    if (restored.objective !== "Implement and verify native goal integration") throw new Error("Goal did not survive plugin recreation")

    const completed = parsed(await restarted.tool.update_goal.execute({ status: "complete", evidence: "Integration lifecycle assertions passed." }, context(sessionID)))
    if ((completed.goal as { status?: string })?.status !== "complete") throw new Error("Goal did not close with evidence")
    await restarted.event({ event: { type: "session.idle", properties: { sessionID } } })
    await restarted.tool.get_goal.execute({}, context(sessionID))
    const promptCountAfterCompletion: number = prompts.length
    if (promptCountAfterCompletion !== 2) throw new Error("A terminal goal admitted another continuation prompt")

    const controlSessionID = "ses_goal_controls"
    await restarted.tool.create_goal.execute({ objective: "Original objective" }, context(controlSessionID))
    await restarted.tool.update_goal_status.execute({ status: "paused" }, context(controlSessionID))
    await restarted.tool.update_goal_objective.execute({ objective: "Edited objective" }, context(controlSessionID))
    await restarted.event({ event: { type: "session.idle", properties: { sessionID: controlSessionID } } })
    await restarted.tool.get_goal.execute({}, context(controlSessionID))
    if (Number(prompts.length) !== 2) throw new Error("A paused goal admitted a continuation prompt")
    await restarted.tool.update_goal_status.execute({ status: "active" }, context(controlSessionID))
    promptAdmission = deferred()
    const resumedPrompt = promptAdmission.promise
    await restarted.event({ event: { type: "session.idle", properties: { sessionID: controlSessionID } } })
    await resumedPrompt
    const controlled = parsed(await restarted.tool.get_goal.execute({}, context(controlSessionID))).goal as { objective?: string; autoTurns?: number }
    if (controlled.objective !== "Edited objective" || controlled.autoTurns !== 1 || Number(prompts.length) !== 3) {
      throw new Error("Edited and resumed goal state did not govern the admitted prompt")
    }
    await restarted.tool.clear_goal.execute({}, context(controlSessionID))
    await restarted.event({ event: { type: "session.status", properties: { sessionID: controlSessionID, status: { type: "busy" } } } })
    await restarted.event({ event: { type: "session.idle", properties: { sessionID: controlSessionID } } })
    if (Number(prompts.length) !== 3) throw new Error("A cancelled goal admitted another continuation prompt")

    const failingSessionID = "ses_goal_failure"
    admissionError = { message: "prompt admission rejected" }
    promptAdmission = deferred()
    await restarted.tool.create_goal.execute({ objective: "Pause after admission failure" }, context(failingSessionID))
    const failedPrompt = promptAdmission.promise
    await restarted.event({ event: { type: "session.idle", properties: { sessionID: failingSessionID } } })
    await failedPrompt
    await eventually(async () => (parsed(await restarted.tool.get_goal.execute({}, context(failingSessionID))).goal as { status?: string }).status === "paused")
    await restarted.dispose()
    const failed = parsed(await restarted.tool.get_goal.execute({}, context(failingSessionID))).goal as { status?: string; lastStatus?: string }
    if (failed.status !== "paused" || !failed.lastStatus?.includes("prompt admission rejected")) throw new Error("Prompt admission failure did not pause the goal with evidence")

    await restarted.event({ event: { type: "session.deleted", properties: { info: { id: sessionID } } } })
    if (parsed(await restarted.tool.get_goal.execute({}, context(sessionID))).goal !== null) throw new Error("Deleted session retained native goal state")

    const statePath = path.join(root, "opencode-workbench", "plugin", "goals.json")
    if (!JSON.parse(await Deno.readTextFile(statePath)).goals) throw new Error("Native goal state file was not written")
  } finally {
    await Promise.allSettled(activePlugins.map((plugin) => plugin.dispose()))
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("goal continuation follows OpenCode status ordering and pauses on background failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "workbench-goal-status-" })
  const previous = Deno.env.get("XDG_DATA_HOME")
  Deno.env.set("XDG_DATA_HOME", root)
  let hooks: GoalHooks | undefined
  const secondPromptReturn = deferred()
  try {
    const prompts: Array<Record<string, unknown>> = []
    const sessionID = "ses_status_order"
    let statusError: unknown
    const client = { session: {
      status: async () => statusError === undefined ? { data: {}, error: undefined } : { data: undefined, error: statusError },
      messages: async () => ({ data: prompts.map((request) => transcriptMessage(request, sessionID)), error: undefined }),
      promptAsync: async (request: Record<string, unknown>) => {
        prompts.push(request)
        if (prompts.length === 2) await secondPromptReturn.promise
        return { data: undefined, error: undefined }
      },
    } }
    hooks = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    await hooks.tool.create_goal.execute({ objective: "Follow the real OpenCode event contract" }, context(sessionID))

    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => prompts.length === 1)
    await hooks.tool.get_goal.execute({}, context(sessionID))
    if (prompts.length !== 1) throw new Error("Canonical and deprecated idle events admitted duplicate prompts")

    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => prompts.length === 2)
    await hooks.tool.get_goal.execute({}, context(sessionID))
    if (Number(prompts.length) !== 2) throw new Error("A busy-to-idle transition did not admit exactly one continuation")

    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
    secondPromptReturn.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await hooks.event({ event: { type: "session.error", properties: { sessionID, error: { message: "background prompt execution failed" } } } })
    const failed = parsed(await hooks.tool.get_goal.execute({}, context(sessionID))).goal as { status?: string; lastStatus?: string }
    if (failed.status !== "paused" || !failed.lastStatus?.includes("background prompt execution failed")) {
      throw new Error("The asynchronous prompt failure event did not pause the active goal")
    }
    if (Number(prompts.length) !== 2) throw new Error("Idle-before-error ordering admitted another continuation before failure handling")

    const statusFailureSessionID = "ses_status_failure"
    statusError = { message: "status endpoint unavailable" }
    await hooks.tool.create_goal.execute({ objective: "Pause when idle cannot be verified" }, context(statusFailureSessionID))
    await hooks.event({ event: { type: "session.status", properties: { sessionID: statusFailureSessionID, status: { type: "idle" } } } })
    await eventually(async () => (parsed(await hooks!.tool.get_goal.execute({}, context(statusFailureSessionID))).goal as { status?: string }).status === "paused")
    const statusFailure = parsed(await hooks.tool.get_goal.execute({}, context(statusFailureSessionID))).goal as { lastStatus?: string }
    if (!statusFailure.lastStatus?.includes("status endpoint unavailable")) throw new Error("Status lookup failure did not pause the goal with a diagnostic")
  } finally {
    secondPromptReturn.resolve()
    if (hooks) await hooks.dispose()
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("busy events cancel an in-flight idle continuation before reservation", async () => {
  const root = await Deno.makeTempDir({ prefix: "workbench-goal-cancel-" })
  const previous = Deno.env.get("XDG_DATA_HOME")
  Deno.env.set("XDG_DATA_HOME", root)
  let hooks: GoalHooks | undefined
  const releaseStatus = deferred()
  try {
    const statusStarted = deferred()
    let prompts = 0
    const client = { session: {
      status: async () => {
        statusStarted.resolve()
        await releaseStatus.promise
        return { data: {}, error: undefined }
      },
      promptAsync: async () => {
        prompts += 1
        return { data: undefined, error: undefined }
      },
    } }
    hooks = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    const sessionID = "ses_busy_cancel"
    await hooks.tool.create_goal.execute({ objective: "Do not race explicit user input" }, context(sessionID))
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
    await statusStarted.promise
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    releaseStatus.resolve()
    await hooks.dispose()
    const goal = parsed(await hooks.tool.get_goal.execute({}, context(sessionID))).goal as { autoTurns?: number }
    if (prompts !== 0 || goal.autoTurns !== 0) throw new Error("A stale idle continuation survived a newer busy event")
  } finally {
    releaseStatus.resolve()
    if (hooks) await hooks.dispose()
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("restart reconciles an admitted continuation by its durable transcript IDs", async () => {
  const root = await Deno.makeTempDir({ prefix: "workbench-goal-crash-admitted-" })
  const previous = Deno.env.get("XDG_DATA_HOME")
  Deno.env.set("XDG_DATA_HOME", root)
  const plugins: GoalHooks[] = []
  try {
    const prompts: Array<Record<string, unknown>> = []
    const transcript: Array<Record<string, unknown>> = []
    const client = { session: {
      status: async () => ({ data: {}, error: undefined }),
      messages: async () => ({ data: transcript, error: undefined }),
      promptAsync: async (request: Record<string, unknown>) => {
        prompts.push(request)
        return { data: undefined, error: undefined }
      },
    } }
    const first = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    plugins.push(first)
    const sessionID = "ses_crash_admitted"
    await first.tool.create_goal.execute({ objective: "Recover one admitted continuation", max_auto_turns: 3 }, context(sessionID))
    await first.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => prompts.length === 1)
    const beforeRestart = parsed(await first.tool.get_goal.execute({}, context(sessionID))).goal as {
      autoTurns?: number
      pendingContinuation?: boolean
      pendingContinuationMessageID?: string
      pendingContinuationID?: string
    }
    if (beforeRestart.autoTurns !== 1 || beforeRestart.pendingContinuation !== true || !beforeRestart.pendingContinuationMessageID || !beforeRestart.pendingContinuationID) {
      throw new Error("Crash fixture did not persist the in-flight continuation reservation")
    }
    transcript.push(transcriptMessage(prompts[0]!, sessionID))
    await first.dispose()

    const restarted = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    plugins.push(restarted)
    const recovered = parsed(await restarted.tool.get_goal.execute({}, context(sessionID))).goal as { autoTurns?: number; pendingContinuation?: boolean }
    if (recovered.autoTurns !== 1 || recovered.pendingContinuation !== false || prompts.length !== 1) {
      throw new Error("Restart did not reconcile the admitted continuation without replaying or recounting it")
    }

    await restarted.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => prompts.length === 2)
    const next = parsed(await restarted.tool.get_goal.execute({}, context(sessionID))).goal as { autoTurns?: number }
    if (next.autoTurns !== 2) throw new Error("Recovered goal did not reserve exactly one later continuation")
  } finally {
    await Promise.allSettled(plugins.map((plugin) => plugin.dispose()))
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("restart reconciles an older ID-less pending reservation by marker and time", async () => {
  const root = await Deno.makeTempDir({ prefix: "workbench-goal-crash-legacy-" })
  const previous = Deno.env.get("XDG_DATA_HOME")
  Deno.env.set("XDG_DATA_HOME", root)
  const plugins: GoalHooks[] = []
  try {
    const prompts: Array<Record<string, unknown>> = []
    const transcript: Array<Record<string, unknown>> = []
    const client = { session: {
      status: async () => ({ data: {}, error: undefined }),
      messages: async () => ({ data: transcript, error: undefined }),
      promptAsync: async (request: Record<string, unknown>) => {
        prompts.push(request)
        return { data: undefined, error: undefined }
      },
    } }
    const first = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    plugins.push(first)
    const sessionID = "ses_crash_legacy"
    await first.tool.create_goal.execute({ objective: "Recover state written before durable IDs" }, context(sessionID))
    await first.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => prompts.length === 1)
    transcript.push(transcriptMessage(prompts[0]!, sessionID))
    await first.dispose()

    const statePath = path.join(root, "opencode-workbench", "plugin", "goals.json")
    const state = JSON.parse(await Deno.readTextFile(statePath)) as { goals: Record<string, Record<string, unknown>> }
    delete state.goals[sessionID]?.pendingContinuationMessageID
    delete state.goals[sessionID]?.pendingContinuationID
    delete state.goals[sessionID]?.pendingContinuationReservedAt
    state.goals[sessionID]!.updatedAt = Number(state.goals[sessionID]!.updatedAt) + 100
    await Deno.writeTextFile(statePath, `${JSON.stringify(state)}\n`)

    const restarted = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    plugins.push(restarted)
    const recovered = parsed(await restarted.tool.get_goal.execute({}, context(sessionID))).goal as { autoTurns?: number; pendingContinuation?: boolean }
    if (recovered.autoTurns !== 1 || recovered.pendingContinuation !== false || prompts.length !== 1) {
      throw new Error("Legacy pending reservation was replayed instead of reconciled from its transcript marker")
    }
  } finally {
    await Promise.allSettled(plugins.map((plugin) => plugin.dispose()))
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("restart retries an unobserved reservation with the same IDs and count", async () => {
  const root = await Deno.makeTempDir({ prefix: "workbench-goal-crash-reserved-" })
  const previous = Deno.env.get("XDG_DATA_HOME")
  Deno.env.set("XDG_DATA_HOME", root)
  const plugins: GoalHooks[] = []
  try {
    const prompts: Array<Record<string, unknown>> = []
    const client = { session: {
      status: async () => ({ data: {}, error: undefined }),
      messages: async () => ({ data: [], error: undefined }),
      promptAsync: async (request: Record<string, unknown>) => {
        prompts.push(request)
        return { data: undefined, error: undefined }
      },
    } }
    const first = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    plugins.push(first)
    const sessionID = "ses_crash_reserved"
    await first.tool.create_goal.execute({ objective: "Retry a reservation without double counting" }, context(sessionID))
    await first.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => prompts.length === 1)
    const firstBody = prompts[0]!.body as { messageID?: string; parts?: Array<{ id?: string }> }
    await first.dispose()

    const restarted = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    plugins.push(restarted)
    await restarted.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => prompts.length === 2)
    const secondBody = prompts[1]!.body as { messageID?: string; parts?: Array<{ id?: string }> }
    const recovered = parsed(await restarted.tool.get_goal.execute({}, context(sessionID))).goal as { autoTurns?: number; pendingContinuation?: boolean }
    if (recovered.autoTurns !== 1 || recovered.pendingContinuation !== true || firstBody.messageID !== secondBody.messageID || firstBody.parts?.[0]?.id !== secondBody.parts?.[0]?.id) {
      throw new Error("Restart created a second reservation instead of retrying the durable one")
    }
  } finally {
    await Promise.allSettled(plugins.map((plugin) => plugin.dispose()))
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("restart pauses pending continuation when transcript recovery is unavailable", async () => {
  const root = await Deno.makeTempDir({ prefix: "workbench-goal-crash-unknown-" })
  const previous = Deno.env.get("XDG_DATA_HOME")
  Deno.env.set("XDG_DATA_HOME", root)
  const plugins: GoalHooks[] = []
  try {
    let prompts = 0
    let historyError: unknown
    const client = { session: {
      status: async () => ({ data: {}, error: undefined }),
      messages: async () => historyError === undefined
        ? { data: [], error: undefined }
        : { data: undefined, error: historyError },
      promptAsync: async () => {
        prompts += 1
        return { data: undefined, error: undefined }
      },
    } }
    const first = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    plugins.push(first)
    const sessionID = "ses_crash_unknown"
    await first.tool.create_goal.execute({ objective: "Pause rather than guess after a crash" }, context(sessionID))
    await first.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => prompts === 1)
    await first.dispose()

    historyError = { message: "transcript endpoint unavailable" }
    const restarted = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    plugins.push(restarted)
    const recovered = parsed(await restarted.tool.get_goal.execute({}, context(sessionID))).goal as {
      status?: string
      autoTurns?: number
      pendingContinuation?: boolean
      lastStatus?: string
    }
    if (recovered.status !== "paused" || recovered.autoTurns !== 1 || recovered.pendingContinuation !== false || !recovered.lastStatus?.includes("explicitly resume") || prompts !== 1) {
      throw new Error("Ambiguous restart did not pause with an explicit recovery instruction")
    }
  } finally {
    await Promise.allSettled(plugins.map((plugin) => plugin.dispose()))
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("lost prompt response reconciles the admitted stable message from history", async () => {
  const root = await Deno.makeTempDir({ prefix: "workbench-goal-lost-response-" })
  const previous = Deno.env.get("XDG_DATA_HOME")
  Deno.env.set("XDG_DATA_HOME", root)
  let hooks: GoalHooks | undefined
  try {
    const transcript: Array<Record<string, unknown>> = []
    let prompts = 0
    const sessionID = "ses_lost_response"
    const client = { session: {
      status: async () => ({ data: {}, error: undefined }),
      messages: async () => ({ data: transcript, error: undefined }),
      promptAsync: async (request: Record<string, unknown>) => {
        prompts += 1
        transcript.push(transcriptMessage(request, sessionID))
        return { data: undefined, error: { message: "connection closed after admission" } }
      },
    } }
    hooks = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    await hooks.tool.create_goal.execute({ objective: "Reconcile an admitted prompt after a lost response" }, context(sessionID))
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await eventually(async () => {
      const goal = parsed(await hooks!.tool.get_goal.execute({}, context(sessionID))).goal as { pendingContinuation?: boolean }
      return prompts === 1 && goal.pendingContinuation === false
    })
    const recovered = parsed(await hooks.tool.get_goal.execute({}, context(sessionID))).goal as { status?: string; autoTurns?: number }
    if (recovered.status !== "active" || recovered.autoTurns !== 1) throw new Error("Lost response was treated as a failed admission despite matching durable history")
  } finally {
    if (hooks) await hooks.dispose()
    if (previous === undefined) Deno.env.delete("XDG_DATA_HOME")
    else Deno.env.set("XDG_DATA_HOME", previous)
    await Deno.remove(root, { recursive: true })
  }
})
