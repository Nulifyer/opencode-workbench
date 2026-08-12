import { assertEquals } from "jsr:@std/assert"
import type { DelegationProgress, MessageBundle, RunGroup, WorktreeJournalEntry } from "@opencode-workbench/shared"
import { JobProjectionService } from "../src/application/job-projection-service.ts"

function messages(sessionID: string, count: number, start = 1): MessageBundle[] {
  return Array.from({ length: count }, (_, index) => ({
    info: {
      id: `msg_${sessionID}_${index}`,
      sessionID,
      role: index % 2 ? "assistant" : "user",
      time: { created: start + index },
    },
    parts: index % 2
      ? [{
        id: `part_${index}`,
        sessionID,
        messageID: `msg_${sessionID}_${index}`,
        type: "tool",
        tool: "bash",
        state: { status: "running" },
      }]
      : [],
  }))
}

function delegation(
  sessionID: string,
  status: DelegationProgress["status"],
  revision = 1,
  count = 2,
): DelegationProgress {
  return {
    partID: `part_${sessionID}`,
    sessionID,
    title: `Delegate ${sessionID}`,
    status,
    revision,
    messages: messages(sessionID, count, 100),
  }
}

const runGroup: RunGroup = {
  id: "group-one",
  title: "Compare implementations",
  repository: "/repo",
  baseRef: "main",
  promptReceiptID: "receipt",
  isolation: "worktree",
  createdAt: 50,
  runs: [{
    id: "run-one",
    model: "provider/model",
    agent: "build",
    session: {
      sessionID: "ses_child",
      directory: "/repo/run",
      experience: "workbench",
      transport: "http-sse",
      runtimeEpoch: "epoch",
    },
    worktreeID: "wt-one",
    phase: "working",
    startedAt: 75,
  }],
}

const worktrees: WorktreeJournalEntry[] = [{
  id: "wt-one",
  mutationID: "mutation-one",
  owner: "workbench",
  repository: "/repo",
  repositoryID: "repo",
  path: "/repo/run",
  branch: "workbench/run",
  baseRef: "main",
  phase: "session-ready",
  sessionID: "ses_child",
  createdAt: 40,
  updatedAt: 80,
}, {
  id: "wt-orphan",
  mutationID: "mutation-two",
  owner: "workbench",
  repository: "/repo",
  repositoryID: "repo",
  path: "/repo/orphan",
  branch: "workbench/orphan",
  baseRef: "main",
  phase: "cleanup-pending",
  createdAt: 30,
  updatedAt: 90,
}]

Deno.test("jobs deduplicate run child sessions and referenced worktrees into the authoritative run", () => {
  const jobs = new JobProjectionService().project({
    selectedSessionID: "ses_parent",
    delegations: [delegation("ses_child", { type: "busy" })],
    runGroups: [runGroup],
    worktrees,
  })

  assertEquals(jobs.map((job) => [job.id, job.group]), [
    ["worktree:wt-orphan", "needs-input"],
    ["run:group-one:run-one", "running"],
  ])
  assertEquals(jobs[1]!.sessionID, "ses_child")
  assertEquals(jobs[1]!.messageCount, 2)
  assertEquals(jobs[1]!.recentActivity?.at(-1), {
    messageID: "msg_ses_child_1",
    role: "assistant",
    tool: "bash",
    toolStatus: "running",
  })
})

Deno.test("jobs group selected OpenCode delegations and keep only the newest revision", () => {
  const jobs = new JobProjectionService({ recentActivityLimit: 2 }).project({
    selectedSessionID: "ses_parent",
    needsInputSessionIDs: ["ses_question"],
    delegations: [
      delegation("ses_done", { type: "idle" }, 1),
      delegation("ses_failed", { type: "error", message: "failed safely" }, 1),
      delegation("ses_question", { type: "busy" }, 1),
      delegation("ses_done", { type: "busy" }, 0),
    ],
  })

  assertEquals(jobs.map((job) => [job.sessionID, job.group]), [
    ["ses_question", "needs-input"],
    ["ses_failed", "failed"],
    ["ses_done", "completed"],
  ])
  assertEquals(jobs[2]!.parentSessionID, "ses_parent")
  assertEquals(jobs[1]!.error, "failed safely")
})

Deno.test("jobs use a joined OpenCode child state after standalone worktree preparation completes", () => {
  const jobs = new JobProjectionService().project({
    selectedSessionID: "ses_parent",
    delegations: [delegation("ses_child", { type: "busy" })],
    worktrees: [{ ...worktrees[0]!, id: "wt-standalone" }],
  })

  assertEquals(jobs.map((job) => [job.id, job.group, job.status]), [["worktree:wt-standalone", "running", "busy"]])
})

Deno.test("pending runs do not expose the repository as a created worktree", () => {
  const pendingGroup: RunGroup = {
    ...runGroup,
    runs: [{
      ...runGroup.runs[0]!,
      phase: "preparing",
      session: { ...runGroup.runs[0]!.session, sessionID: "pending", directory: runGroup.repository },
    }],
  }
  const jobs = new JobProjectionService().project({ runGroups: [pendingGroup] })

  assertEquals(jobs[0]?.sessionID, undefined)
  assertEquals(jobs[0]?.directory, undefined)
})

Deno.test("jobs are bounded, sorted by group then recency, and expose cloned bounded activity", () => {
  const source = delegation("ses_many", { type: "busy" }, 1, 5)
  const service = new JobProjectionService({ capacity: 1, recentActivityLimit: 2 })
  const jobs = service.project({ delegations: [delegation("ses_old", { type: "busy" }, 1, 1), source] })

  assertEquals(jobs.length, 1)
  assertEquals(jobs[0]!.sessionID, "ses_many")
  assertEquals(jobs[0]!.recentActivity?.map((entry) => entry.messageID), ["msg_ses_many_3", "msg_ses_many_4"])
  jobs[0]!.recentActivity![0]!.messageID = "mutated"
  assertEquals(service.project({ delegations: [source] })[0]!.recentActivity![0]!.messageID, "msg_ses_many_3")
})
