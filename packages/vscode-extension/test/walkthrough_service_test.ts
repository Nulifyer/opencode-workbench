import { assertEquals, assertRejects } from "jsr:@std/assert"
import type { WalkthroughDocument } from "@opencode-workbench/shared"
import { WalkthroughService } from "../src/application/walkthrough-service.ts"
import type { DiffCapture } from "../src/application/diff-service.ts"

const capture: DiffCapture = {
  unifiedDiff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  snapshot: { id: "diff", scope: "session", repository: "/repo", unifiedDiffHash: "sha256:exact", generatedAt: 1, complete: true, files: [{ path: "a.ts", additions: 1, deletions: 1, hunks: [{ header: "@@ -1 +1 @@", oldRange: { start: 1, end: 1 }, newRange: { start: 1, end: 1 } }] }] },
}

Deno.test("walkthrough generation validates exact anchors and caches by exact identity", async () => {
  let calls = 0
  const service = new WalkthroughService()
  const invoke = async () => { calls++; return JSON.stringify({ coverage: "complete", stops: [{ title: "Change", explanation: "Updated behavior", importance: "key-change", anchors: [{ file: "a.ts", side: "modified", startLine: 1, endLine: 1, hunkHeader: "@@ -1 +1 @@" }] }] }) }
  const first = await service.generate(capture, "provider/model", invoke)
  const second = await service.generate(capture, "provider/model", invoke)
  assertEquals(first.id, second.id)
  assertEquals(calls, 1)
})

Deno.test("walkthrough rejects invented anchors and oversized input explicitly", async () => {
  const service = new WalkthroughService([], undefined, 10)
  await assertRejects(() => service.generate(capture, "model", async () => "{}"), Error, "exceeds")
  const invalid = new WalkthroughService()
  await assertRejects(() => invalid.generate(capture, "model", async () => JSON.stringify({ coverage: "complete", stops: [{ title: "Bad", explanation: "Bad", importance: "normal", anchors: [{ file: "invented.ts", side: "modified", startLine: 1, endLine: 1 }] }] })), Error, "unknown file")
})

Deno.test("walkthrough insertion retains only the newest protocol-safe 100 documents", async () => {
  const initial: WalkthroughDocument[] = Array.from({ length: 100 }, (_, index) => ({
    id: `walkthrough-${index}`,
    diffHash: `sha256:${index}`,
    model: `provider/model-${index}`,
    promptVersion: "1",
    language: "en",
    generatedAt: index,
    coverage: "complete",
    stops: [],
  }))
  let persisted: WalkthroughDocument[] = []
  const service = new WalkthroughService(initial, (documents) => { persisted = documents })
  const generated = await service.generate(capture, "provider/new-model", async () => JSON.stringify({
    coverage: "complete",
    stops: [{ title: "Change", explanation: "Updated behavior", importance: "key-change", anchors: [{ file: "a.ts", side: "modified", startLine: 1, endLine: 1, hunkHeader: "@@ -1 +1 @@" }] }],
  }))

  assertEquals(service.list().length, 100)
  assertEquals(service.list().some((document) => document.id === initial[0]?.id), false)
  assertEquals(service.list().at(-1)?.id, generated.id)
  assertEquals(persisted.length, 100)
})
