import { createHash } from "node:crypto"
import { sanitizeDurableMetadataUri, type ContextReceiptItem } from "@opencode-workbench/shared"
import type { PromptFilePart } from "../opencode-client.js"

export interface BrowserContextInput {
  task: string
  editorSelection?: { uri: string; startLine: number; startColumn: number; endLine: number; endColumn: number; revision?: string; text: string }
  clipboardText?: { kind: "console" | "element" | "terminal-task"; text: string }
  diagnostics?: string
  debugState?: string
  approvedUrl?: string
  screenshot?: { name: string; mime: "image/png" | "image/jpeg" | "image/webp"; bytes: Uint8Array }
}

export interface BrowserContextCapture { prompt: string; files: PromptFilePart[]; receiptItems: ContextReceiptItem[] }

function bounded(value: string, limit: number, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > limit) throw new Error(`${label} must contain 1-${limit} characters`)
  return trimmed
}

function contentHash(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function textItem(id: string, kind: ContextReceiptItem["kind"], label: string, text: string, values: Partial<ContextReceiptItem> = {}): ContextReceiptItem {
  return { id, kind, label, bytes: Buffer.byteLength(text), contentHash: contentHash(text), ...values }
}

function approvedUrl(value: string): string {
  const boundedValue = bounded(value, 8_192, "Approved URL")
  let parsed: URL
  try { parsed = new URL(boundedValue) } catch { throw new Error("Approved URL must be a valid HTTP or HTTPS URL") }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Approved URL must be an HTTP or HTTPS URL without embedded credentials")
  return parsed.toString()
}

export function captureBrowserContext(input: BrowserContextInput): BrowserContextCapture {
  const sections: string[] = ["# Explicit browser/debug context"]
  const receiptItems: ContextReceiptItem[] = []
  if (input.editorSelection) {
    const selection = bounded(input.editorSelection.text, 100_000, "Editor selection")
    const uri = bounded(input.editorSelection.uri, 8_192, "Selection URI")
    const range = { startLine: input.editorSelection.startLine, startColumn: input.editorSelection.startColumn, endLine: input.editorSelection.endLine, endColumn: input.editorSelection.endColumn }
    if (![range.startLine, range.startColumn, range.endLine, range.endColumn].every((value) => Number.isSafeInteger(value) && value >= 1) || range.endLine < range.startLine || (range.endLine === range.startLine && range.endColumn < range.startColumn)) throw new Error("Editor selection has an invalid range")
    sections.push(`## Editor selection\nSource: ${uri}:${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}\n\n${selection}`)
    receiptItems.push(textItem("browser:selection", "selection", "Explicit editor selection", selection, { uri, range, revision: input.editorSelection.revision }))
  }
  if (input.clipboardText) {
    const clipboard = bounded(input.clipboardText.text, 100_000, "Clipboard browser context")
    const label = input.clipboardText.kind === "console" ? "console output" : input.clipboardText.kind === "element" ? "inspected element metadata" : "terminal or task excerpt"
    sections.push(`## User-designated ${label}\n\n${clipboard}`)
    receiptItems.push(textItem(`browser:${input.clipboardText.kind}`, input.clipboardText.kind === "terminal-task" ? "terminal" : "debug", `User-designated ${label}`, clipboard))
  }
  if (input.diagnostics !== undefined) {
    const diagnostics = bounded(input.diagnostics, 20_000, "Diagnostics context")
    sections.push(`## Workspace diagnostics summary\n\n${diagnostics}`)
    receiptItems.push(textItem("browser:diagnostics", "diagnostics", "Workspace diagnostics summary", diagnostics))
  }
  if (input.debugState !== undefined) {
    const debug = bounded(input.debugState, 50_000, "Debug-state context")
    sections.push(`## VS Code debug state\n\n${debug}`)
    receiptItems.push(textItem("browser:debug", "debug", "VS Code debug state", debug))
  }
  if (input.approvedUrl !== undefined) {
    const url = approvedUrl(input.approvedUrl)
    const receiptUri = sanitizeDurableMetadataUri(url)
    if (!receiptUri) throw new Error("Approved URL cannot be represented safely in durable metadata")
    sections.push(`## User-approved URL\n\n${url}`)
    receiptItems.push({ id: "browser:url", kind: "url", label: "User-approved URL", uri: receiptUri, bytes: Buffer.byteLength(url), contentHash: contentHash(url) })
  }
  const files: PromptFilePart[] = []
  if (sections.length > 1) files.push({ type: "file", filename: "browser-context.md", mime: "text/markdown", url: `data:text/markdown;base64,${Buffer.from(sections.join("\n\n")).toString("base64")}` })
  if (input.screenshot) {
    if (!/^[^/\\]{1,200}\.(?:png|jpe?g|webp)$/i.test(input.screenshot.name) || input.screenshot.bytes.byteLength < 1 || input.screenshot.bytes.byteLength > 10 * 1024 * 1024) throw new Error("Screenshot must be a PNG, JPEG, or WebP file no larger than 10 MiB")
    files.push({ type: "file", filename: input.screenshot.name, mime: input.screenshot.mime, url: `data:${input.screenshot.mime};base64,${Buffer.from(input.screenshot.bytes).toString("base64")}` })
    receiptItems.push({ id: "browser:screenshot", kind: "attachment", label: input.screenshot.name, bytes: input.screenshot.bytes.byteLength, contentHash: contentHash(input.screenshot.bytes) })
  }
  if (!files.length) throw new Error("Select at least one browser or debug context source")
  return { prompt: bounded(input.task, 20_000, "Browser-context task"), files, receiptItems }
}
