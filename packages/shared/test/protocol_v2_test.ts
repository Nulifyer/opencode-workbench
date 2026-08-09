import {
  capabilitiesForRuntime,
  enforceProtocolLimits,
  negotiateProtocol,
  parseHelloMessage,
  parseProtocolMessage,
  ProtocolValidationError,
} from "../src/protocol-v2.ts";
import { PROTOCOL_V2_SCHEMA_SOURCE } from "../src/protocol-schema.ts";

interface FixtureCorpus {
  accepted: Array<{ name: string; value: unknown }>;
  rejected: Array<
    {
      name: string;
      value: unknown;
      expectedCode: string;
      expectedMessage: string;
    }
  >;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const fixtures = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/protocol-v2.json", import.meta.url),
  ),
) as FixtureCorpus;

Deno.test("every accepted protocol v2 fixture validates", () => {
  for (const fixture of fixtures.accepted) {
    try {
      parseProtocolMessage(fixture.value);
    } catch (error) {
      throw new Error(
        `${fixture.name} did not validate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
});

Deno.test("every rejected protocol v2 fixture fails for its recorded reason", () => {
  for (const fixture of fixtures.rejected) {
    let failure: unknown;
    try {
      parseProtocolMessage(fixture.value);
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof ProtocolValidationError,
      `${fixture.name} unexpectedly validated`,
    );
    assert(
      failure.code === fixture.expectedCode,
      `${fixture.name} returned ${failure.code}, expected ${fixture.expectedCode}`,
    );
    assert(
      failure.message.includes(fixture.expectedMessage),
      `${fixture.name} returned unexpected message: ${failure.message}`,
    );
  }
});

Deno.test("protocol negotiation rejects non-overlapping versions clearly", () => {
  assert(
    negotiateProtocol(
      parseHelloMessage(fixtures.accepted[0]!.value).protocolRange,
    ) === 2,
    "Protocol overlap did not select v2",
  );
  let failure: unknown;
  try {
    negotiateProtocol({ minimum: 3, maximum: 4 });
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof ProtocolValidationError &&
      failure.code === "CAPABILITY_UNAVAILABLE",
    "Incompatible range did not produce a capability error",
  );
  assert(
    failure.message.includes("client supports 3-4") &&
      failure.message.includes("host supports 2-2"),
    "Compatibility error omitted ranges",
  );
});

Deno.test("external runtime truthfully disables missing companion capabilities", () => {
  const external = capabilitiesForRuntime("external", "missing");
  assert(
    external["session.create"] && external["prompt.followUp"],
    "External runtime lost base HTTP features",
  );
  for (
    const capability of [
      "goal.lifecycle",
      "preference.memory",
      "skill.candidates",
      "context.editorBridge",
      "native.agentHost",
    ] as const
  ) {
    assert(
      !external[capability],
      `External runtime incorrectly advertised ${capability}`,
    );
  }
});

Deno.test("protocol size and string limits are enforced", () => {
  const limits = {
    ...PROTOCOL_V2_SCHEMA_SOURCE.defaultLimits,
    maxRequestBytes: 100,
    maxStringCharacters: 8,
  };
  for (
    const value of [{ payload: "123456789" }, { payload: "x".repeat(200) }]
  ) {
    let failure: unknown;
    try {
      enforceProtocolLimits(value, limits);
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof ProtocolValidationError,
      "Oversized protocol value was accepted",
    );
  }
});
