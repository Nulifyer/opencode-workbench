import { createHash } from "node:crypto"
import type { ContextReceiptItem } from "@opencode-workbench/shared"
import type { PromptFilePart } from "../opencode-client.js"

export function dataUrlPayload(url: string): Buffer | undefined {
  const match = /^data:[^,]*?(;base64)?,([\s\S]*)$/.exec(url)
  if (!match) return undefined
  try {
    return match[1] ? Buffer.from(match[2]!, "base64") : Buffer.from(decodeURIComponent(match[2]!), "utf8")
  } catch {
    return undefined
  }
}

export function receiptHash(payload: Uint8Array): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`
}

export function promptFileReceiptItems(files: PromptFilePart[], prefix: string): ContextReceiptItem[] {
  return files.map((file, index) => {
    const payload = dataUrlPayload(file.url)
    return {
      id: `${prefix}:${index}`,
      kind: "attachment",
      label: file.filename,
      uri: file.url.startsWith("file:") ? file.url : undefined,
      bytes: payload?.byteLength,
      contentHash: payload ? receiptHash(payload) : undefined,
    }
  })
}
