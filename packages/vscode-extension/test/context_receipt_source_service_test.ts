import { assertEquals, assertRejects } from "jsr:@std/assert"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { ContextReceipt, ContextReceiptItem } from "@opencode-workbench/shared"
import {
  type ContextReceiptSourceFileSystem,
  inspectContextReceiptSource,
} from "../src/application/context-receipt-source-service.ts"

function receipt(
  items: ContextReceiptItem[],
  sessionID = "session-1",
): ContextReceipt {
  return {
    id: "receipt-1",
    sessionID,
    promptID: "prompt-1",
    admittedAt: 1,
    items,
    truncation: "none",
  }
}

Deno.test("context source inspection enforces receipt and item ownership", async () => {
  const owned = receipt([{
    id: "source-1",
    kind: "url",
    label: "Docs",
    uri: "https://example.test/docs",
  }])
  await assertRejects(
    () =>
      inspectContextReceiptSource({
        sessionID: "session-2",
        directory: "/work",
        receipt: owned,
        itemID: "source-1",
      }),
    Error,
    "does not belong",
  )
  await assertRejects(
    () =>
      inspectContextReceiptSource({
        sessionID: "session-1",
        directory: "/work",
        receipt: owned,
        itemID: "source-2",
      }),
    Error,
    "was not found",
  )
  await assertRejects(
    () =>
      inspectContextReceiptSource({
        sessionID: "session-1",
        directory: "/work",
        receipt: receipt([owned.items[0]!, owned.items[0]!]),
        itemID: "source-1",
      }),
    Error,
    "ambiguous",
  )
})

Deno.test("context source inspection returns credential-free HTTP metadata without fetching", async () => {
  let fileSystemUsed = false
  const fileSystem: ContextReceiptSourceFileSystem = {
    realpath: () => {
      fileSystemUsed = true
      throw new Error("must not inspect the filesystem")
    },
    stat: () => {
      fileSystemUsed = true
      throw new Error("must not inspect the filesystem")
    },
  }
  const inspected = await inspectContextReceiptSource({
    sessionID: "session-1",
    directory: "/work",
    receipt: receipt([{
      id: "source-1",
      kind: "url",
      label: "Docs",
      uri: "https://example.test/docs",
      range: { startLine: 2, startColumn: 3, endLine: 4, endColumn: 5 },
    }]),
    itemID: "source-1",
  }, fileSystem)
  assertEquals(inspected, {
    receiptID: "receipt-1",
    itemID: "source-1",
    availability: "available",
    uri: "https://example.test/docs",
    range: { startLine: 2, startColumn: 3, endLine: 4, endColumn: 5 },
    storedRevision: undefined,
    stale: undefined,
  })
  assertEquals(fileSystemUsed, false)

  for (
    const uri of [
      "https://user:password@example.test/docs",
      "https://example.test/docs?access_token=secret",
      "javascript:alert(1)",
      "vscode-remote://ssh-remote+host/work/file.ts",
      "file:///work/%00secret.txt",
    ]
  ) {
    await assertRejects(
      () =>
        inspectContextReceiptSource({
          sessionID: "session-1",
          directory: "/work",
          receipt: receipt([{
            id: "source-1",
            kind: "url",
            label: "Unsafe",
            uri,
          }]),
          itemID: "source-1",
        }, fileSystem),
      Error,
      "URI is unsafe",
    )
  }
})

Deno.test("context source inspection compares file revisions and never reads content", async () => {
  const work = path.resolve("context-source-test-work")
  const sourcePath = path.join(work, "src", "main.ts")
  const operations: string[] = []
  const fileSystem: ContextReceiptSourceFileSystem & { readFile(): never } = {
    async realpath(candidate) {
      operations.push(`realpath:${candidate}`)
      return candidate
    },
    async stat(candidate) {
      operations.push(`stat:${candidate}`)
      return { mtimeMs: 1234.9, size: 42, isFile: () => true }
    },
    readFile() {
      throw new Error("source content must never be read")
    },
  }
  const input = {
    sessionID: "session-1",
    directory: work,
    receipt: receipt([{
      id: "source-1",
      kind: "file" as const,
      label: "main.ts",
      uri: pathToFileURL(sourcePath).toString(),
      revision: "1234:42",
      range: { startLine: 8, startColumn: 1, endLine: 8, endColumn: 10 },
    }]),
    itemID: "source-1",
  }
  assertEquals(await inspectContextReceiptSource(input, fileSystem), {
    receiptID: "receipt-1",
    itemID: "source-1",
    availability: "available",
    uri: pathToFileURL(sourcePath).toString(),
    range: { startLine: 8, startColumn: 1, endLine: 8, endColumn: 10 },
    storedRevision: "1234:42",
    currentRevision: "1234:42",
    stale: false,
  })
  input.receipt.items[0]!.revision = "1234:41"
  assertEquals(
    (await inspectContextReceiptSource(input, fileSystem)).stale,
    true,
  )
  input.receipt.items[0]!.revision = "editor-version-7"
  assertEquals(
    (await inspectContextReceiptSource(input, fileSystem)).stale,
    undefined,
  )
  assertEquals(operations, [
    `realpath:${work}`,
    `realpath:${sourcePath}`,
    `stat:${sourcePath}`,
    `realpath:${work}`,
    `realpath:${sourcePath}`,
    `stat:${sourcePath}`,
    `realpath:${work}`,
    `realpath:${sourcePath}`,
    `stat:${sourcePath}`,
  ])
})

Deno.test("context source inspection reports missing contained files as unavailable", async () => {
  const work = path.resolve("context-source-test-work")
  const sourcePath = path.join(work, "removed.ts")
  const sourceUri = pathToFileURL(sourcePath).toString()
  const fileSystem: ContextReceiptSourceFileSystem = {
    realpath: async (candidate) => {
      if (candidate === work) return candidate
      throw new Error("ENOENT")
    },
    stat: () => {
      throw new Error("must not stat an unresolved file")
    },
  }
  assertEquals(
    await inspectContextReceiptSource({
      sessionID: "session-1",
      directory: work,
      receipt: receipt([{
        id: "source-1",
        kind: "file",
        label: "removed.ts",
        uri: sourceUri,
        revision: "1234:42",
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      }]),
      itemID: "source-1",
    }, fileSystem),
    {
      receiptID: "receipt-1",
      itemID: "source-1",
      availability: "unavailable",
      uri: sourceUri,
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      storedRevision: "1234:42",
      stale: undefined,
    },
  )
})

Deno.test("context source inspection rejects lexical and symlink file escapes", async () => {
  const parent = await Deno.makeTempDir()
  try {
    const work = path.join(parent, "work")
    const outside = path.join(parent, "outside")
    await Deno.mkdir(work)
    await Deno.mkdir(outside)
    const outsideFile = path.join(outside, "secret.txt")
    await Deno.writeTextFile(outsideFile, "do not inspect")
    await Deno.symlink(outsideFile, path.join(work, "escape.txt"))
    const workRealPath = await Deno.realPath(work)

    for (const sourcePath of [outsideFile, path.join(work, "escape.txt")]) {
      await assertRejects(
        () =>
          inspectContextReceiptSource({
            sessionID: "session-1",
            directory: workRealPath,
            receipt: receipt([{
              id: "source-1",
              kind: "file",
              label: "Escape",
              uri: pathToFileURL(sourcePath).toString(),
            }]),
            itemID: "source-1",
          }),
        Error,
        "escapes the session directory",
      )
    }
  } finally {
    await Deno.remove(parent, { recursive: true })
  }
})

Deno.test("context source inspection returns the canonical file URI it validated", async () => {
  const parent = await Deno.makeTempDir()
  try {
    const work = path.join(parent, "work")
    await Deno.mkdir(work)
    const target = path.join(work, "target.ts")
    const alias = path.join(work, "alias.ts")
    await Deno.writeTextFile(target, "export const safe = true\n")
    await Deno.symlink(target, alias)
    const inspected = await inspectContextReceiptSource({
      sessionID: "session-1",
      directory: work,
      receipt: receipt([{
        id: "source-1",
        kind: "file",
        label: "Alias",
        uri: pathToFileURL(alias).toString(),
      }]),
      itemID: "source-1",
    })
    assertEquals(inspected.availability, "available")
    assertEquals(inspected.uri, pathToFileURL(await Deno.realPath(target)).toString())
  } finally {
    await Deno.remove(parent, { recursive: true })
  }
})

Deno.test("context source inspection preserves range metadata for non-navigable receipt items", async () => {
  const inspected = await inspectContextReceiptSource({
    sessionID: "session-1",
    directory: "/work",
    receipt: receipt([{
      id: "source-1",
      kind: "unsaved-buffer",
      label: "Untitled buffer",
      range: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 2 },
      revision: "7",
    }]),
    itemID: "source-1",
  })
  assertEquals(inspected.availability, "unavailable")
  assertEquals(inspected.range, {
    startLine: 1,
    startColumn: 1,
    endLine: 3,
    endColumn: 2,
  })
  assertEquals(inspected.storedRevision, "7")
  assertEquals(inspected.stale, undefined)
})
