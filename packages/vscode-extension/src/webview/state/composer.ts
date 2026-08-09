import type { ContextAttachmentSummary, InlineAttachment, PastedTextBlock } from "@opencode-workbench/shared"

export type ComposerPayloadState = { attachments: InlineAttachment[]; pastedText: PastedTextBlock[] }
export type PendingComposerPayload = ComposerPayloadState & { revision: number; mutationID: string; base: ComposerPayloadState }

export class ComposerState {
  readonly localDrafts = new Map<string, string>()
  readonly draftRevisions = new Map<string, number>()
  readonly submittedDrafts = new Map<string, string>()
  readonly attachments = new Map<string, InlineAttachment[]>()
  readonly attachmentThumbnails = new Map<string, string>()
  readonly composerPayloadRevisions = new Map<string, number>()
  readonly acknowledgedComposerPayloads = new Map<string, ComposerPayloadState>()
  readonly pendingComposerPayloads = new Map<string, PendingComposerPayload>()
  readonly pastedText = new Map<string, PastedTextBlock[]>()
  readonly contextAttachments = new Map<string, ContextAttachmentSummary[]>()
  readonly stashedDrafts = new Map<string, string>()
}
