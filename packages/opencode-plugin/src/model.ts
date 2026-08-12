import { validateDurableText, validatePreferenceKey, validateSkillName } from "./security.ts"

export const STATE_VERSION = 1 as const
export const MAX_EVIDENCE = 200
export const PREFERENCE_CATEGORIES = [
  "communication",
  "coding_style",
  "tooling",
  "workflow",
  "accessibility",
  "other",
] as const

export type PreferenceCategory = (typeof PREFERENCE_CATEGORIES)[number]
export type Scope = { kind: "global" } | { kind: "project"; project: string }
export type Provenance = { sessionID: string; messageID: string; source: "explicit_tool" }
export type PreferenceStatus = "proposed" | "approved" | "rejected" | "superseded" | "forgotten"

export interface Preference {
  id: string
  scope: Scope
  category: PreferenceCategory
  key: string
  value: string
  status: PreferenceStatus
  provenance: Provenance
  createdAt: number
  approvedAt?: number
  rejectedAt?: number
  supersededAt?: number
  supersededBy?: string
  forgottenAt?: number
}

export type EvidenceKind = "skill_load" | "tool_failure" | "session_error" | "session_status"

export interface Evidence {
  id: string
  scope: Scope
  kind: EvidenceKind
  subject: string
  sessionID?: string
  messageID?: string
  callID?: string
  createdAt: number
}

export type SkillCandidateStatus = "proposed" | "staged" | "rejected"

export interface SkillCandidate {
  id: string
  scope: Scope
  name: string
  rationale: string
  evidenceIDs: string[]
  status: SkillCandidateStatus
  provenance: Provenance
  createdAt: number
  stagedAt?: number
  rejectedAt?: number
}

export interface PluginState {
  version: typeof STATE_VERSION
  preferences: Preference[]
  evidence: Evidence[]
  skillCandidates: SkillCandidate[]
}

export function emptyState(): PluginState {
  return { version: STATE_VERSION, preferences: [], evidence: [], skillCandidates: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown, max = 1_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isScope(value: unknown): value is Scope {
  if (!isRecord(value)) return false
  return value.kind === "global" || (value.kind === "project" && isString(value.project, 4_096))
}

function isProvenance(value: unknown): value is Provenance {
  return isRecord(value) && isString(value.sessionID, 256) && isString(value.messageID, 256) &&
    value.source === "explicit_tool"
}

function optionalTime(value: unknown): boolean {
  return value === undefined || isTime(value)
}

function isValidated(value: unknown, validate: (value: string) => string): value is string {
  if (typeof value !== "string") return false
  try {
    validate(value)
    return true
  } catch {
    return false
  }
}

function isPreference(value: unknown): value is Preference {
  if (!isRecord(value)) return false
  return isString(value.id, 128) && isScope(value.scope) &&
    PREFERENCE_CATEGORIES.includes(value.category as PreferenceCategory) &&
    isValidated(value.key, validatePreferenceKey) &&
    isValidated(value.value, (text) => validateDurableText(text, "value", 500)) &&
    ["proposed", "approved", "rejected", "superseded", "forgotten"].includes(String(value.status)) &&
    isProvenance(value.provenance) && isTime(value.createdAt) && optionalTime(value.approvedAt) &&
    optionalTime(value.rejectedAt) && optionalTime(value.supersededAt) && optionalTime(value.forgottenAt) &&
    (value.supersededBy === undefined || isString(value.supersededBy, 128))
}

function isEvidence(value: unknown): value is Evidence {
  if (!isRecord(value)) return false
  return isString(value.id, 128) && isScope(value.scope) &&
    ["skill_load", "tool_failure", "session_error", "session_status"].includes(String(value.kind)) &&
    isString(value.subject, 128) && isTime(value.createdAt) &&
    (value.sessionID === undefined || isString(value.sessionID, 256)) &&
    (value.messageID === undefined || isString(value.messageID, 256)) &&
    (value.callID === undefined || isString(value.callID, 256))
}

function isCandidate(value: unknown): value is SkillCandidate {
  if (!isRecord(value)) return false
  return isString(value.id, 128) && isScope(value.scope) && isValidated(value.name, validateSkillName) &&
    isValidated(value.rationale, (text) => validateDurableText(text, "rationale", 500)) &&
    Array.isArray(value.evidenceIDs) && value.evidenceIDs.length <= 50 &&
    value.evidenceIDs.every((id) => isString(id, 128)) &&
    ["proposed", "staged", "rejected"].includes(String(value.status)) &&
    isProvenance(value.provenance) && isTime(value.createdAt) && optionalTime(value.stagedAt) &&
    optionalTime(value.rejectedAt)
}

export function parseState(value: unknown): PluginState {
  if (
    !isRecord(value) || value.version !== STATE_VERSION || !Array.isArray(value.preferences) ||
    !Array.isArray(value.evidence) || !Array.isArray(value.skillCandidates) ||
    !value.preferences.every(isPreference) || !value.evidence.every(isEvidence) ||
    !value.skillCandidates.every(isCandidate)
  ) {
    throw new Error("Invalid or unsupported opencode-workbench state")
  }
  return value as unknown as PluginState
}

export function scopeFor(kind: "global" | "project", worktree: string): Scope {
  return kind === "global" ? { kind: "global" } : { kind: "project", project: worktree }
}

export function sameScope(left: Scope, right: Scope): boolean {
  return left.kind === right.kind &&
    (left.kind === "global" || (right.kind === "project" && left.project === right.project))
}

export function visibleInProject(scope: Scope, project: string): boolean {
  return scope.kind === "global" || scope.project === project
}
