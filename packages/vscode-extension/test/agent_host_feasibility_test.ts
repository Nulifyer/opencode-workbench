import {
  type AgentHostFeasibilityFixture,
  probeAgentHost,
} from "../../../scripts/probe-vscode-agent-host.ts";

const fixtureURL = new URL(
  "./fixtures/ahp/vscode-1.131.0.json",
  import.meta.url,
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function fixture(): Promise<AgentHostFeasibilityFixture> {
  return JSON.parse(
    await Deno.readTextFile(fixtureURL),
  ) as AgentHostFeasibilityFixture;
}

function proposal(
  contract: AgentHostFeasibilityFixture,
  name: string,
): string[] {
  return contract.proposals.find((entry) => entry.proposal === name)
    ?.allowlistedExtensionIDs ?? [];
}

Deno.test("pinned VS Code fixture proves the native registration stop condition", async () => {
  const contract = await fixture();
  assert(contract.schemaVersion === 1, "Unexpected Agent Host fixture schema");
  assert(
    contract.vscode.channel === "stable" &&
      contract.vscode.version === "1.131.0",
    "Fixture must remain pinned to Stable 1.131.0",
  );
  assert(
    contract.cli.agentHostCommandAvailable,
    "Stable CLI did not expose the Agent Host server",
  );
  assert(
    contract.cli.customAdapterRegistrationOptionNames.length === 0,
    "CLI unexpectedly exposes custom adapter registration",
  );
  assert(
    contract.extension.id === "nulifyer.opencode-workbench",
    "Fixture used the wrong extension identity",
  );
  assert(
    contract.extension.enabledApiProposals.length === 0,
    "Workbench unexpectedly became allowlisted for proposed APIs",
  );
  assert(
    proposal(contract, "chatSessionsProvider").includes("openai.chatgpt"),
    "Expected an allowlisted first-party native session provider",
  );
  assert(
    !proposal(contract, "chatSessionsProvider").includes(contract.extension.id),
    "Workbench must not be recorded as allowlisted",
  );
  assert(
    !contract.conclusions.publicMarketplaceRegistrationProven,
    "Fixture must not claim a public Marketplace registration path",
  );
  assert(
    contract.conclusions.nativePickerRegistration ===
      "blocked-proposed-api-allowlist",
    "Native strategy stop condition drifted",
  );
  assert(
    contract.conclusions.productionDependencyAllowed === false,
    "Discovery must not authorize a production dependency",
  );
});

Deno.test("Agent Host fixture is sanitized and records only stable probe output", async () => {
  const contract = await fixture();
  const serialized = JSON.stringify(contract);
  for (
    const forbidden of [
      /\/home\//,
      /\/tmp\//,
      /(?:token|secret|password|credential)[=:][^,}\s]+/i,
    ]
  ) {
    assert(
      !forbidden.test(serialized),
      `Agent Host fixture contains unsanitized data matching ${forbidden}`,
    );
  }
  assert(
    contract.cli.optionNames.includes("connection-token"),
    "Connection authentication option was not recorded",
  );
  assert(
    contract.cli.optionNames.includes("tunnel"),
    "Remote Agent Host option was not recorded",
  );
});

Deno.test("installed VS Code Agent Host matches the pinned fixture when explicitly enabled", async () => {
  const productJson = Deno.env.get("VSCODE_PRODUCT_JSON");
  if (!productJson) return;
  const expected = await fixture();
  const actual = await probeAgentHost({
    codeExecutable: Deno.env.get("VSCODE_EXECUTABLE") ?? "code",
    productJson,
    extensionPackageJson: new URL("../package.json", import.meta.url).pathname,
  });
  assert(
    actual.vscode.version === expected.vscode.version,
    `VS Code version drifted: ${actual.vscode.version}`,
  );
  assert(
    JSON.stringify(actual.cli.optionNames) ===
      JSON.stringify(expected.cli.optionNames),
    "Agent Host CLI options drifted",
  );
  assert(
    JSON.stringify(actual.proposals) === JSON.stringify(expected.proposals),
    "Agent Host proposal allowlists drifted",
  );
  assert(
    JSON.stringify(actual.conclusions) === JSON.stringify(expected.conclusions),
    "Agent Host feasibility conclusion drifted",
  );
});
