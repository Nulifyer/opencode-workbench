import { randomUUID } from "node:crypto"
import { validateReview, type ReviewDocument, type ReviewFinding } from "@opencode-workbench/shared"
import type { DiffCapture } from "./diff-service.js"
import type { WalkthroughInvocation } from "./walkthrough-service.js"

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }

export class ReviewService {
  constructor(private readonly maximumDiffBytes = 500_000, private readonly promptVersion = "1") {}

  async generate(capture: DiffCapture, model: string, invoke: (input: WalkthroughInvocation) => Promise<string>): Promise<ReviewDocument> {
    if (!capture.snapshot.complete) throw new Error(`Review requires a complete diff: ${capture.snapshot.truncationReason ?? "unknown"}`)
    if (Buffer.byteLength(capture.unifiedDiff) > this.maximumDiffBytes) throw new Error(`Review diff exceeds ${this.maximumDiffBytes} bytes; no content was silently truncated`)
    const prompt = `Review the attached exact Git diff. Return JSON only: {"findings":[{"title":string,"detail":string,"category":"correctness"|"security"|"performance"|"maintainability"|"tests"|"regression","severity":"critical"|"high"|"medium"|"low","anchors":[{"file":string,"side":"base"|"modified","startLine":number,"endLine":number,"hunkHeader"?:string}]}]}. Findings are model assessments, not deterministic facts. Every finding must have an exact diff anchor. Return an empty findings array when no issue is found.`
    const raw = (await invoke({ prompt, unifiedDiff: capture.unifiedDiff, model })).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    const parsed: unknown = JSON.parse(raw)
    if (!record(parsed) || !Array.isArray(parsed.findings) || parsed.findings.length > 100) throw new Error("OpenCode returned an invalid review")
    const findings: ReviewFinding[] = parsed.findings.map((finding) => {
      if (!record(finding) || typeof finding.title !== "string" || typeof finding.detail !== "string" || !["correctness", "security", "performance", "maintainability", "tests", "regression"].includes(String(finding.category)) || !["critical", "high", "medium", "low"].includes(String(finding.severity)) || !Array.isArray(finding.anchors) || !finding.anchors.length) throw new Error("OpenCode returned an invalid review finding")
      return {
        id: randomUUID(), title: finding.title.slice(0, 500), detail: finding.detail.slice(0, 10_000), category: finding.category as ReviewFinding["category"], severity: finding.severity as ReviewFinding["severity"],
        anchors: finding.anchors.map((anchor) => {
          if (!record(anchor) || typeof anchor.file !== "string" || !["base", "modified"].includes(String(anchor.side)) || !Number.isSafeInteger(anchor.startLine) || !Number.isSafeInteger(anchor.endLine)) throw new Error("OpenCode returned an invalid review anchor")
          return { file: anchor.file, side: anchor.side as "base" | "modified", startLine: Number(anchor.startLine), endLine: Number(anchor.endLine), hunkHeader: typeof anchor.hunkHeader === "string" ? anchor.hunkHeader : undefined }
        }),
      }
    })
    const document: ReviewDocument = { id: randomUUID(), diffHash: capture.snapshot.unifiedDiffHash, model, promptVersion: this.promptVersion, generatedAt: Date.now(), findings }
    validateReview(document, capture.snapshot)
    return document
  }
}
