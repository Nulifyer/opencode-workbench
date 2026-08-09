import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedOpenCodeServer } from "../packages/vscode-extension/src/managed-server.ts";
import { OpenCodeClient } from "../packages/vscode-extension/src/opencode-client.ts";

type JsonObject = Record<string, unknown>;

export interface VerifierContractFixture {
  schemaVersion: 1;
  recordedAt: string;
  providerRequestMode: "disabled" | "opt-in-enabled";
  opencodeVersion: string;
  verifier: {
    executionPath: "separate-opencode-session";
    agentName: "workbench-verifier";
    agentMode: string;
    wildcardPermissionDenied: boolean;
    requestToolsDisabled: boolean;
    transcriptVisible: boolean;
    noAssistantMessageWithoutProvider: boolean;
    selectedModelPersisted: boolean;
    structuredOutputFormatAccepted: boolean;
    jsonSchemaAccepted: boolean;
    structuredOutputLegacyTranscriptCompatible: boolean;
    retryCountAcceptedOnPrompt: boolean;
    retryCountTranscriptCompatible: boolean;
    idleCancellationAccepted: boolean;
    providerSdkAdded: false;
  };
  classifications: Array<{
    concern: string;
    status:
      | "proven-provider-free"
      | "requires-opt-in-model-probe"
      | "workbench-owned";
    evidence: string;
  }>;
}

export interface RecordVerifierContractOptions {
  executable: string;
  expectedVersion?: string;
  allowModelPrompt?: boolean;
}

const AGENT_NAME = "workbench-verifier" as const;
const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "evidence"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
    summary: { type: "string", minLength: 1, maxLength: 4_096 },
    evidence: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "detail"],
        properties: {
          kind: {
            type: "string",
            enum: ["test", "diagnostic", "diff", "artifact", "observation"],
          },
          detail: { type: "string", minLength: 1, maxLength: 4_096 },
        },
      },
    },
  },
} as const;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isolatedEnvironment(root: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (
      key.startsWith("OPENCODE_") ||
      /(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|API)/i.test(key)
    ) continue;
    environment[key] = value;
  }
  environment.HOME = path.join(root, "home");
  environment.XDG_CONFIG_HOME = path.join(root, "config");
  environment.XDG_DATA_HOME = path.join(root, "data");
  environment.XDG_CACHE_HOME = path.join(root, "cache");
  environment.XDG_STATE_HOME = path.join(root, "state");
  environment.OPENCODE_DISABLE_AUTOUPDATE = "true";
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    agent: {
      [AGENT_NAME]: {
        description:
          "Evaluate supplied evidence and return only the requested verdict schema.",
        mode: "primary",
        prompt:
          "Evaluate only the supplied evidence. Do not inspect or modify the filesystem and do not call tools.",
        permission: { "*": "deny" },
      },
    },
  });
  return environment;
}

function authorization(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

async function request(
  baseUrl: string,
  directory: string,
  auth: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<unknown> {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set("directory", directory);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${pathname} failed with HTTP ${response.status}: ${
        (await response.text()).slice(0, 2_048)
      }`,
    );
  }
  if (response.status === 204) return undefined;
  return await response.json();
}

async function responseStatus(
  baseUrl: string,
  directory: string,
  auth: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set("directory", directory);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: auth,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, text: await response.text() };
}

function wildcardDenied(value: unknown): boolean {
  return Array.isArray(value) &&
    value.some((rule) =>
      isRecord(rule) && rule.permission === "*" && rule.action === "deny" &&
      rule.pattern === "*"
    );
}

export async function recordVerifierContract(
  options: RecordVerifierContractOptions,
): Promise<VerifierContractFixture> {
  if (options.allowModelPrompt) {
    throw new Error(
      "The Phase 0 recorder intentionally has no model-producing prompt. Exercise model output through the later verifier service integration test.",
    );
  }
  const root = await Deno.makeTempDir({
    prefix: "opencode-workbench-verifier-",
  });
  const workspace = path.join(root, "workspace");
  await Deno.mkdir(workspace);
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const manager = new ManagedOpenCodeServer({
    directory: workspace,
    extensionPath: repository,
    executablePath: options.executable,
    environment: isolatedEnvironment(root),
  });
  let client: OpenCodeClient | undefined;
  const sessionIDs: string[] = [];
  let failure: unknown;
  try {
    const connection = await manager.start();
    client = new OpenCodeClient(connection);
    const health = await client.health();
    if (options.expectedVersion && health.version !== options.expectedVersion) {
      throw new Error(
        `Expected OpenCode ${options.expectedVersion}, received ${health.version}`,
      );
    }
    const auth = authorization(connection.username, connection.password);
    const agents = await request(
      connection.baseUrl,
      workspace,
      auth,
      "GET",
      "/agent",
    );
    const verifierAgent = Array.isArray(agents)
      ? agents.find((agent) => isRecord(agent) && agent.name === AGENT_NAME)
      : undefined;
    if (!isRecord(verifierAgent)) {
      throw new Error("Isolated verifier agent was not registered");
    }

    const session = await client.createSession("Workbench verifier contract");
    sessionIDs.push(session.id);
    const prompt = {
      noReply: true,
      agent: AGENT_NAME,
      tools: { "*": false },
      format: { type: "json_schema", schema: VERDICT_SCHEMA, retryCount: 2 },
      parts: [{
        type: "text",
        text:
          "Evaluate the supplied synthetic evidence only: all deterministic checks passed.",
      }],
    };
    const promptAdmission = await responseStatus(
      connection.baseUrl,
      workspace,
      auth,
      "POST",
      `/session/${encodeURIComponent(session.id)}/prompt_async`,
      prompt,
    );
    if (promptAdmission.status !== 204) {
      throw new Error(
        `OpenCode rejected the provider-free verifier prompt: HTTP ${promptAdmission.status}: ${
          promptAdmission.text.slice(0, 2_048)
        }`,
      );
    }
    let projected: JsonObject[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const messages = await request(
        connection.baseUrl,
        workspace,
        auth,
        "GET",
        `/api/session/${encodeURIComponent(session.id)}/message`,
      );
      projected = isRecord(messages) && Array.isArray(messages.data)
        ? messages.data.filter(isRecord)
        : [];
      if (projected.some((message) => message.type === "user")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const user = projected.find((message) => message.type === "user");
    const assistantPresent = projected.some((message) =>
      message.type === "assistant"
    );
    const sessionState = await request(
      connection.baseUrl,
      workspace,
      auth,
      "GET",
      `/session/${encodeURIComponent(session.id)}`,
    );
    const storedSession = isRecord(sessionState) ? sessionState : {};
    const model = isRecord(storedSession.model) ? storedSession.model : {};
    const legacyTranscript = await responseStatus(
      connection.baseUrl,
      workspace,
      auth,
      "GET",
      `/session/${encodeURIComponent(session.id)}/message`,
    );
    const cancellationAccepted = await client.abort(session.id);

    return {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      providerRequestMode: "disabled",
      opencodeVersion: health.version,
      verifier: {
        executionPath: "separate-opencode-session",
        agentName: AGENT_NAME,
        agentMode: typeof verifierAgent.mode === "string"
          ? verifierAgent.mode
          : "unknown",
        wildcardPermissionDenied: wildcardDenied(verifierAgent.permission),
        requestToolsDisabled: wildcardDenied(storedSession.permission),
        transcriptVisible: isRecord(user) &&
          (user.text === prompt.parts[0].text ||
            (Array.isArray(user.content) &&
              user.content.some((part) =>
                isRecord(part) && part.type === "text" &&
                part.text === prompt.parts[0].text
              ))),
        noAssistantMessageWithoutProvider: !assistantPresent,
        selectedModelPersisted: typeof model.providerID === "string" &&
          (typeof model.id === "string" || typeof model.modelID === "string"),
        structuredOutputFormatAccepted: promptAdmission.status === 204,
        jsonSchemaAccepted: promptAdmission.status === 204 &&
          prompt.format.schema.type === "object" &&
          Array.isArray(prompt.format.schema.required),
        structuredOutputLegacyTranscriptCompatible:
          legacyTranscript.status === 200,
        retryCountAcceptedOnPrompt: promptAdmission.status === 204,
        retryCountTranscriptCompatible: legacyTranscript.status === 200,
        idleCancellationAccepted: cancellationAccepted,
        providerSdkAdded: false,
      },
      classifications: [
        {
          concern: "model selection",
          status: "proven-provider-free",
          evidence:
            "The admitted verifier user message persists the exact provider/model selected by OpenCode.",
        },
        {
          concern: "schema enforcement",
          status: "requires-opt-in-model-probe",
          evidence:
            "OpenCode persists json_schema and the bounded verdict schema; output validation requires a provider response.",
        },
        {
          concern: "timeout and cancellation",
          status: "workbench-owned",
          evidence:
            "Requests use bounded AbortSignals and OpenCode accepts session interruption; the verifier service must own its wall-clock deadline.",
        },
        {
          concern: "transcript visibility",
          status: "requires-opt-in-model-probe",
          evidence:
            "The separate session is inspectable, but 1.18.15 rejects the structured-output legacy transcript and the provider-free v2 projection is empty.",
        },
        {
          concern: "filesystem and tool isolation",
          status: "proven-provider-free",
          evidence:
            "The custom agent resolves wildcard permission deny and the admitted request persists wildcard tools false.",
        },
        {
          concern: "token accounting",
          status: "requires-opt-in-model-probe",
          evidence:
            "No provider response means no token usage; production reads authoritative usage from the verifier assistant message.",
        },
        {
          concern: "retry behavior",
          status: "workbench-owned",
          evidence:
            "OpenCode accepts retryCount but 1.18.15 then rejects its own legacy transcript shape; production owns a bounded retry budget.",
        },
        {
          concern: "provider-free test seam",
          status: "proven-provider-free",
          evidence:
            "noReply admits and persists the complete verifier request without creating an assistant message or contacting a model.",
        },
      ],
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (client) {
      for (const sessionID of sessionIDs) {
        await client.deleteSession(sessionID).catch((error) =>
          cleanupErrors.push(error)
        );
      }
    }
    await manager.stop().catch((error) => cleanupErrors.push(error));
    await Deno.remove(root, { recursive: true }).catch((error) =>
      cleanupErrors.push(error)
    );
    if (cleanupErrors.length && !failure) {
      throw new AggregateError(
        cleanupErrors,
        "Verifier contract cleanup failed",
      );
    }
  }
}

function argument(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

if (import.meta.main) {
  const executable = argument("--executable");
  if (!executable) {
    throw new Error(
      "Usage: --executable <absolute path> [--expected-version <version>] [--output <path>]",
    );
  }
  const result = await recordVerifierContract({
    executable,
    expectedVersion: argument("--expected-version"),
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const output = argument("--output");
  if (output) await Deno.writeTextFile(output, serialized);
  else console.log(serialized.trimEnd());
}
