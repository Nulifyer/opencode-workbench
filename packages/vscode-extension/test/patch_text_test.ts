import { assertEquals, assertThrows } from "jsr:@std/assert"
import { patchTextPair } from "../src/application/patch-text.ts"

Deno.test("completed patches reconstruct the original side of a native diff", () => {
  assertEquals(
    patchTextPair(
      'FIRST=1\nUNIFI_LIST_NAME="Known Bad IPs"\nLAST=3\n',
      '@@ -1,3 +1,3 @@\n FIRST=1\n-UNIFI_LIST_NAME=Known Bad IPs\n+UNIFI_LIST_NAME="Known Bad IPs"\n LAST=3',
      true,
    ),
    {
      original: "FIRST=1\nUNIFI_LIST_NAME=Known Bad IPs\nLAST=3\n",
      modified: 'FIRST=1\nUNIFI_LIST_NAME="Known Bad IPs"\nLAST=3\n',
    },
  )
})

Deno.test("proposed and failed patches reconstruct the modified side", () => {
  assertEquals(patchTextPair("alpha\nbeta\n", "@@\n-alpha\n+updated", false), {
    original: "alpha\nbeta\n",
    modified: "updated\nbeta\n",
  })
})

Deno.test("patch reconstruction fails instead of presenting unrelated file contents", () => {
  assertThrows(() => patchTextPair("different\n", "@@\n-old\n+new", false), Error, "no longer matches")
})

Deno.test("patch reconstruction preserves changed content that resembles file headers", () => {
  assertEquals(patchTextPair("old\n", "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+++ heading", false), {
    original: "old\n",
    modified: "++ heading\n",
  })
  assertEquals(patchTextPair("old\n", "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+--- heading", false), {
    original: "old\n",
    modified: "--- heading\n",
  })
})

Deno.test("patch reconstruction applies final-newline markers to each side", () => {
  assertEquals(patchTextPair("new\n", "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new", true), {
    original: "old",
    modified: "new\n",
  })
  assertEquals(patchTextPair("old\n", "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file", false), {
    original: "old\n",
    modified: "new",
  })
})

Deno.test("patch reconstruction preserves truly empty files", () => {
  assertEquals(patchTextPair("old\n", "@@ -1 +0,0 @@\n-old", false), {
    original: "old\n",
    modified: "",
  })
  assertEquals(patchTextPair("", "*** Begin Patch\n*** Add File: a.txt\n+new\n*** End Patch", false), {
    original: "",
    modified: "new",
  })
})
