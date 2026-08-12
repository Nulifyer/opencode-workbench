import { createHash } from "node:crypto"
import type { FileChange, MessageBundle, RecoveryPreview, SessionStatus } from "@opencode-workbench/shared"

export type RecoveryPreviewIntent = "recover" | "redo"

export interface RecoveryPreviewInput {
  sessionID: string
  status: SessionStatus
  messages: readonly MessageBundle[]
  changes: readonly FileChange[]
  intent?: RecoveryPreviewIntent
  messageID?: string
  /** OpenCode's current revert marker, when present, is the sole authority for redo availability. */
  revertMessageID?: string
}

export interface RecoveryPreviewCandidate {
  input: RecoveryPreviewInput
  preview: RecoveryPreview
}

interface DeliveredRecoveryPreview {
  preview: RecoveryPreview
  fingerprint: string
}

const MAX_REMOVED_MESSAGES = 5_000
const MAX_CHANGED_FILES = 500
const MAX_ID_CHARACTERS = 1_024
const MAX_FILE_CHARACTERS = 8_192
const MAX_USER_TEXT_CHARACTERS = 20_000

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARACTERS &&
    !/[\u0000-\u001f\u007f]/.test(value)
}

function changedFile(change: FileChange): RecoveryPreview["changedFiles"][number] {
  if (!change.file || change.file.length > MAX_FILE_CHARACTERS || /[\u0000-\u001f\u007f]/.test(change.file)) {
    throw new Error("OpenCode returned an invalid changed-file path")
  }
  if (
    !Number.isSafeInteger(change.additions) || change.additions < 0 || !Number.isSafeInteger(change.deletions) ||
    change.deletions < 0
  ) {
    throw new Error("OpenCode returned invalid changed-file totals")
  }
  return { file: change.file, additions: change.additions, deletions: change.deletions }
}

function userText(message: MessageBundle): { text: string; truncated: boolean } {
  const full = message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
  return { text: full.slice(0, MAX_USER_TEXT_CHARACTERS), truncated: full.length > MAX_USER_TEXT_CHARACTERS }
}

function recoveryFingerprint(input: RecoveryPreviewInput, preview: RecoveryPreview): string {
  const digest = createHash("sha256")
  const append = (value: unknown): void => {
    const encoded = JSON.stringify(value) ?? "undefined"
    digest.update(`${encoded.length}:`)
    digest.update(encoded)
    digest.update("\0")
  }
  append(input.sessionID)
  append(input.intent ?? "recover")
  append(input.status)
  append(input.messages.length)
  for (const message of input.messages) append(message)
  append(input.changes.length)
  for (const change of input.changes) append(change)
  append(input.revertMessageID)
  append(preview)
  return digest.digest("base64url")
}

/**
 * One-shot, per-surface authority for a recovery confirmation. The recorded hash
 * includes the complete host transcript/change/status input as well as the exact
 * bounded preview sent to the user.
 */
export class RecoveryPreviewGuard<Source> {
  private readonly delivered = new Map<Source, DeliveredRecoveryPreview>()

  remember(source: Source, candidate: RecoveryPreviewCandidate): void {
    this.delivered.set(source, {
      preview: candidate.preview,
      fingerprint: recoveryFingerprint(candidate.input, candidate.preview),
    })
  }

  consume(source: Source, current: (delivered: RecoveryPreview) => RecoveryPreviewCandidate): RecoveryPreview {
    const delivered = this.delivered.get(source)
    this.delivered.delete(source)
    if (!delivered) throw new Error("Recovery preview is missing or stale; request a new preview")
    const candidate = current(delivered.preview)
    if (recoveryFingerprint(candidate.input, candidate.preview) !== delivered.fingerprint) {
      throw new Error("The OpenCode transcript, changes, or recovery state changed; request a fresh recovery preview")
    }
    return delivered.preview
  }

  invalidate(source: Source): void {
    this.delivered.delete(source)
  }

  clear(): void {
    this.delivered.clear()
  }
}

/** Builds a side-effect-free description of an OpenCode revert boundary. */
export class RecoveryPreviewService {
  preview(input: RecoveryPreviewInput): RecoveryPreview {
    if (!validID(input.sessionID)) throw new Error("Invalid recovery session ID")
    if (input.status.type !== "idle") throw new Error("Recovery preview requires an idle OpenCode session")
    if (input.changes.length > MAX_CHANGED_FILES) throw new Error("Recovery preview changed-file limit exceeded")

    const seen = new Set<string>()
    for (const message of input.messages) {
      if (!validID(message.info.id) || seen.has(message.info.id)) {
        throw new Error("Recovery preview requires unique valid transcript message IDs")
      }
      seen.add(message.info.id)
    }

    const changedFiles = input.changes.map(changedFile)
    if (input.intent === "redo") {
      const revertMessageID = input.revertMessageID
      if (!validID(revertMessageID)) throw new Error("Redo requires a native OpenCode revert marker")
      if (input.messageID !== undefined && input.messageID !== revertMessageID) {
        throw new Error("Redo target must match OpenCode's native revert marker")
      }
      const target = input.messages.find((message) =>
        message.info.id === revertMessageID && message.info.role === "user"
      )
      const prompt = target ? userText(target) : { text: "", truncated: false }
      const limitations = [
        "Redo is available only while OpenCode reports this native revert marker.",
        "OpenCode controls the coupled transcript-and-file restoration; files-only and transcript-only redo are unavailable.",
        "Shell commands, external services, manual edits, and other side effects are outside native redo.",
        "File totals are the current OpenCode session summary, not the exact native-redo delta.",
      ]
      if (prompt.truncated) {
        limitations.push(
          "The displayed boundary message is truncated to 20,000 characters; the native revert marker is unchanged.",
        )
      }
      if (!input.changes.length) limitations.push("OpenCode currently reports no changed files for this session.")
      return {
        sessionID: input.sessionID,
        messageID: revertMessageID,
        userText: prompt.text,
        removedMessageIDs: [],
        removedTurns: 0,
        changedFiles,
        limitations,
        canRevert: false,
        canFork: false,
        canRedo: true,
      }
    }

    const requestedID = input.messageID
    if (requestedID !== undefined && !validID(requestedID)) throw new Error("Invalid recovery message ID")
    let targetIndex = requestedID === undefined
      ? -1
      : input.messages.findIndex((message) => message.info.id === requestedID)
    if (requestedID === undefined) {
      for (let index = input.messages.length - 1; index >= 0; index -= 1) {
        if (input.messages[index]?.info.role !== "user") continue
        targetIndex = index
        break
      }
    }
    if (targetIndex < 0) {
      throw new Error(requestedID ? "Recovery message was not found" : "Recovery requires a user message")
    }
    const target = input.messages[targetIndex]!
    if (target.info.role !== "user") throw new Error("Recovery target must be a user message")

    const tail = input.messages.slice(targetIndex)
    if (tail.length > MAX_REMOVED_MESSAGES) throw new Error("Recovery transcript tail exceeds the exact-preview limit")
    const removedMessageIDs = tail.map((message) => message.info.id)
    const removedTurns = tail.filter((message) => message.info.role === "user").length
    const prompt = userText(target)
    const limitations = [
      "File totals are the current OpenCode session summary, not exact per-message attribution.",
      "Shell commands, external services, manual edits, and other side effects may not be reversible.",
    ]
    if (prompt.truncated) {
      limitations.push(
        "The displayed user message is truncated to 20,000 characters; the revert boundary is unchanged.",
      )
    }
    if (!input.changes.length) limitations.push("OpenCode currently reports no changed files for this session.")

    return {
      sessionID: input.sessionID,
      messageID: target.info.id,
      userText: prompt.text,
      removedMessageIDs,
      removedTurns,
      changedFiles,
      limitations,
      canRevert: true,
      canFork: true,
      canRedo: false,
    }
  }
}
