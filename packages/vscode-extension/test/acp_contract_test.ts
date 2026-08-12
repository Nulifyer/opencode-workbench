import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  type AcpContractFixture,
  contractCompatibilitySignature,
  recordAcpContract,
} from "../../../scripts/record-opencode-acp-contract.ts"

const fixtureURL = new URL("./fixtures/acp/opencode-1.18.15.json", import.meta.url)

async function fixture(): Promise<AcpContractFixture> {
  return JSON.parse(await Deno.readTextFile(fixtureURL)) as AcpContractFixture
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sorted(values: string[]): string[] {
  return values.slice().sort()
}

Deno.test("pinned ACP fixture records the provider-free OpenCode contract", async () => {
  const contract = await fixture()
  assert(contract.schemaVersion === 1, "Unexpected ACP fixture schema")
  assert(contract.opencode.version === "1.18.15", "ACP fixture must remain pinned to OpenCode 1.18.15")
  assert(contract.opencode.acpSdkVersion === "0.21.0", "ACP SDK version drifted")
  assert(contract.opencode.protocolVersion === 1, "ACP protocol version drifted")
  assert(
    contract.providerRequestMode === "disabled" && !contract.modelPromptProbe.enabled,
    "Default fixture sent a provider/model request",
  )

  const expectedRequests = [
    "authenticate",
    "initialize",
    "session/close",
    "session/fork",
    "session/list",
    "session/load",
    "session/new",
    "session/resume",
    "session/set_config_option",
    "session/set_mode",
    "session/set_model",
    "workbench/unknown",
  ]
  assert(
    JSON.stringify(contract.protocol.agentRequestMethods) === JSON.stringify(expectedRequests),
    "ACP request method inventory drifted",
  )
  assert(
    JSON.stringify(contract.protocol.agentNotificationMethods) === JSON.stringify(["session/cancel"]),
    "ACP notification inventory drifted",
  )
  assert(
    JSON.stringify(contract.protocol.clientNotificationMethods) === JSON.stringify(["session/update"]),
    "ACP client notification inventory drifted",
  )
  assert(
    contract.protocol.clientRequestMethods.length === 0,
    "Provider-free recording unexpectedly triggered a client request",
  )
  assert(
    !contract.protocol.agentRequestMethods.includes("session/prompt"),
    "Provider-free recording contains session/prompt",
  )
  assert(
    contract.protocol.unknownMethodErrorCode === -32601 && contract.protocol.invalidParamsErrorCode === -32602,
    "JSON-RPC error contract drifted",
  )
  assert(contract.protocol.malformedInputSurvived, "ACP process did not recover from malformed NDJSON")
  assert(contract.protocol.simultaneousProcesses, "ACP simultaneous-process probe failed")
  assert(contract.protocol.terminatedProcessObserved, "ACP termination probe failed")
})

Deno.test("ACP fixture proves sessions, plugin commands, and restart persistence", async () => {
  const contract = await fixture()
  assert(contract.session.persistedAcrossRestart, "ACP session did not persist across restart")
  assert(contract.session.forkReturnedDistinctID, "ACP fork reused the source session ID")
  assert(contract.session.listFilteredByWorkingDirectory, "ACP session/list ignored cwd filtering")
  assert(
    JSON.stringify(contract.session.configOptionIDs) === JSON.stringify(["mode", "model"]),
    "ACP config options drifted",
  )
  assert(JSON.stringify(contract.session.modeIDs) === JSON.stringify(["build", "plan"]), "ACP mode inventory drifted")
  assert(contract.session.modelSelection, "ACP model selection was not proven")
  assert(!contract.session.variantSelection, "The fixture should not claim an unobserved variant selector")
  for (const command of ["goal", "goal-unlimited"]) {
    assert(contract.session.availableCommands.includes(command), `Companion plugin command ${command} is missing`)
  }
  assert(
    !contract.session.undoAdvertised && !contract.session.redoAdvertised,
    "ACP unexpectedly advertised /undo or /redo",
  )
  assert(
    contract.processes.filter((process) => process.cleanExit).length === 3,
    "Expected three clean ACP process exits",
  )
  assert(
    contract.processes.some((process) => process.name === "terminated" && !process.cleanExit),
    "Terminated process was not recorded",
  )
})

Deno.test("ACP capability classifications are complete, honest, and sanitized", async () => {
  const contract = await fixture()
  const required = [
    "initialize and capability negotiation",
    "session create/list/load/resume/fork/close",
    "working-directory isolation",
    "agent/mode selection",
    "model selection",
    "variant selection",
    "slash-command discovery",
    "companion-plugin commands",
    "tool and companion-tool schema discovery",
    "MCP registration",
    "MCP tool discovery",
    "permission request and response choices",
    "questions and durable user input",
    "prompt/message/reasoning/tool/diff/usage lifecycle",
    "cancellation",
    "queue/steer/follow-up/replace",
    "/undo and /redo",
    "malformed input recovery",
    "process crash recovery",
  ]
  assert(
    JSON.stringify(sorted(contract.classifications.map((entry) => entry.capability))) ===
      JSON.stringify(sorted(required)),
    "ACP capability matrix is incomplete",
  )
  assert(
    contract.classifications.every((entry) =>
      ["supported", "mapped", "missing", "unknown"].includes(entry.classification)
    ),
    "ACP fixture contains an invalid classification",
  )
  const serialized = JSON.stringify(contract)
  for (
    const forbidden of [/\/home\//, /\/tmp\//, /ses_[0-9A-Za-z]+/, /(?:token|secret|password|credential)[=:][^,}\s]+/i]
  ) {
    assert(!forbidden.test(serialized), `ACP fixture contains unsanitized data matching ${forbidden}`)
  }
})

Deno.test("installed OpenCode ACP matches the pinned fixture when explicitly enabled", async () => {
  const executable = Deno.env.get("OPENCODE_ACP_EXECUTABLE")
  if (!executable) return
  const expected = await fixture()
  const repository = fileURLToPath(new URL("../../../", import.meta.url))
  const actual = await recordAcpContract({
    executable,
    expectedVersion: Deno.env.get("OPENCODE_ACP_VERSION") ?? expected.opencode.version,
    pluginPath: path.join(repository, "dist", "opencode-plugin.js"),
  })
  const expectedSignature = JSON.stringify(contractCompatibilitySignature(expected))
  const actualSignature = JSON.stringify(contractCompatibilitySignature(actual))
  assert(
    actualSignature === expectedSignature,
    `OpenCode ACP contract drifted. Re-record only after reviewing the diff.\nExpected: ${expectedSignature}\nActual: ${actualSignature}`,
  )
})
