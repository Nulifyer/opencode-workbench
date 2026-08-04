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

async function eventually(condition: () => Promise<boolean>, milliseconds = 1_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${milliseconds}ms`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

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
    if (!((config.command as Record<string, unknown>)?.goal)) throw new Error("Goal command was not registered through the plugin config hook")

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
  try {
    const prompts: Array<Record<string, unknown>> = []
    let admitted = deferred()
    let statusError: unknown
    const client = { session: {
      status: async () => statusError === undefined ? { data: {}, error: undefined } : { data: undefined, error: statusError },
      promptAsync: async (request: Record<string, unknown>) => {
        prompts.push(request)
        admitted.resolve()
        return { data: undefined, error: undefined }
      },
    } }
    hooks = await PluginModule.server({ client, directory: "/workspace", worktree: "/workspace" } as never) as unknown as GoalHooks
    const sessionID = "ses_status_order"
    await hooks.tool.create_goal.execute({ objective: "Follow the real OpenCode event contract" }, context(sessionID))

    const first = admitted.promise
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await first
    await hooks.tool.get_goal.execute({}, context(sessionID))
    if (prompts.length !== 1) throw new Error("Canonical and deprecated idle events admitted duplicate prompts")

    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    admitted = deferred()
    const second = admitted.promise
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
    await second
    await hooks.tool.get_goal.execute({}, context(sessionID))
    if (Number(prompts.length) !== 2) throw new Error("A busy-to-idle transition did not admit exactly one continuation")

    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
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
