import {
  recordVerifierContract,
  type VerifierContractFixture,
} from "../../../scripts/record-opencode-verifier-contract.ts"

const fixtureURL = new URL(
  "./fixtures/verifier/opencode-1.18.15.json",
  import.meta.url,
)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function fixture(): Promise<VerifierContractFixture> {
  return JSON.parse(
    await Deno.readTextFile(fixtureURL),
  ) as VerifierContractFixture
}

Deno.test("pinned verifier fixture proves an isolated provider-free execution path", async () => {
  const contract = await fixture()
  assert(
    contract.schemaVersion === 1 && contract.opencodeVersion === "1.18.15",
    "Unexpected verifier fixture version",
  )
  assert(
    contract.providerRequestMode === "disabled",
    "Default verifier probe contacted a provider",
  )
  assert(
    contract.verifier.executionPath === "separate-opencode-session",
    "Verifier reused the implementation session",
  )
  assert(
    contract.verifier.agentName === "workbench-verifier" &&
      contract.verifier.agentMode === "primary",
    "Verifier agent drifted",
  )
  assert(
    contract.verifier.wildcardPermissionDenied &&
      contract.verifier.requestToolsDisabled,
    "Verifier is not tool isolated",
  )
  assert(
    !contract.verifier.transcriptVisible,
    "Pinned fixture must record the OpenCode 1.18.15 provider-free transcript limitation",
  )
  assert(
    contract.verifier.noAssistantMessageWithoutProvider,
    "Provider-free seam unexpectedly created an assistant response",
  )
  assert(
    contract.verifier.selectedModelPersisted,
    "OpenCode did not persist verifier model selection",
  )
  assert(
    contract.verifier.structuredOutputFormatAccepted &&
      contract.verifier.jsonSchemaAccepted,
    "Structured-output schema was not accepted",
  )
  assert(
    !contract.verifier.structuredOutputLegacyTranscriptCompatible,
    "Pinned fixture no longer records the OpenCode 1.18.15 structured-output transcript incompatibility",
  )
  assert(
    contract.verifier.retryCountAcceptedOnPrompt,
    "OpenCode rejected its declared structured-output retry field",
  )
  assert(
    !contract.verifier.retryCountTranscriptCompatible,
    "Pinned fixture no longer records the OpenCode 1.18.15 retry/transcript incompatibility",
  )
  assert(
    contract.verifier.idleCancellationAccepted,
    "OpenCode did not accept verifier cancellation",
  )
  assert(
    contract.verifier.providerSdkAdded === false,
    "Verifier added a provider SDK",
  )
})

Deno.test("verifier fixture records every required concern without overstating provider-free evidence", async () => {
  const contract = await fixture()
  const expected = [
    "filesystem and tool isolation",
    "model selection",
    "provider-free test seam",
    "retry behavior",
    "schema enforcement",
    "timeout and cancellation",
    "token accounting",
    "transcript visibility",
  ]
  assert(
    JSON.stringify(
      contract.classifications.map((entry) => entry.concern).sort(),
    ) === JSON.stringify(expected),
    "Verifier concern inventory is incomplete",
  )
  assert(
    contract.classifications.every((entry) =>
      ["proven-provider-free", "requires-opt-in-model-probe", "workbench-owned"]
        .includes(entry.status)
    ),
    "Verifier fixture contains an invalid status",
  )
  assert(
    contract.classifications.find((entry) => entry.concern === "schema enforcement")?.status ===
      "requires-opt-in-model-probe",
    "Fixture overstated schema enforcement",
  )
  assert(
    contract.classifications.find((entry) => entry.concern === "retry behavior")
      ?.status === "workbench-owned",
    "Fixture delegated retry safety to an unproven runtime behavior",
  )
  assert(
    contract.classifications.find((entry) => entry.concern === "transcript visibility")
      ?.status === "requires-opt-in-model-probe",
    "Fixture overstated provider-free transcript visibility",
  )
})

Deno.test("installed OpenCode matches the pinned verifier contract when explicitly enabled", async () => {
  const executable = Deno.env.get("OPENCODE_VERIFIER_EXECUTABLE")
  if (!executable) return
  const expected = await fixture()
  const actual = await recordVerifierContract({
    executable,
    expectedVersion: Deno.env.get("OPENCODE_VERIFIER_VERSION") ??
      expected.opencodeVersion,
  })
  const normalize = (value: VerifierContractFixture) => ({
    providerRequestMode: value.providerRequestMode,
    opencodeVersion: value.opencodeVersion,
    verifier: value.verifier,
    classifications: value.classifications,
  })
  assert(
    JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected)),
    "OpenCode verifier contract drifted",
  )
})
