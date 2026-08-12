import {
  type Evidence,
  MAX_EVIDENCE,
  type PluginState,
  type Provenance,
  sameScope,
  type Scope,
  type SkillCandidate,
  visibleInProject,
} from "./model.ts"
import { LIMITS, validateDurableText, validateSkillName } from "./security.ts"

export interface CandidateProposal {
  scope: Scope
  name: string
  rationale: string
  evidenceIDs: string[]
  provenance: Provenance
}

export function proposeCandidate(
  state: PluginState,
  proposal: CandidateProposal,
  now: number,
  id: string,
): SkillCandidate {
  const evidenceIDs = [...new Set(proposal.evidenceIDs)]
  if (evidenceIDs.length > 50) throw new Error("A candidate may reference at most 50 evidence records")
  for (const evidenceID of evidenceIDs) {
    const evidence = state.evidence.find((item) => item.id === evidenceID)
    if (!evidence || !sameScope(evidence.scope, proposal.scope)) {
      throw new Error(`Evidence ${evidenceID} does not exist in the candidate scope`)
    }
  }
  const candidate: SkillCandidate = {
    id,
    scope: proposal.scope,
    name: validateSkillName(proposal.name),
    rationale: validateDurableText(proposal.rationale, "rationale", LIMITS.rationale),
    evidenceIDs,
    status: "proposed",
    provenance: proposal.provenance,
    createdAt: now,
  }
  state.skillCandidates.push(candidate)
  return candidate
}

export function decideCandidate(
  state: PluginState,
  id: string,
  decision: "approve" | "reject",
  now: number,
  project: string,
): SkillCandidate {
  const candidate = state.skillCandidates.find((item) => item.id === id)
  if (!candidate) throw new Error(`Unknown skill candidate: ${id}`)
  if (!visibleInProject(candidate.scope, project)) throw new Error(`Unknown skill candidate: ${id}`)
  if (candidate.status !== "proposed") throw new Error(`Skill candidate ${id} is ${candidate.status}, not proposed`)
  if (decision === "approve") {
    candidate.status = "staged"
    candidate.stagedAt = now
  } else {
    candidate.status = "rejected"
    candidate.rejectedAt = now
  }
  return candidate
}

export function listCandidates(
  state: PluginState,
  project: string,
  options: { query?: string; status?: SkillCandidate["status"]; scope?: "global" | "project" | "all" },
): SkillCandidate[] {
  const term = options.query?.trim().toLocaleLowerCase()
  return state.skillCandidates.filter((candidate) => {
    if (!visibleInProject(candidate.scope, project)) return false
    if (options.scope && options.scope !== "all" && candidate.scope.kind !== options.scope) return false
    if (options.status && candidate.status !== options.status) return false
    return !term || `${candidate.name} ${candidate.rationale}`.toLocaleLowerCase().includes(term)
  }).sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
}

export function listEvidence(
  state: PluginState,
  project: string,
  query?: string,
): Evidence[] {
  const term = query?.trim().toLocaleLowerCase()
  return state.evidence.filter((evidence) =>
    visibleInProject(evidence.scope, project) &&
    (!term || `${evidence.kind} ${evidence.subject}`.toLocaleLowerCase().includes(term))
  )
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
}

export function appendEvidence(state: PluginState, evidence: Evidence): void {
  const duplicate = state.evidence.some((item) =>
    item.kind === evidence.kind && item.subject === evidence.subject &&
    item.sessionID === evidence.sessionID && item.messageID === evidence.messageID && item.callID === evidence.callID
  )
  if (duplicate) return
  state.evidence.push(evidence)
  if (state.evidence.length > MAX_EVIDENCE) state.evidence.splice(0, state.evidence.length - MAX_EVIDENCE)
}
