import { createHash, randomUUID } from "node:crypto"
import type { PlanReference } from "@opencode-workbench/shared"

export function structuredPlanPrompt(objective: string): string {
  const task = objective.trim()
  if (!task || task.length > 20_000) throw new Error("Plan objective must contain 1-20,000 characters")
  return `Create an implementation plan for the following task. Stay read-only. Return Markdown with: scope and assumptions, numbered implementation steps, files/components affected, validation, risks, and explicit handoff criteria.\n\nTask:\n${task}`
}

export function planArtifact(objective: string, result?: string, sessionID?: string): string {
  const body = result?.trim() || "_OpenCode is preparing the plan…_"
  return `# Implementation Plan\n\n> Objective: ${objective.trim()}\n${sessionID ? `> OpenCode session: ${sessionID}\n` : ""}\n${body}\n\n---\n\nEdit this artifact, then run **OpenCode: Handoff Approved Plan**.\n`
}

export function createPlanReference(uri: string, content: string, approvedAt?: number): PlanReference {
  if (!uri || uri.length > 8_192) throw new Error("Invalid plan URI")
  return { id: randomUUID(), uri, revision: `sha256:${createHash("sha256").update(content).digest("hex")}`, approvedAt }
}

export function generatedPlanDisposition(initialDocumentVersion: number, currentDocumentVersion: number): "replace-placeholder" | "preserve-user-draft" {
  if (!Number.isSafeInteger(initialDocumentVersion) || !Number.isSafeInteger(currentDocumentVersion) || initialDocumentVersion < 1 || currentDocumentVersion < 1) throw new Error("Invalid plan document version")
  return initialDocumentVersion === currentDocumentVersion ? "replace-placeholder" : "preserve-user-draft"
}
