import { createHash, randomUUID } from "node:crypto"
import {
  TASK_ARTIFACT_SCHEMA_VERSION,
  normalizeTaskArtifact,
  type TaskArtifact,
} from "@opencode-workbench/shared"

export const TASK_ARTIFACT_CAPACITY = 500
export const TASK_ARTIFACT_STATE_BYTE_LIMIT = 8 * 1024 * 1024
const TASK_ARTIFACT_MUTATION_CAPACITY = 2_000

export type NewTaskArtifact = TaskArtifact extends infer Artifact
  ? Artifact extends TaskArtifact
    ? Omit<Artifact, "schemaVersion" | "id" | "revision" | "createdAt" | "updatedAt">
    : never
  : never

export interface TaskArtifactMutationRecord {
  id: string
  operation: "create" | "update" | "remove"
  fingerprint: string
  sessionID: string
  artifactID: string
  resultRevision?: number
  removed: boolean
  createdAt: number
}

export interface TaskArtifactState {
  schemaVersion: typeof TASK_ARTIFACT_SCHEMA_VERSION
  artifacts: TaskArtifact[]
  mutations: TaskArtifactMutationRecord[]
}

type PersistTaskArtifacts = (state: TaskArtifactState) => void
type ReportTaskArtifactProblem = (message: string) => void

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function encodedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error("Task artifact state must be JSON serializable")
  return new TextEncoder().encode(serialized).byteLength
}

function mutationID(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,1024}$/.test(value)) throw new Error("Task artifact mutation ID is invalid")
  return value
}

function normalizeMutation(value: unknown): TaskArtifactMutationRecord {
  const candidate = record(value)
  if (!candidate || !exactKeys(candidate, ["id", "operation", "fingerprint", "sessionID", "artifactID", "resultRevision", "removed", "createdAt"])) throw new Error("Task artifact mutation record is invalid")
  if (!["create", "update", "remove"].includes(String(candidate.operation))) throw new Error("Task artifact mutation operation is invalid")
  if (typeof candidate.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(candidate.fingerprint)) throw new Error("Task artifact mutation fingerprint is invalid")
  if (typeof candidate.sessionID !== "string" || !candidate.sessionID || candidate.sessionID.length > 1_024) throw new Error("Task artifact mutation session ID is invalid")
  if (typeof candidate.artifactID !== "string" || !candidate.artifactID || candidate.artifactID.length > 1_024) throw new Error("Task artifact mutation artifact ID is invalid")
  if (typeof candidate.removed !== "boolean") throw new Error("Task artifact mutation removal flag is invalid")
  if (!Number.isSafeInteger(candidate.createdAt) || Number(candidate.createdAt) < 0) throw new Error("Task artifact mutation timestamp is invalid")
  if (candidate.resultRevision !== undefined && (!Number.isSafeInteger(candidate.resultRevision) || Number(candidate.resultRevision) < 1)) throw new Error("Task artifact mutation result revision is invalid")
  if (candidate.removed === (candidate.resultRevision !== undefined)) throw new Error("Task artifact mutation result is inconsistent")
  return {
    id: mutationID(candidate.id),
    operation: candidate.operation as TaskArtifactMutationRecord["operation"],
    fingerprint: candidate.fingerprint,
    sessionID: candidate.sessionID,
    artifactID: candidate.artifactID,
    resultRevision: candidate.resultRevision as number | undefined,
    removed: candidate.removed,
    createdAt: Number(candidate.createdAt),
  }
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function emptyState(): TaskArtifactState {
  return { schemaVersion: TASK_ARTIFACT_SCHEMA_VERSION, artifacts: [], mutations: [] }
}

/**
 * Durable, metadata-only task artifacts indexed by canonical OpenCode session
 * IDs. The service owns no model loop and never stores plan prompts, plan
 * bodies, raw diffs, or context payload bytes.
 */
export class TaskArtifactService {
  private state: TaskArtifactState = emptyState()

  constructor(
    raw: unknown,
    private readonly persist?: PersistTaskArtifacts,
    private readonly report?: ReportTaskArtifactProblem,
  ) {
    this.restore(raw)
  }

  list(sessionID?: string): TaskArtifact[] {
    return this.state.artifacts
      .filter((artifact) => sessionID === undefined || artifact.sessionID === sessionID)
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .map(clone)
  }

  get(sessionID: string, artifactID: string): TaskArtifact | undefined {
    const artifact = this.state.artifacts.find((candidate) => candidate.sessionID === sessionID && candidate.id === artifactID)
    return artifact ? clone(artifact) : undefined
  }

  create(input: NewTaskArtifact, requestMutationID?: string): TaskArtifact {
    const template = normalizeTaskArtifact({
      ...clone(input),
      schemaVersion: TASK_ARTIFACT_SCHEMA_VERSION,
      id: "pending-artifact",
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    const operationFingerprint = fingerprint({ operation: "create", input: template })
    if (requestMutationID !== undefined) {
      const replay = this.replay(requestMutationID, "create", operationFingerprint)
      if (replay) return replay
    }
    if (this.state.artifacts.length >= TASK_ARTIFACT_CAPACITY) throw new Error(`Task artifact capacity of ${TASK_ARTIFACT_CAPACITY} has been reached`)
    const now = Date.now()
    const artifact = normalizeTaskArtifact({ ...template, id: randomUUID(), createdAt: now, updatedAt: now })
    const next = clone(this.state)
    next.artifacts.push(artifact)
    if (requestMutationID !== undefined) this.addMutation(next, {
      id: mutationID(requestMutationID), operation: "create", fingerprint: operationFingerprint,
      sessionID: artifact.sessionID, artifactID: artifact.id, resultRevision: artifact.revision, removed: false, createdAt: now,
    })
    this.commit(next)
    return clone(artifact)
  }

  update(
    sessionID: string,
    artifactID: string,
    expectedRevision: number,
    mutate: (draft: TaskArtifact) => void,
    requestMutationID?: string,
  ): TaskArtifact {
    const operationFingerprint = fingerprint({ operation: "update", sessionID, artifactID, expectedRevision })
    if (requestMutationID !== undefined) {
      const replay = this.replay(requestMutationID, "update", operationFingerprint)
      if (replay) return replay
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Expected task artifact revision is invalid")
    const index = this.state.artifacts.findIndex((candidate) => candidate.sessionID === sessionID && candidate.id === artifactID)
    if (index < 0) throw new Error("Task artifact was not found")
    const current = this.state.artifacts[index]!
    if (current.revision !== expectedRevision) throw new Error(`Task artifact revision is stale; expected ${current.revision}`)
    const draft = clone(current)
    mutate(draft)
    const updated = normalizeTaskArtifact({
      ...draft,
      schemaVersion: current.schemaVersion,
      id: current.id,
      kind: current.kind,
      sessionID: current.sessionID,
      createdAt: current.createdAt,
      revision: current.revision + 1,
      updatedAt: Math.max(Date.now(), current.updatedAt),
    })
    const next = clone(this.state)
    next.artifacts[index] = updated
    if (requestMutationID !== undefined) this.addMutation(next, {
      id: mutationID(requestMutationID), operation: "update", fingerprint: operationFingerprint,
      sessionID, artifactID, resultRevision: updated.revision, removed: false, createdAt: Date.now(),
    })
    this.commit(next)
    return clone(updated)
  }

  archive(sessionID: string, artifactID: string, expectedRevision: number, requestMutationID?: string): TaskArtifact {
    return this.update(sessionID, artifactID, expectedRevision, (artifact) => { artifact.lifecycle = "archived" }, requestMutationID)
  }

  remove(sessionID: string, artifactID: string, expectedRevision: number, requestMutationID?: string): boolean {
    const operationFingerprint = fingerprint({ operation: "remove", sessionID, artifactID, expectedRevision })
    if (requestMutationID !== undefined) {
      const replay = this.replayMutation(requestMutationID, "remove", operationFingerprint)
      if (replay) return replay.removed
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Expected task artifact revision is invalid")
    const index = this.state.artifacts.findIndex((candidate) => candidate.sessionID === sessionID && candidate.id === artifactID)
    if (index < 0) throw new Error("Task artifact was not found")
    const current = this.state.artifacts[index]!
    if (current.revision !== expectedRevision) throw new Error(`Task artifact revision is stale; expected ${current.revision}`)
    const next = clone(this.state)
    next.artifacts.splice(index, 1)
    if (requestMutationID !== undefined) this.addMutation(next, {
      id: mutationID(requestMutationID), operation: "remove", fingerprint: operationFingerprint,
      sessionID, artifactID, removed: true, createdAt: Date.now(),
    })
    this.commit(next)
    return true
  }

  snapshot(): TaskArtifactState {
    return clone(this.state)
  }

  private restore(raw: unknown): void {
    if (raw === undefined || raw === null) return
    const source = record(raw)
    if (!source || !exactKeys(source, ["schemaVersion", "artifacts", "mutations"]) || source.schemaVersion !== TASK_ARTIFACT_SCHEMA_VERSION || !Array.isArray(source.artifacts) || !Array.isArray(source.mutations)) {
      this.reportProblem("Ignored invalid or unsupported task artifact state")
      return
    }
    const restored = emptyState()
    const artifactIDs = new Set<string>()
    for (let index = 0; index < source.artifacts.length; index += 1) {
      try {
        if (restored.artifacts.length >= TASK_ARTIFACT_CAPACITY) throw new Error(`capacity exceeds ${TASK_ARTIFACT_CAPACITY}`)
        const artifact = normalizeTaskArtifact(source.artifacts[index])
        if (artifactIDs.has(artifact.id)) throw new Error(`duplicate artifact ID ${artifact.id}`)
        const candidate = { ...restored, artifacts: [...restored.artifacts, artifact] }
        this.assertSize(candidate)
        restored.artifacts.push(artifact)
        artifactIDs.add(artifact.id)
      } catch (error) {
        this.reportProblem(`Ignored corrupt task artifact at index ${index}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const mutationIDs = new Set<string>()
    for (let index = 0; index < source.mutations.length; index += 1) {
      try {
        if (restored.mutations.length >= TASK_ARTIFACT_MUTATION_CAPACITY) throw new Error(`mutation capacity exceeds ${TASK_ARTIFACT_MUTATION_CAPACITY}`)
        const mutation = normalizeMutation(source.mutations[index])
        if (mutationIDs.has(mutation.id)) throw new Error(`duplicate mutation ID ${mutation.id}`)
        if (!mutation.removed && !artifactIDs.has(mutation.artifactID)) throw new Error("mutation references a missing artifact")
        const candidate = { ...restored, mutations: [...restored.mutations, mutation] }
        this.assertSize(candidate)
        restored.mutations.push(mutation)
        mutationIDs.add(mutation.id)
      } catch (error) {
        this.reportProblem(`Ignored corrupt task artifact mutation at index ${index}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.state = restored
  }

  private replay(requestMutationID: string, operation: TaskArtifactMutationRecord["operation"], operationFingerprint: string): TaskArtifact | undefined {
    const mutation = this.replayMutation(requestMutationID, operation, operationFingerprint)
    if (!mutation) return undefined
    if (mutation.removed) throw new Error("Task artifact mutation result was removed")
    const artifact = this.state.artifacts.find((candidate) => candidate.id === mutation.artifactID && candidate.sessionID === mutation.sessionID)
    if (!artifact) throw new Error("Task artifact mutation references a missing result")
    return clone(artifact)
  }

  private replayMutation(requestMutationID: string, operation: TaskArtifactMutationRecord["operation"], operationFingerprint: string): TaskArtifactMutationRecord | undefined {
    const id = mutationID(requestMutationID)
    const previous = this.state.mutations.find((candidate) => candidate.id === id)
    if (!previous) return undefined
    if (previous.operation !== operation || previous.fingerprint !== operationFingerprint) throw new Error("Task artifact mutation ID was reused for a different operation")
    return previous
  }

  private addMutation(state: TaskArtifactState, mutation: TaskArtifactMutationRecord): void {
    if (state.mutations.length >= TASK_ARTIFACT_MUTATION_CAPACITY) throw new Error(`Task artifact mutation capacity of ${TASK_ARTIFACT_MUTATION_CAPACITY} has been reached`)
    state.mutations.push(normalizeMutation(mutation))
  }

  private commit(next: TaskArtifactState): void {
    if (next.artifacts.length > TASK_ARTIFACT_CAPACITY) throw new Error(`Task artifact capacity of ${TASK_ARTIFACT_CAPACITY} has been exceeded`)
    this.assertSize(next)
    const snapshot = clone(next)
    this.persist?.(snapshot)
    this.state = next
  }

  private assertSize(state: TaskArtifactState): void {
    if (encodedBytes(state) > TASK_ARTIFACT_STATE_BYTE_LIMIT) throw new Error(`Task artifact state exceeds the ${TASK_ARTIFACT_STATE_BYTE_LIMIT}-byte limit`)
  }

  private reportProblem(message: string): void {
    try {
      this.report?.(message)
    } catch {
      // Diagnostics must not prevent recovery of otherwise valid artifacts.
    }
  }
}
