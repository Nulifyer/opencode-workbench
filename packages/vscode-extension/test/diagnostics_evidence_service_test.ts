import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert"
import {
  captureDiagnostics,
  diagnosticsDelta,
  diagnosticsSummary,
} from "../src/application/diagnostics-evidence-service.ts"

Deno.test("diagnostic evidence includes only files in the selected repository", () => {
  const snapshot = captureDiagnostics("/work/repo", [
    { file: "/work/repo/src/a.ts", errors: 1, warnings: 2 },
    { file: "/work/repo-other/src/b.ts", errors: 50, warnings: 50 },
    { file: "/work/repo/src/clean.ts", errors: 0, warnings: 0 },
    { file: "relative.ts", errors: 1, warnings: 0 },
  ])
  assertEquals(snapshot, { errors: 1, warnings: 2, files: 1 })
  assertEquals(diagnosticsSummary(snapshot), "1 errors, 2 warnings across 1 files")
  assertThrows(() => captureDiagnostics("relative", []), Error, "absolute")
})

Deno.test("diagnostic evidence reports deterministic before and after deltas", () => {
  const introduced = diagnosticsDelta(
    { errors: 0, warnings: 1, files: 1 },
    { errors: 2, warnings: 0, files: 2 },
  )
  assertEquals(introduced.status, "failed")
  assertMatch(introduced.summary, /delta: \+2 errors, -1 warnings, \+1 files/)
  assertEquals(
    diagnosticsDelta(
      { errors: 1, warnings: 1, files: 1 },
      { errors: 0, warnings: 0, files: 0 },
    ).status,
    "passed",
  )
  assertEquals(
    diagnosticsDelta(
      { errors: 2, warnings: 0, files: 1 },
      { errors: 1, warnings: 0, files: 1 },
    ).status,
    "warning",
  )
})
