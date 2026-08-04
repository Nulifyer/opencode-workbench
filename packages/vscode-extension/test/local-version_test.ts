import { localDevelopmentVersion } from "../../../scripts/local-version.ts"

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, received ${actual}`)
}

Deno.test("local builds use a timestamped prerelease of the next patch", () => {
  assertEquals(localDevelopmentVersion("0.3.0", new Date("2026-08-03T04:05:06Z")), "0.3.1-dev.20260803.t040506")
})

Deno.test("local build versions reject prerelease production manifests", () => {
  let rejected = false
  try {
    localDevelopmentVersion("0.3.1-beta.1")
  } catch {
    rejected = true
  }
  assertEquals(rejected, true)
})
