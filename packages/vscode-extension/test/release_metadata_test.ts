import { assertEquals, assertThrows } from "jsr:@std/assert"
import { validateReleaseOpenCodeCompatibility } from "../../../scripts/release-metadata.ts"

const rootManifest = JSON.parse(
  await Deno.readTextFile(new URL("../../../package.json", import.meta.url)),
) as {
  compatibility?: { minimumOpenCode?: string; maximumOpenCodeExclusive?: string }
  dependencies?: Record<string, string>
}

Deno.test("release metadata declares the supported OpenCode patch line", () => {
  assertEquals(
    validateReleaseOpenCodeCompatibility({
      minimumOpenCode: rootManifest.compatibility?.minimumOpenCode,
      maximumOpenCodeExclusive: rootManifest.compatibility?.maximumOpenCodeExclusive,
      buildOpenCodeVersion: rootManifest.dependencies?.["@opencode-ai/plugin"],
    }),
    { minimumOpenCode: "1.18.11", maximumOpenCodeExclusive: "1.19.0" },
  )
})

Deno.test("release metadata rejects overbroad or unbuildable OpenCode ranges", () => {
  assertThrows(
    () =>
      validateReleaseOpenCodeCompatibility({
        minimumOpenCode: "1.18.11",
        maximumOpenCodeExclusive: "1.19",
        buildOpenCodeVersion: "1.18.11",
      }),
    Error,
    "exact semantic version",
  )
  assertThrows(
    () =>
      validateReleaseOpenCodeCompatibility({
        minimumOpenCode: "1.18.11",
        maximumOpenCodeExclusive: "1.18.11",
        buildOpenCodeVersion: "1.18.11",
      }),
    Error,
    "minimum must be lower",
  )
  assertThrows(
    () =>
      validateReleaseOpenCodeCompatibility({
        minimumOpenCode: "1.18.11",
        maximumOpenCodeExclusive: "2.0.0",
        buildOpenCodeVersion: "1.18.11",
      }),
    Error,
    "configured major line",
  )
  assertThrows(
    () =>
      validateReleaseOpenCodeCompatibility({
        minimumOpenCode: "1.18.11",
        maximumOpenCodeExclusive: "1.19.0",
        buildOpenCodeVersion: "1.19.0",
      }),
    Error,
    "inside the declared OpenCode compatibility range",
  )
  assertThrows(
    () =>
      validateReleaseOpenCodeCompatibility({
        minimumOpenCode: "1.18.11",
        maximumOpenCodeExclusive: "1.19.0",
        buildOpenCodeVersion: "1.18.10",
      }),
    Error,
    "inside the declared OpenCode compatibility range",
  )
})
