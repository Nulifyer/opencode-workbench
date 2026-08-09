import {
  capabilitiesForRuntime,
  type ProtocolLimits,
  type Request,
} from "@opencode-workbench/shared";
import { WebviewProtocolHost } from "../src/protocol/webview-protocol-host.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const limits: ProtocolLimits = {
  maxRequestBytes: 100_000,
  maxPendingRequests: 8,
  maxEventQueue: 2,
  maxStringCharacters: 50_000,
  maxErrorDetailsBytes: 16_384,
};

interface Action {
  type: string;
  value?: number;
}

function parseAction(value: unknown): Action | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.type === "string" &&
      (candidate.value === undefined || Number.isSafeInteger(candidate.value))
    ? candidate as unknown as Action
    : undefined;
}

function request(
  id: string,
  payload: Action,
  mutationID = `mutation-${id}`,
): Request {
  return {
    protocol: 2,
    kind: "request",
    id,
    type: "workbench.dispatch",
    mutationID,
    payload,
  };
}

Deno.test("production webview host negotiates, correlates, recovers, and keeps v1 compatibility", async () => {
  const posted: unknown[] = [];
  const handled: Action[] = [];
  const observations: Array<{ type: string; requestID?: string; revision?: number; transition?: string }> = [];
  const state: Action[] = [{ type: "snapshot", value: 0 }];
  const host = new WebviewProtocolHost<Action[], Action, Action>({
    state: () => state,
    runtime: () => ({
      mode: "managed",
      authority: "opencode",
      companion: "connected",
      nativeAgentHost: "deferred",
    }),
    parseInbound: parseAction,
    dispatch: async (_surfaceID, message) => {
      handled.push(message);
    },
    eventDisposition: (message) => message.type === "status" ? "transient" : "patch",
    observe: (observation) => observations.push(observation),
    limits,
  });
  host.attach("surface", { postMessage: (message) => posted.push(message) }, true);
  assert(await host.receive("surface", {
    protocolRange: { minimum: 2, maximum: 2 },
    client: { surfaceID: "surface", extensionVersion: "test" },
  }), "Hello was not recognized");
  const ready = posted[0] as { protocol?: number; capabilities?: Record<string, boolean> };
  const initial = posted[1] as { kind?: string; type?: string; sequence?: number; payload?: { snapshot?: { state?: Action[] } } };
  assert(ready.protocol === 2 && ready.capabilities?.["session.create"], "Negotiated capabilities were not published");
  assert(initial.kind === "event" && initial.type === "workbench.snapshot" && initial.sequence === 0, "Initial v2 snapshot was not published at the initial cursor");
  assert(initial.payload?.snapshot?.state?.[0]?.type === "snapshot", "Initial snapshot lost host state");

  posted.length = 0;
  await host.receive("surface", request("one", { type: "act", value: 1 }));
  const response = posted[0] as { kind?: string; id?: string; ok?: boolean };
  assert(response.kind === "response" && response.id === "one" && response.ok, "Action response lost correlation");
  assert(handled.length === 1 && handled[0]?.value === 1, "Negotiated action did not reach the live handler");
  assert(observations.some((entry) => entry.type === "protocol.request.completed" && entry.requestID === "one" && entry.transition === "dispatch:ok"), "Completed request trace lost its safe correlation fields");

  posted.length = 0;
  state[0] = { type: "snapshot", value: 1 };
  await host.publishTo("surface", { type: "patch", value: 1 });
  const firstEvent = posted[0] as { sequence?: number; revision?: number; payload?: { baseRevision?: number; nextRevision?: number } };
  assert(firstEvent.sequence === 1 && firstEvent.revision === 1 && firstEvent.payload?.baseRevision === 0 && firstEvent.payload.nextRevision === 1, "Live patch did not carry exact event/revision positions");
  assert(observations.some((entry) => entry.type === "protocol.event.published" && entry.revision === 1), "Published event trace lost its revision");

  await host.setVisible("surface", false);
  posted.length = 0;
  for (let value = 2; value <= 4; value += 1) {
    state[0] = { type: "snapshot", value };
    await host.publishTo("surface", { type: "patch", value });
  }
  assert(posted.length === 0, "Hidden surface received queued semantic events");
  await host.setVisible("surface", true);
  const overflowRecovery = posted.at(-1) as { type?: string; payload?: { snapshot?: { state?: Action[] } } };
  assert(overflowRecovery.type === "workbench.snapshot" && overflowRecovery.payload?.snapshot?.state?.[0]?.value === 4, "Hidden queue overflow did not recover with current state");

  const previousEpoch = host.currentEpoch;
  posted.length = 0;
  await host.rotateEpoch();
  const rotated = posted[0] as { epoch?: string; sequence?: number };
  assert(rotated.epoch !== previousEpoch && rotated.sequence === 0, "Runtime generation did not replace the webview epoch and cursor");

  const legacy: unknown[] = [];
  host.attach("legacy", { postMessage: (message) => legacy.push(message) }, true);
  assert(!await host.receive("legacy", { type: "ready" }), "Legacy action was consumed as v2");
  assert(
    !await host.receive("legacy", { type: "permission", protocol: "legacy" }),
    "Application-level v1 protocol discriminator was mistaken for a v2 envelope",
  );
  host.markLegacy("legacy");
  await host.publishTo("legacy", { type: "snapshot", value: 9 });
  assert((legacy[0] as Action).value === 9, "Legacy surface compatibility was lost");
});

Deno.test("negotiated capability checks reject unavailable companion actions", async () => {
  const posted: unknown[] = [];
  const host = new WebviewProtocolHost<Action[], Action, Action>({
    state: () => [],
    runtime: () => ({
      mode: "external",
      authority: "opencode",
      companion: "missing",
      nativeAgentHost: "deferred",
    }),
    parseInbound: parseAction,
    dispatch: async () => undefined,
    requiredCapability: (message) => message.type === "goal" ? "goal.lifecycle" : undefined,
    limits,
  });
  host.attach("external", { postMessage: (message) => posted.push(message) }, true);
  await host.receive("external", {
    protocolRange: { minimum: 2, maximum: 2 },
    client: { surfaceID: "external", extensionVersion: "test" },
  });
  assert(
    !capabilitiesForRuntime("external", "missing")["goal.lifecycle"],
    "Test runtime unexpectedly advertised goal lifecycle",
  );
  posted.length = 0;
  await host.receive("external", request("goal", { type: "goal" }));
  const response = posted[0] as { ok?: boolean; error?: { code?: string } };
  assert(!response.ok && response.error?.code === "CAPABILITY_UNAVAILABLE", "Unavailable negotiated capability was admitted");
});

Deno.test("private composer payload is a revisioned follow-up rather than snapshot state", async () => {
  const posted: unknown[] = [];
  const host = new WebviewProtocolHost<Action[], Action, Action>({
    state: () => [{ type: "snapshot", value: 1 }],
    snapshotFollowups: () => [{ type: "composer-private", value: 2 }],
    runtime: () => ({
      mode: "managed",
      authority: "opencode",
      companion: "connected",
      nativeAgentHost: "deferred",
    }),
    parseInbound: parseAction,
    dispatch: async () => undefined,
    limits,
  });
  host.attach("private", { postMessage: (message) => posted.push(message) }, true);
  await host.receive("private", {
    protocolRange: { minimum: 2, maximum: 2 },
    client: { surfaceID: "private", extensionVersion: "test" },
  });
  const snapshot = posted[1] as { payload?: { snapshot?: { state?: Action[] } } };
  const followup = posted[2] as { sequence?: number; revision?: number; payload?: { message?: Action } };
  assert(snapshot.payload?.snapshot?.state?.some((message) => message.type === "composer-private") === false, "Private composer bytes leaked into snapshot state");
  assert(followup.sequence === 1 && followup.revision === 1 && followup.payload?.message?.type === "composer-private", "Private composer state was not rehydrated as a revisioned follow-up");
});

Deno.test("protocol trace categorizes resync, cancellation, and cancelled dispatch settlement", async () => {
  const posted: unknown[] = [];
  const observations: Array<{ type: string; requestID?: string; revision?: number; transition?: string }> = [];
  const host = new WebviewProtocolHost<Action[], Action, Action>({
    state: () => [],
    runtime: () => ({ mode: "managed", authority: "opencode", companion: "connected", nativeAgentHost: "deferred" }),
    parseInbound: parseAction,
    dispatch: async (_surfaceID, message, context) => {
      if (message.type !== "slow") return;
      await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
    },
    observe: (observation) => observations.push(observation),
    limits,
  });
  host.attach("trace", { postMessage: (message) => posted.push(message) }, true);
  await host.receive("trace", { protocolRange: { minimum: 2, maximum: 2 }, client: { surfaceID: "trace", extensionVersion: "test" } });

  const pending = host.receive("trace", request("slow", { type: "slow" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await host.receive("trace", { protocol: 2, kind: "request", id: "cancel", type: "protocol.cancel", payload: { requestID: "slow" } });
  await pending;
  await host.receive("trace", { protocol: 2, kind: "request", id: "resync", type: "protocol.resync", payload: { epoch: host.currentEpoch, lastSeenSequence: 0 } });
  await host.receive("trace", { protocol: 2, kind: "request", id: "resync-stale", type: "protocol.resync", payload: { epoch: "stale-epoch", lastSeenSequence: 0 } });

  assert(observations.some((entry) => entry.requestID === "cancel" && entry.transition === "cancel:ok"), "Cancel lifecycle was not traced");
  assert(observations.some((entry) => entry.type === "protocol.request.cancelled" && entry.requestID === "slow" && entry.transition === "cancelled"), "Cancel trace lost the target request outcome");
  assert(observations.some((entry) => entry.requestID === "slow" && entry.transition === "dispatch:CANCELLED"), "Cancelled dispatch settlement was not traced");
  assert(observations.some((entry) => entry.requestID === "resync" && entry.transition === "resync:ok"), "Resync lifecycle was not traced");
  assert(observations.some((entry) => entry.type === "protocol.resync.recovered" && entry.requestID === "resync" && entry.transition === "replay"), "Resync trace did not distinguish replay recovery");
  assert(observations.some((entry) => entry.type === "protocol.resync.recovered" && entry.requestID === "resync-stale" && entry.transition === "snapshot" && entry.revision === 0), "Stale-epoch resync trace did not identify authoritative snapshot recovery");
});
