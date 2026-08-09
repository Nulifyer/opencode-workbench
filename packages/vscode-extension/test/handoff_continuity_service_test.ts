import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import type {
  ContextReceipt,
  EvidenceReference,
} from "@opencode-workbench/shared";
import {
  GitCommonDirectoryHandoffStore,
  HANDOFF_CONTINUITY_LIMITS,
  HandoffContinuityError,
  HandoffContinuityService,
  type HandoffContinuityStore,
  type HandoffStoreMutation,
  rebindContextReceiptForHandoff,
} from "../src/application/handoff-continuity-service.ts";
import type { GitRunner } from "../src/application/worktree-service.ts";

class MemoryStore implements HandoffContinuityStore {
  value: unknown;
  active = 0;
  maximumActive = 0;
  writes: string[][] = [];

  constructor(value?: unknown, private readonly delay = false) {
    this.value = value;
  }

  async read(): Promise<unknown> {
    return structuredClone(this.value);
  }

  async transact<T>(
    mutation: (current: unknown) => HandoffStoreMutation<T>,
  ): Promise<T> {
    this.active++;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      if (this.delay) await new Promise((resolve) => setTimeout(resolve, 5));
      const result = mutation(structuredClone(this.value));
      this.value = structuredClone(result.registry);
      this.writes.push(
        result.registry.records.map((record) => record.targetSessionID),
      );
      return result.value;
    } finally {
      this.active--;
    }
  }
}

function receipt(sessionID: string, promptID = "prompt"): ContextReceipt {
  return {
    id: `context:${promptID}`,
    sessionID,
    promptID,
    admittedAt: 10,
    items: [
      {
        id: "selection:1",
        kind: "selection",
        label: 'Authorization: "Bearer receipt-secret"',
        uri: "https://user:password@example.test/path?token=receipt-secret",
        bytes: 20,
        estimatedTokens: 5,
        contentHash: "sha256:abc",
      },
      {
        id: "github:1",
        kind: "url",
        label: "GitHub issue",
        uri: "https://github.com/example/project/issues/1",
      },
    ],
    estimatedTokens: 5,
    truncation: "none",
  };
}

function evidence(sessionID: string, repository: string): EvidenceReference {
  return {
    id: "evidence:1",
    kind: "test",
    label: "Synthetic tests",
    status: "passed",
    observedAt: 12,
    sessionID,
    repository,
    summary: [
      "341 passed token=evidence-secret at https://user:password@example.test/result",
      'Authorization: "Bearer quoted-auth-secret"',
      "Proxy-Authorization: 'Basic proxy-auth-secret'",
      "Cookie: first=cookie-secret-one; second=cookie-secret-two",
      "OPENAI_API_KEY=prefixed-env-secret",
      "APP_REFRESH_TOKEN='refresh-token-secret'",
      "postgresql://db-user:db-password@example.test/database",
      "X_AMZ_SIGNATURE=cloud-signature-secret",
      "eyJabcdefghij.abcdefghijklmnop.abcdefghijklmnop",
    ].join("\n"),
  };
}

Deno.test("cross-workspace handoff persists only bounded redacted receipt and evidence metadata", async () => {
  const target = Deno.cwd();
  const store = new MemoryStore();
  const service = new HandoffContinuityService(store, () => 100);
  const published = await service.exportHandoff({
    targetDirectory: target,
    targetSessionID: "session",
    originReceiptIDs: ["context:group"],
    receipts: [{
      ...receipt("session"),
      promptBody: "raw-prompt-must-not-persist",
    } as ContextReceipt],
    evidence: [{
      ...evidence("session", target),
      taskOutput: "raw-output-must-not-persist",
    } as EvidenceReference],
  });

  const serialized = JSON.stringify(store.value);
  assert(!serialized.includes("receipt-secret"));
  assert(!serialized.includes("evidence-secret"));
  assert(!serialized.includes("user:password"));
  assert(!serialized.includes("quoted-auth-secret"));
  assert(!serialized.includes("proxy-auth-secret"));
  assert(!serialized.includes("cookie-secret"));
  assert(!serialized.includes("prefixed-env-secret"));
  assert(!serialized.includes("refresh-token-secret"));
  assert(!serialized.includes("db-user:db-password"));
  assert(!serialized.includes("cloud-signature-secret"));
  assert(!serialized.includes("eyJabcdefghij"));
  assert(!serialized.includes("raw-prompt-must-not-persist"));
  assert(!serialized.includes("raw-output-must-not-persist"));
  assert(!serialized.includes("promptText"));
  assertStringIncludes(serialized, "[redacted]");
  assertEquals(published.receipts[0]?.items[0]?.uri, undefined);
  assertEquals(
    published.receipts[0]?.items[1]?.uri,
    "https://github.com/example/project/issues/1",
  );

  const restarted = new HandoffContinuityService(store, () => 101);
  const imported = await restarted.importHandoff(target, "session");
  assertEquals(imported.records.length, 1);
  assertEquals(imported.records[0]?.originReceiptIDs, ["context:group"]);
  assertEquals(imported.receipts[0]?.items[0]?.contentHash, "sha256:abc");
  assertEquals(imported.evidence[0]?.id, "evidence:1");
  assertEquals(imported.limitations, []);
});

Deno.test("per-run receipt rebinding retains exact sanitized items under real admission identity", () => {
  const rebound = rebindContextReceiptForHandoff(
    receipt("run-group", "group-prompt"),
    "actual-session",
    "actual-prompt",
    50,
  );
  assertEquals(rebound.id, "context:actual-prompt");
  assertEquals(rebound.sessionID, "actual-session");
  assertEquals(rebound.promptID, "actual-prompt");
  assertEquals(rebound.admittedAt, 50);
  assertEquals(rebound.items[0]?.contentHash, "sha256:abc");
  assertStringIncludes(rebound.items[0]?.label ?? "", "[redacted]");
  assertEquals(rebound.items[0]?.uri, undefined);
});

Deno.test("handoff writes are invocation ordered and flush waits for queued durability", async () => {
  const store = new MemoryStore(undefined, true);
  const service = new HandoffContinuityService(store, () => 200);
  service.queueHandoff({
    targetDirectory: Deno.cwd(),
    targetSessionID: "first",
    receipts: [receipt("first", "one")],
  });
  service.queueHandoff({
    targetDirectory: Deno.cwd(),
    targetSessionID: "second",
    receipts: [receipt("second", "two")],
  });
  await service.flush();

  assertEquals(store.maximumActive, 1);
  assertEquals(store.writes, [["first"], ["second", "first"]]);
  assertEquals(
    (await service.importHandoff(Deno.cwd())).records.map((record) =>
      record.targetSessionID
    ).sort(),
    ["first", "second"],
  );
});

Deno.test("flush reports a queued durability failure even when the initiating callback cannot await it", async () => {
  class FailingStore extends MemoryStore {
    override async transact<T>(
      _mutation: (current: unknown) => HandoffStoreMutation<T>,
    ): Promise<T> {
      throw new Error("durability failed");
    }
  }
  const service = new HandoffContinuityService(new FailingStore(), () => 250);
  const publication = service.exportHandoff({
    targetDirectory: Deno.cwd(),
    targetSessionID: "session",
    receipts: [receipt("session")],
  });
  await assertRejects(() => publication, Error, "durability failed");
  await service.flush();
  service.queueHandoff({
    targetDirectory: Deno.cwd(),
    targetSessionID: "session",
    receipts: [receipt("session")],
  });
  await assertRejects(() => service.flush(), Error, "durability failed");
  await service.dispose();
});

Deno.test("handoff validation rejects cross-session, relative, oversized, and future schemas", async () => {
  const service = new HandoffContinuityService(new MemoryStore(), () => 300);
  await assertRejects(
    () =>
      service.exportHandoff({
        targetDirectory: Deno.cwd(),
        targetSessionID: "target",
        receipts: [receipt("other")],
      }),
    HandoffContinuityError,
    "different session",
  );
  await assertRejects(
    () =>
      service.exportHandoff({
        targetDirectory: "relative",
        targetSessionID: "target",
        receipts: [receipt("target")],
      }),
    HandoffContinuityError,
    "absolute",
  );
  await assertRejects(
    () =>
      service.exportHandoff({
        targetDirectory: Deno.cwd(),
        targetSessionID: "target",
        evidence: Array.from(
          { length: HANDOFF_CONTINUITY_LIMITS.evidencePerRecord + 1 },
          (_, index) => ({
            ...evidence("target", Deno.cwd()),
            id: `evidence:${index}`,
          }),
        ),
      }),
    HandoffContinuityError,
    "item limits",
  );
  await assertRejects(
    () =>
      new HandoffContinuityService(
        new MemoryStore({ version: 2, records: [] }),
        () => 300,
      ).importHandoff(Deno.cwd()),
    HandoffContinuityError,
    "unsupported schema",
  );
});

Deno.test("explicit tracking-only handoffs preserve an empty isolated session boundary", async () => {
  const store = new MemoryStore();
  const service = new HandoffContinuityService(store, () => 350);
  await assertRejects(
    () => service.exportHandoff({ targetDirectory: Deno.cwd(), targetSessionID: "empty" }),
    HandoffContinuityError,
    "must contain",
  );
  await service.exportHandoff({ targetDirectory: Deno.cwd(), targetSessionID: "empty", trackingOnly: true });
  const imported = await service.importHandoff(Deno.cwd(), "empty");
  assertEquals(imported.records.length, 1);
  assertEquals(imported.receipts, []);
  assertEquals(imported.evidence, []);
});

Deno.test("handoff registry evicts old records and rejects an oversized single record", async () => {
  const store = new MemoryStore();
  let now = 400;
  const service = new HandoffContinuityService(store, () => now++);
  for (let index = 0; index < HANDOFF_CONTINUITY_LIMITS.records + 2; index++) {
    await service.exportHandoff({
      targetDirectory: Deno.cwd(),
      targetSessionID: `session-${index}`,
      receipts: [receipt(`session-${index}`, `prompt-${index}`)],
    });
  }
  const records =
    (store.value as { records: Array<{ targetSessionID: string }> }).records;
  assertEquals(records.length, HANDOFF_CONTINUITY_LIMITS.records);
  assertEquals(
    records[0]?.targetSessionID,
    `session-${HANDOFF_CONTINUITY_LIMITS.records + 1}`,
  );
  assert(!records.some((record) => record.targetSessionID === "session-0"));

  const largeReceipts = Array.from({
    length: HANDOFF_CONTINUITY_LIMITS.receiptsPerRecord,
  }, (_, receiptIndex): ContextReceipt => ({
    id: `context:large-${receiptIndex}`,
    sessionID: "large-session",
    promptID: `large-${receiptIndex}`,
    admittedAt: receiptIndex,
    items: Array.from({ length: 30 }, (_, itemIndex) => ({
      id: `item-${itemIndex}`,
      kind: "attachment" as const,
      label: "x".repeat(1_024),
    })),
    truncation: "none",
  }));
  await assertRejects(
    () =>
      service.exportHandoff({
        targetDirectory: Deno.cwd(),
        targetSessionID: "large-session",
        receipts: largeReceipts,
      }),
    HandoffContinuityError,
    "record exceeds",
  );
});

Deno.test("handoff evidence keeps the newest bounded references and an explicit durable omission marker", async () => {
  const store = new MemoryStore();
  const service = new HandoffContinuityService(store, () => 450);
  const entries = Array.from({ length: 200 }, (_, index): EvidenceReference => ({
    ...evidence("session", Deno.cwd()),
    id: `evidence:${index}`,
    observedAt: index + 1,
    summary: `result ${index}`,
  }));
  await service.exportHandoff({ targetDirectory: Deno.cwd(), targetSessionID: "session", evidence: entries });
  await service.exportHandoff({
    targetDirectory: Deno.cwd(),
    targetSessionID: "session",
    evidence: [{ ...evidence("session", Deno.cwd()), id: "evidence:200", observedAt: 201, summary: "result 200" }],
  });
  const imported = await service.importHandoff(Deno.cwd(), "session");
  assertEquals(imported.evidence.length, 200);
  assertEquals(imported.evidence.some((entry) => entry.id === "evidence:0"), false);
  assertEquals(imported.evidence.some((entry) => entry.id === "evidence:200"), true);
  assertEquals(imported.evidence.some((entry) => entry.id.startsWith("continuity-evidence-limit:") && entry.status === "warning"), true);
});

Deno.test("expired and corrupt individual handoffs are ignored with an explicit limitation", async () => {
  const store = new MemoryStore();
  const service = new HandoffContinuityService(store, () => 1_000);
  await service.exportHandoff({
    targetDirectory: Deno.cwd(),
    targetSessionID: "session",
    receipts: [receipt("session")],
  });
  const registry = store.value as { records: unknown[] };
  registry.records.push({ id: "corrupt" });
  const imported = await new HandoffContinuityService(
    store,
    () => 1_000 + HANDOFF_CONTINUITY_LIMITS.ttlMilliseconds + 1,
  ).importHandoff(Deno.cwd());
  assertEquals(imported.records, []);
  assertEquals(imported.limitations, [
    "One invalid or expired handoff record was ignored.",
  ]);

  const corruptRoot = await new HandoffContinuityService(
    new MemoryStore(null),
    () => 1_000,
  ).importHandoff(Deno.cwd());
  assertEquals(corruptRoot.records, []);
  assertEquals(corruptRoot.limitations, [
    "Cross-workspace handoff metadata is not an object",
  ]);
});

Deno.test("Git common-directory store is private, atomic, and shared by concurrent worktree hosts", async () => {
  const temporaryRoot = await Deno.makeTempDir({
    prefix: "opencode-workbench-handoff-",
  });
  try {
    const commonDirectory = `${temporaryRoot}/common.git`;
    const firstTarget = `${temporaryRoot}/worktree-one`;
    const secondTarget = `${temporaryRoot}/worktree-two`;
    await Deno.mkdir(commonDirectory, { recursive: true, mode: 0o700 });
    await Deno.mkdir(firstTarget);
    await Deno.mkdir(secondTarget);
    class FakeGit implements GitRunner {
      calls: string[][] = [];
      async run(
        args: string[],
        cwd: string,
      ): Promise<{ stdout: string; stderr: string }> {
        this.calls.push([cwd, ...args]);
        return { stdout: `${commonDirectory}\n`, stderr: "" };
      }
    }
    const git = new FakeGit();
    const firstStore = await GitCommonDirectoryHandoffStore.create(
      git,
      firstTarget,
    );
    const secondStore = await GitCommonDirectoryHandoffStore.create(
      git,
      secondTarget,
    );
    assertEquals(firstStore.registryPath, secondStore.registryPath);
    assertEquals(git.calls[0]?.slice(1), [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    await Promise.all([
      new HandoffContinuityService(firstStore, () => 2_000).exportHandoff({
        targetDirectory: firstTarget,
        targetSessionID: "first",
        receipts: [receipt("first", "first")],
      }),
      new HandoffContinuityService(secondStore, () => 2_001).exportHandoff({
        targetDirectory: secondTarget,
        targetSessionID: "second",
        receipts: [receipt("second", "second")],
      }),
    ]);
    const registry = JSON.parse(
      await Deno.readTextFile(firstStore.registryPath),
    ) as { records: unknown[] };
    assertEquals(registry.records.length, 2);
    assertEquals(
      [...Deno.readDirSync(`${commonDirectory}/opencode-workbench`)].map((
        entry,
      ) => entry.name),
      ["handoff-continuity-v1.json"],
    );
    if (Deno.build.os !== "windows") {
      assertEquals(
        (await Deno.stat(`${commonDirectory}/opencode-workbench`)).mode! &
          0o777,
        0o700,
      );
      assertEquals(
        (await Deno.stat(firstStore.registryPath)).mode! & 0o777,
        0o600,
      );
    }
    assertEquals(
      (await new HandoffContinuityService(firstStore, () => 2_002)
        .importHandoff(firstTarget)).receipts[0]?.sessionID,
      "first",
    );
  } finally {
    await Deno.remove(temporaryRoot, { recursive: true });
  }
});

Deno.test("Git common-directory store rejects metadata-directory symlink escapes", async () => {
  if (Deno.build.os === "windows") return;
  const temporaryRoot = await Deno.makeTempDir({
    prefix: "opencode-workbench-handoff-symlink-",
  });
  try {
    const commonDirectory = `${temporaryRoot}/common.git`;
    const outside = `${temporaryRoot}/outside`;
    const target = `${temporaryRoot}/worktree`;
    await Deno.mkdir(commonDirectory, { mode: 0o700 });
    await Deno.mkdir(outside, { mode: 0o700 });
    await Deno.mkdir(target);
    await Deno.symlink(outside, `${commonDirectory}/opencode-workbench`);
    const git: GitRunner = {
      run: async () => ({ stdout: `${commonDirectory}\n`, stderr: "" }),
    };
    const store = await GitCommonDirectoryHandoffStore.create(git, target);
    await assertRejects(
      () =>
        new HandoffContinuityService(store, () => 3_000).exportHandoff({
          targetDirectory: target,
          targetSessionID: "session",
          receipts: [receipt("session")],
        }),
      HandoffContinuityError,
      "not a directory",
    );
    assertEquals([...Deno.readDirSync(outside)], []);
  } finally {
    await Deno.remove(temporaryRoot, { recursive: true });
  }
});
