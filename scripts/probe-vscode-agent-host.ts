import path from "node:path"
import { fileURLToPath } from "node:url"

type JsonObject = Record<string, unknown>

export interface AgentHostProposalEvidence {
  proposal: string
  allowlistedExtensionIDs: string[]
}

export interface AgentHostFeasibilityFixture {
  schemaVersion: 1
  recordedAt: string
  vscode: {
    channel: "stable" | "insiders" | "unknown"
    version: string
    commit: string
    architecture: string
  }
  cli: {
    agentHostCommandAvailable: boolean
    optionNames: string[]
    customAdapterRegistrationOptionNames: string[]
  }
  extension: {
    id: string
    version: string
    enabledApiProposals: string[]
    contributesChatSessions: boolean
  }
  proposals: AgentHostProposalEvidence[]
  conclusions: {
    publicMarketplaceRegistrationProven: boolean
    standaloneHostAcceptsThirdPartyAdapter: boolean
    nativePickerRegistration:
      | "public"
      | "blocked-proposed-api-allowlist"
      | "unknown"
    productionDependencyAllowed: false
  }
}

export interface ProbeAgentHostOptions {
  codeExecutable: string
  productJson: string
  extensionPackageJson?: string
  extensionID?: string
}

const RELEVANT_PROPOSALS = [
  "agentSessionsWorkspace",
  "agentsWindowConfiguration",
  "chatSessionCustomizationProvider",
  "chatSessionsProvider",
  "languageModelProxy",
  "remoteCodingAgents",
] as const

function record(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`)
  }
  return value as JsonObject
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

async function readJson(file: string): Promise<JsonObject> {
  return record(JSON.parse(await Deno.readTextFile(file)), file)
}

async function run(executable: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(executable, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output()
  const decoder = new TextDecoder()
  const output = `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`
  if (!result.success) {
    throw new Error(`${executable} ${args.join(" ")} failed: ${output.trim()}`)
  }
  return output
}

function optionNames(help: string): string[] {
  return [...help.matchAll(/^\s+--([a-z][a-z0-9-]*)\b/gim)].map((match) => match[1]).sort()
}

export async function probeAgentHost(
  options: ProbeAgentHostOptions,
): Promise<AgentHostFeasibilityFixture> {
  const [versionOutput, hostHelp, product, extensionPackage] = await Promise
    .all([
      run(options.codeExecutable, ["--version"]),
      run(options.codeExecutable, ["agent", "host", "--help"]),
      readJson(options.productJson),
      options.extensionPackageJson ? readJson(options.extensionPackageJson) : Promise.resolve({} as JsonObject),
    ])
  const [version = "unknown", commit = "unknown", architecture = "unknown"] = versionOutput.trim().split(/\r?\n/)
  const extensionID = options.extensionID ?? "nulifyer.opencode-workbench"
  const proposalAllowlist = record(
    product.extensionEnabledApiProposals ?? {},
    "extensionEnabledApiProposals",
  )
  const proposals = RELEVANT_PROPOSALS.map((proposal) => ({
    proposal,
    allowlistedExtensionIDs: Object.entries(proposalAllowlist)
      .filter(([, enabled]) => stringArray(enabled).includes(proposal))
      .map(([id]) => id)
      .sort(),
  }))
  const enabledApiProposals = stringArray(proposalAllowlist[extensionID])
    .sort()
  const contributes = record(
    extensionPackage.contributes ?? {},
    "extension contributes",
  )
  const optionsFound = optionNames(hostHelp)
  const customAdapterRegistrationOptionNames = optionsFound.filter((name) =>
    /(?:adapter|backend|harness|agent-command|agent-executable|plugin)/i.test(
      name,
    )
  )
  const chatSessionsProvider = proposals.find((entry) => entry.proposal === "chatSessionsProvider")
  const publicMarketplaceRegistrationProven = enabledApiProposals.includes("chatSessionsProvider") &&
    Boolean(
      chatSessionsProvider?.allowlistedExtensionIDs.includes(extensionID),
    )

  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    vscode: {
      channel: options.codeExecutable.toLowerCase().includes("insiders") ? "insiders" : "stable",
      version,
      commit,
      architecture,
    },
    cli: {
      agentHostCommandAvailable: /Start a local agent host server/i.test(
        hostHelp,
      ),
      optionNames: optionsFound,
      customAdapterRegistrationOptionNames,
    },
    extension: {
      id: extensionID,
      version: typeof extensionPackage.version === "string" ? extensionPackage.version : "unknown",
      enabledApiProposals,
      contributesChatSessions: Array.isArray(contributes.chatSessions),
    },
    proposals,
    conclusions: {
      publicMarketplaceRegistrationProven,
      standaloneHostAcceptsThirdPartyAdapter: customAdapterRegistrationOptionNames.length > 0,
      nativePickerRegistration: publicMarketplaceRegistrationProven ? "public" : "blocked-proposed-api-allowlist",
      productionDependencyAllowed: false,
    },
  }
}

function argument(name: string): string | undefined {
  const index = Deno.args.indexOf(name)
  return index >= 0 ? Deno.args[index + 1] : undefined
}

if (import.meta.main) {
  const repository = path.resolve(
    fileURLToPath(new URL("../", import.meta.url)),
  )
  const productJson = argument("--product-json")
  if (!productJson) {
    throw new Error(
      "Usage: --product-json <path> [--code <path>] [--output <path>]",
    )
  }
  const result = await probeAgentHost({
    codeExecutable: argument("--code") ?? "code",
    productJson,
    extensionPackageJson: argument("--extension-package") ??
      path.join(repository, "packages", "vscode-extension", "package.json"),
    extensionID: argument("--extension-id"),
  })
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  const output = argument("--output")
  if (output) await Deno.writeTextFile(output, serialized)
  else console.log(serialized.trimEnd())
}
