import { assertEquals, assertThrows } from "jsr:@std/assert"
import {
  assertBrowserScreenshotFileBeforeRead,
  BROWSER_SCREENSHOT_BYTE_LIMIT,
  captureBrowserContext,
  requestedBrowserEditorSelection,
} from "../src/application/browser-context-service.ts"

Deno.test("browser capture includes only explicitly supplied bounded context", () => {
  const result = captureBrowserContext({
    task: "Diagnose this page failure",
    editorSelection: { uri: "file:///work/debug.log", startLine: 3, startColumn: 1, endLine: 5, endColumn: 8, revision: "7", text: "TypeError: failed" },
    clipboardText: { kind: "element", text: "button#submit disabled=true" },
    diagnostics: "2 errors, 1 warning across 2 files",
    debugState: '{"session":{"name":"Debug tests"}}',
    approvedUrl: "https://example.com/reproduction",
    screenshot: { name: "page.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) },
  })
  assertEquals(result.prompt, "Diagnose this page failure")
  assertEquals(result.files.map((file) => file.filename), ["browser-context.md", "page.png"])
  assertEquals(result.files.every((file) => file.url.startsWith("data:")), true)
  assertEquals(result.receiptItems.map((item) => item.kind), ["selection", "debug", "diagnostics", "debug", "url", "attachment"])
  assertEquals(result.receiptItems.every((item) => item.contentHash?.startsWith("sha256:")), true)
})

Deno.test("browser capture rejects empty and oversized implicit data", () => {
  assertThrows(() => captureBrowserContext({ task: "Diagnose", clipboardText: { kind: "console", text: "" } }))
  assertThrows(() => captureBrowserContext({ task: "Diagnose", screenshot: { name: "page.exe", mime: "image/png", bytes: new Uint8Array([1]) } }))
  assertThrows(() => captureBrowserContext({ task: "Diagnose", approvedUrl: "https://user:secret@example.com/" }), Error, "without embedded credentials")
  assertThrows(() => captureBrowserContext({ task: "Diagnose" }))
})

Deno.test("browser capture sends an approved URL but strips query secrets from durable receipt metadata", () => {
  const result = captureBrowserContext({ task: "Trace callback", approvedUrl: "https://example.test/callback?access_token=do-not-store#credential" })
  const source = Buffer.from(result.files[0]!.url.split(",", 2)[1]!, "base64").toString("utf8")
  assertEquals(source.includes("access_token=do-not-store"), true)
  assertEquals(result.receiptItems[0]?.uri, "https://example.test/callback")
  assertEquals(JSON.stringify(result.receiptItems).includes("do-not-store"), false)
})

Deno.test("requested browser selection fails explicitly when the editor snapshot is unavailable", () => {
  assertEquals(requestedBrowserEditorSelection(["diagnostics"], undefined), undefined)
  assertThrows(
    () => requestedBrowserEditorSelection(["selection", "diagnostics"], undefined),
    Error,
    "requested editor selection is unavailable",
  )
  const selection = { uri: "file:///work/main.ts", startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, revision: "3", text: "x" }
  assertEquals(requestedBrowserEditorSelection(["selection"], selection), selection)
})

Deno.test("browser screenshot stat is bounded and sanitized before bytes are read", () => {
  assertBrowserScreenshotFileBeforeRead({ name: "capture.png", mime: "image/png", size: BROWSER_SCREENSHOT_BYTE_LIMIT, isFile: true })
  assertThrows(
    () => assertBrowserScreenshotFileBeforeRead({ name: "capture.png", mime: "image/png", size: BROWSER_SCREENSHOT_BYTE_LIMIT + 1, isFile: true }),
    Error,
    "no larger than 10 MiB",
  )
  assertThrows(() => assertBrowserScreenshotFileBeforeRead({ name: "capture.png", mime: "image/png", size: 1, isFile: false }), Error, "regular")
  assertThrows(() => assertBrowserScreenshotFileBeforeRead({ name: "../capture.png", mime: "image/png", size: 1, isFile: true }), Error, "regular")
  assertThrows(() => assertBrowserScreenshotFileBeforeRead({ name: "capture.png", mime: "image/jpeg", size: 1, isFile: true }), Error, "regular")
})
