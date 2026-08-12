import type { MessageBundle } from "@opencode-workbench/shared"

export interface ObjectiveRunObservation {
  tokens?: number
  cost?: number
  verifierState?: string
  assistantSummary?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function tokenTotal(value: unknown): number | undefined {
  if (!record(value)) return undefined
  const cache = record(value.cache) ? value.cache : undefined
  const values = [
    value.input,
    value.output,
    value.reasoning,
    value.cacheRead ?? cache?.read,
    value.cacheWrite ?? cache?.write,
  ]
  return values.some((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)
    ? values.reduce<number>((total, entry) => total + count(entry), 0)
    : undefined
}

function goalState(messages: MessageBundle[]): string | undefined {
  for (const message of messages.slice().reverse()) {
    for (const part of message.parts.slice().reverse()) {
      if (
        part.type !== "tool" ||
        !["get_goal", "update_goal", "record_goal_verdict", "configure_goal_verification"].includes(part.tool ?? "") ||
        typeof part.state?.output !== "string" || part.state.output.length > 64 * 1024
      ) continue
      try {
        const parsed = JSON.parse(part.state.output)
        const goal = record(parsed) && record(parsed.goal) ? parsed.goal : undefined
        if (!goal) continue
        const status = typeof goal.status === "string" ? goal.status : "unknown"
        const latest = record(goal.latestVerdict) && typeof goal.latestVerdict.verdict === "string"
          ? goal.latestVerdict.verdict
          : undefined
        return latest ? `${status} / ${latest}` : status
      } catch {
        // Ignore malformed or non-goal tool output.
      }
    }
  }
  return undefined
}

export function observeRunMessages(messages: MessageBundle[]): ObjectiveRunObservation {
  const assistant = messages.slice().reverse().find((message) => message.info.role === "assistant")
  const finish = assistant?.parts.slice().reverse().find((part) => part.type === "step-finish")
  let cost = 0
  let hasCost = false
  for (const message of messages) {
    if (
      message.info.role !== "assistant" || typeof message.info.cost !== "number" ||
      !Number.isFinite(message.info.cost) || message.info.cost < 0
    ) continue
    cost += message.info.cost
    hasCost = true
  }
  const summary = assistant?.parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join(
    "\n",
  ).trim()
  return {
    tokens: tokenTotal(finish?.tokens) ?? tokenTotal(assistant?.info.tokens),
    cost: hasCost ? cost : undefined,
    verifierState: goalState(messages),
    assistantSummary: summary || undefined,
  }
}
