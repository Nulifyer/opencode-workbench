import {
  capabilitiesForRuntime,
  type ProtocolLimits,
  type Request,
} from "@opencode-workbench/shared";
import { HostRouter } from "../src/protocol/host-router.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const limits: ProtocolLimits = {
  maxRequestBytes: 100_000,
  maxPendingRequests: 8,
  maxEventQueue: 100,
  maxStringCharacters: 50_000,
  maxErrorDetailsBytes: 16_384,
};

function request(
  id: string,
  type: string,
  payload: unknown = {},
  mutationID?: string,
): Request {
  return {
    protocol: 2,
    kind: "request",
    id,
    type,
    payload,
    ...(mutationID ? { mutationID } : {}),
  };
}

Deno.test("duplicate mutation retries execute once and keep response correlation", async () => {
  const router = new HostRouter({
    capabilities: capabilitiesForRuntime("managed", "connected"),
    limits,
  });
  let executions = 0;
  router.register("session.create", {
    capability: "session.create",
    mutation: true,
    handler: async () => ({ sessionID: `session-${++executions}` }),
  });
  const first = await router.route(
    "surface",
    request("request-1", "session.create", { title: "A" }, "mutation-1"),
  );
  const retry = await router.route(
    "surface",
    request("request-2", "session.create", { title: "A" }, "mutation-1"),
  );
  assert(first.ok && retry.ok, "Idempotent create failed");
  assert(executions === 1, `Duplicate mutation executed ${executions} times`);
  assert(
    first.id === "request-1" && retry.id === "request-2",
    "Cached response lost request correlation",
  );
  assert(
    JSON.stringify(first.result) === JSON.stringify(retry.result),
    "Retry returned a different created resource",
  );
  const conflict = await router.route(
    "surface",
    request("request-3", "session.create", { title: "B" }, "mutation-1"),
  );
  assert(
    !conflict.ok && conflict.error.code === "OPERATION_CONFLICT",
    "Mutation ID reuse with a new payload was accepted",
  );
});

Deno.test("cancellation and timeout preserve prompt input until explicit admission", async () => {
  const router = new HostRouter({
    capabilities: capabilitiesForRuntime("managed", "connected"),
    limits,
    defaultTimeoutMilliseconds: 25,
  });
  router.register("prompt.send", {
    capability: "prompt.followUp",
    longRunning: true,
    preservesInputUntilAdmission: true,
    handler: async (context) => {
      await new Promise<void>((_resolve, reject) =>
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        )
      );
    },
  });
  const pending = router.route(
    "surface",
    request("cancel-me", "prompt.send", { text: "keep me" }),
  );
  await Promise.resolve();
  assert(router.cancel("cancel-me"), "Pending request was not cancellable");
  const cancelled = await pending;
  assert(
    !cancelled.ok && cancelled.error.code === "CANCELLED",
    "Cancellation did not return structured CANCELLED",
  );
  assert(
    (cancelled.error.details as { inputDisposition?: string })
      ?.inputDisposition === "preserved",
    "Cancellation discarded unadmitted input",
  );

  const timedOut = await router.route(
    "surface",
    request("timeout", "prompt.send", { text: "keep me too" }),
  );
  assert(
    !timedOut.ok && timedOut.error.code === "TIMEOUT" &&
      timedOut.error.retryable,
    "Timeout did not return retryable structured TIMEOUT",
  );
  assert(
    (timedOut.error.details as { inputDisposition?: string })
      ?.inputDisposition === "preserved",
    "Timeout discarded unadmitted input",
  );
});

Deno.test("router cancellation settles even when an upstream handler ignores its signal", async () => {
  const router = new HostRouter({
    capabilities: capabilitiesForRuntime("managed", "connected"),
    limits,
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  router.register("cooperative-upstream", {
    handler: async () => await blocked,
  });
  const pending = router.route(
    "surface",
    request("ignored-signal", "cooperative-upstream"),
  );
  await Promise.resolve();
  assert(router.cancel("ignored-signal"), "Request was not registered for cancellation");
  const response = await pending;
  assert(
    !response.ok && response.error.code === "CANCELLED",
    "Ignored abort signal prevented deterministic cancellation",
  );
  release();
});

Deno.test("prompt handler must explicitly admit or reject input", async () => {
  const router = new HostRouter({
    capabilities: capabilitiesForRuntime("managed", "connected"),
    limits,
  });
  router.register("prompt.send", {
    preservesInputUntilAdmission: true,
    handler: async () => ({ accepted: true }),
  });
  const unsafe = await router.route(
    "surface",
    request("unsafe", "prompt.send"),
  );
  assert(
    !unsafe.ok && unsafe.error.code === "INTERNAL",
    "Handler silently accepted input without admission",
  );
  assert(
    (unsafe.error.details as { inputDisposition?: string })
      ?.inputDisposition === "preserved",
    "Unsafe handler lost input",
  );

  router.register("prompt.admit", {
    preservesInputUntilAdmission: true,
    handler: async (context) => {
      context.admitInput();
      return { admitted: true };
    },
  });
  const safe = await router.route("surface", request("safe", "prompt.admit"));
  assert(safe.ok, "Explicit prompt admission failed");
});

Deno.test("overload, duplicate request IDs, and missing capabilities are structured", async () => {
  const constrained = { ...limits, maxPendingRequests: 1 };
  const router = new HostRouter({
    capabilities: capabilitiesForRuntime("external", "missing"),
    limits: constrained,
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  router.register("hold", { handler: async () => await blocked });
  router.register("goal.read", {
    capability: "goal.lifecycle",
    handler: async () => ({}),
  });
  const first = router.route("surface", request("same", "hold"));
  await Promise.resolve();
  const duplicate = await router.route("surface", request("same", "hold"));
  assert(
    !duplicate.ok && duplicate.error.code === "OPERATION_CONFLICT",
    "Duplicate request ID was not rejected",
  );
  const overloaded = await router.route("surface", request("other", "hold"));
  assert(
    !overloaded.ok && overloaded.error.code === "OVERLOADED" &&
      overloaded.error.retryable,
    "Full registry did not return retryable overload",
  );
  const unavailable = await router.route(
    "surface",
    request("goal", "goal.read"),
  );
  assert(
    !unavailable.ok && unavailable.error.code === "CAPABILITY_UNAVAILABLE",
    "External mode advertised missing companion feature",
  );
  release();
  await first;
});

Deno.test("surface disposal cancels or detaches according to route policy", async () => {
  const router = new HostRouter({
    capabilities: capabilitiesForRuntime("managed", "connected"),
    limits,
  });
  router.register("cancel-on-close", {
    handler: async (context) =>
      await new Promise((_resolve, reject) =>
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        )
      ),
  });
  let finishDetached!: () => void;
  router.register("detach-on-close", {
    surfaceDisposition: "detach",
    handler: async () =>
      await new Promise<void>((resolve) => finishDetached = resolve),
  });
  const cancelledPromise = router.route(
    "surface",
    request("cancel", "cancel-on-close"),
  );
  const detachedPromise = router.route(
    "surface",
    request("detach", "detach-on-close"),
  );
  await Promise.resolve();
  const disposition = router.disposeSurface("surface");
  assert(
    JSON.stringify(disposition.cancelled) === JSON.stringify(["cancel"]),
    "Surface disposal cancelled wrong requests",
  );
  assert(
    JSON.stringify(disposition.detached) === JSON.stringify(["detach"]),
    "Surface disposal did not detach durable request",
  );
  const cancelled = await cancelledPromise;
  assert(
    !cancelled.ok && cancelled.error.code === "CANCELLED",
    "Disposed cancellable request did not stop",
  );
  finishDetached();
  const detached = await detachedPromise;
  assert(detached.ok, "Detached request did not finish independently");
});
