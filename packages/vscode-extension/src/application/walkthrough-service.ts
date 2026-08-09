import { randomUUID } from "node:crypto"
import { validateWalkthrough, type WalkthroughDocument, type WalkthroughStop } from "@opencode-workbench/shared"
import type { DiffCapture } from "./diff-service.js"

export interface WalkthroughInvocation {
  prompt: string
  unifiedDiff: string
  model: string
}

function parseJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  return JSON.parse(trimmed)
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }

const MAX_WALKTHROUGHS = 100

export class WalkthroughService {
  private readonly cache = new Map<string, WalkthroughDocument>()

  constructor(initial: WalkthroughDocument[] = [], private readonly persist?: (documents: WalkthroughDocument[]) => void, private readonly maximumDiffBytes = 500_000, private readonly promptVersion = "1") {
    for (const document of initial.slice(-MAX_WALKTHROUGHS)) this.cache.set(this.key(document.diffHash, document.model, document.language), structuredClone(document))
  }

  list(): WalkthroughDocument[] { return [...this.cache.values()].map((document) => structuredClone(document)) }

  async generate(capture: DiffCapture, model: string, invoke: (input: WalkthroughInvocation) => Promise<string>, language = "en"): Promise<WalkthroughDocument> {
    if (!capture.snapshot.complete) throw new Error(`Walkthrough requires a complete diff: ${capture.snapshot.truncationReason ?? "unknown limitation"}`)
    if (!capture.unifiedDiff.trim()) throw new Error("There are no changes to walk through")
    if (Buffer.byteLength(capture.unifiedDiff) > this.maximumDiffBytes) throw new Error(`Walkthrough diff exceeds ${this.maximumDiffBytes} bytes; no content was silently truncated`)
    const key = this.key(capture.snapshot.unifiedDiffHash, model, language)
    const cached = this.cache.get(key)
    if (cached) return structuredClone(cached)
    const prompt = `Explain the attached exact Git diff as JSON only. Schema: {"coverage":"complete"|"partial","uncoveredFiles":string[],"stops":[{"title":string,"explanation":string,"importance":"key-change"|"normal"|"context","anchors":[{"file":string,"side":"base"|"modified","startLine":number,"endLine":number,"hunkHeader"?:string}]}]}. Every anchor must reference an exact file and hunk in the diff. Do not invent files or claim complete coverage if any file is omitted. Language: ${language}.`
    const parsed = parseJson(await invoke({ prompt, unifiedDiff: capture.unifiedDiff, model }))
    if (!record(parsed) || !Array.isArray(parsed.stops) || parsed.stops.length > 100 || !["complete", "partial"].includes(String(parsed.coverage))) throw new Error("OpenCode returned an invalid walkthrough document")
    const stops: WalkthroughStop[] = parsed.stops.map((value) => {
      if (!record(value) || typeof value.title !== "string" || typeof value.explanation !== "string" || !["key-change", "normal", "context"].includes(String(value.importance)) || !Array.isArray(value.anchors) || value.anchors.length > 20) throw new Error("OpenCode returned an invalid walkthrough stop")
      return {
        id: randomUUID(), title: value.title.slice(0, 500), explanation: value.explanation.slice(0, 10_000), importance: value.importance as WalkthroughStop["importance"],
        anchors: value.anchors.map((anchor) => {
          if (!record(anchor) || typeof anchor.file !== "string" || !["base", "modified"].includes(String(anchor.side)) || !Number.isSafeInteger(anchor.startLine) || !Number.isSafeInteger(anchor.endLine)) throw new Error("OpenCode returned an invalid walkthrough anchor")
          return { file: anchor.file.slice(0, 8_192), side: anchor.side as "base" | "modified", startLine: Number(anchor.startLine), endLine: Number(anchor.endLine), hunkHeader: typeof anchor.hunkHeader === "string" ? anchor.hunkHeader.slice(0, 1_024) : undefined }
        }),
      }
    })
    const document: WalkthroughDocument = {
      id: randomUUID(), diffHash: capture.snapshot.unifiedDiffHash, model, promptVersion: this.promptVersion, language, generatedAt: Date.now(), stops,
      coverage: parsed.coverage as "complete" | "partial", uncoveredFiles: Array.isArray(parsed.uncoveredFiles) ? parsed.uncoveredFiles.filter((value): value is string => typeof value === "string").slice(0, 1_000) : undefined,
    }
    validateWalkthrough(document, capture.snapshot)
    this.cache.set(key, document)
    while (this.cache.size > MAX_WALKTHROUGHS) this.cache.delete(this.cache.keys().next().value!)
    this.persist?.(this.list())
    return structuredClone(document)
  }

  private key(diffHash: string, model: string, language: string): string { return `${diffHash}\0${model}\0${this.promptVersion}\0${language}` }
}
