import { assertEquals, assertMatch } from "jsr:@std/assert"
import { dataUrlPayload, promptFileReceiptItems } from "../src/application/context-receipt-builders.ts"

Deno.test("context receipt metadata measures decoded bytes without retaining payloads", () => {
  const text = "hello ✓"
  const url = `data:text/plain;base64,${Buffer.from(text).toString("base64")}`
  assertEquals(dataUrlPayload(url)?.toString("utf8"), text)
  const [item] = promptFileReceiptItems([{ type: "file", filename: "context.txt", mime: "text/plain", url }], "context")
  assertEquals(item?.bytes, Buffer.byteLength(text))
  assertEquals(item?.uri, undefined)
  assertMatch(item?.contentHash ?? "", /^sha256:[a-f0-9]{64}$/)
})

Deno.test("context receipt metadata never persists malformed data URLs", () => {
  assertEquals(dataUrlPayload("data:text/plain,%E0%A4%A"), undefined)
  const [item] = promptFileReceiptItems([{ type: "file", filename: "bad.txt", mime: "text/plain", url: "data:text/plain,%E0%A4%A" }], "context")
  assertEquals(item?.bytes, undefined)
  assertEquals(item?.contentHash, undefined)
})
