import { assertEquals, assertMatch, assertRejects, assertThrows } from "jsr:@std/assert";
import { DiffService, parseGitNumstatZ } from "../src/application/diff-service.ts";
import { EvidenceService } from "../src/application/evidence-service.ts";
import { TypedGitRunner } from "../src/application/worktree-service.ts";

Deno.test("diff identity hashes exact bytes and resolves file hunks", async () => {
  const unified =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n";
  const git = {
    run: async (args: string[]) => ({
      stdout: args[0] === "ls-files"
        ? ""
        : args.includes("--numstat")
        ? "1\t1\tsrc/a.ts\0"
        : unified,
      stderr: "",
    }),
  };
  const capture = await new DiffService(git).capture({
    repository: "/repo",
    scope: "turn",
    baseRef: "HEAD",
    baselineClean: true,
  });
  assertMatch(capture.snapshot.unifiedDiffHash, /^sha256:[0-9a-f]{64}$/);
  assertEquals(capture.snapshot.files[0]?.hunks?.[0]?.newRange, {
    start: 1,
    end: 3,
  });
});

Deno.test("turn attribution and oversized diffs fail visibly rather than silently truncating", async () => {
  const git = {
    run: async (args: string[]) => ({
      stdout: args[0] === "ls-files"
        ? ""
        : args.includes("--numstat")
        ? "1\t0\ta\0"
        : "large",
      stderr: "",
    }),
  };
  const snapshot = (await new DiffService(git, 2).capture({
    repository: "/repo",
    scope: "turn",
    baselineClean: false,
  })).snapshot;
  assertEquals(snapshot.complete, false);
  assertMatch(snapshot.truncationReason!, /verified clean baseline/);
  const evidence = new EvidenceService().recordDiff(snapshot);
  assertEquals(evidence.status, "warning");
  assertMatch(evidence.summary, /incomplete/);
});

Deno.test("NUL-delimited numstat preserves tabs, newlines, and rename paths", () => {
  assertEquals(parseGitNumstatZ("2\t1\tplain\tname.ts\0-\t-\t\0old\tname.bin\0new\nname.bin\0"), [{
    path: "plain\tname.ts",
    additions: 2,
    deletions: 1,
    binary: false,
    hunks: [],
  }, {
    path: "new\nname.bin",
    previousPath: "old\tname.bin",
    additions: 0,
    deletions: 0,
    binary: true,
    hunks: [],
  }]);
  assertThrows(() => parseGitNumstatZ("1\t0\tunterminated"), Error, "unterminated");
});

async function temporaryGitRepository(): Promise<{ git: TypedGitRunner; repository: string }> {
  const repository = await Deno.makeTempDir({ prefix: "opencode-workbench-diff-" });
  const git = new TypedGitRunner();
  await git.run(["init", "--quiet"], repository);
  await git.run(["config", "user.name", "OpenCode Workbench Test"], repository);
  await git.run(["config", "user.email", "workbench@example.invalid"], repository);
  return { git, repository };
}

Deno.test({
  name: "real Git diff preserves special rename paths and associates their hunks",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { git, repository } = await temporaryGitRepository();
    try {
      const previousPath = "old\tname.ts";
      const currentPath = "new\nname.ts";
      const original = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n") + "\n";
      await Deno.writeTextFile(`${repository}/${previousPath}`, original);
      await git.run(["add", "--", previousPath], repository);
      await git.run(["commit", "--quiet", "-m", "initial"], repository);
      await Deno.rename(`${repository}/${previousPath}`, `${repository}/${currentPath}`);
      await Deno.writeTextFile(`${repository}/${currentPath}`, original.replace("line 20", "changed 20"));
      await git.run(["add", "-A"], repository);

      const capture = await new DiffService(git).capture({ repository, scope: "session", baseRef: "HEAD" });
      assertEquals(capture.snapshot.complete, true);
      assertEquals(capture.snapshot.files.length, 1);
      assertEquals(capture.snapshot.files[0]?.path, currentPath);
      assertEquals(capture.snapshot.files[0]?.previousPath, previousPath);
      assertEquals(capture.snapshot.files[0]?.additions, 1);
      assertEquals(capture.snapshot.files[0]?.deletions, 1);
      assertEquals(capture.snapshot.files[0]?.hunks?.length, 1);
    } finally {
      await Deno.remove(repository, { recursive: true });
    }
  },
});

Deno.test("turn baseline retains commits created after prompt admission", async () => {
  const { git, repository } = await temporaryGitRepository();
  try {
    await Deno.writeTextFile(`${repository}/tracked.ts`, "before\n");
    await git.run(["add", "--", "tracked.ts"], repository);
    await git.run(["commit", "--quiet", "-m", "initial"], repository);
    const service = new DiffService(git);
    const baseline = await service.captureTurnBaseline(repository);
    assertEquals(baseline.clean, true);

    await Deno.writeTextFile(`${repository}/tracked.ts`, "after\n");
    await git.run(["add", "--", "tracked.ts"], repository);
    await git.run(["commit", "--quiet", "-m", "during turn"], repository);
    const capture = await service.capture({ repository, scope: "turn", baseRef: baseline.headRef, baselineClean: baseline.clean });
    assertEquals(capture.snapshot.complete, true);
    assertEquals(capture.snapshot.files.map((file) => file.path), ["tracked.ts"]);
    assertMatch(capture.unifiedDiff, /\+after/);
  } finally {
    await Deno.remove(repository, { recursive: true });
  }
});

Deno.test("native diff text reads surface Git errors and enforce byte bounds", async () => {
  const failure = new Error("arbitrary git show failure");
  const service = new DiffService({ run: async () => { throw failure; } });
  await assertRejects(() => service.readRevisionText("/repo", "HEAD", "missing.ts"), Error, "arbitrary git show failure");

  const directory = await Deno.makeTempDir({ prefix: "opencode-workbench-diff-read-" });
  try {
    const file = `${directory}/bounded.txt`;
    await Deno.writeTextFile(file, "12345");
    assertEquals(await service.readWorkingTreeText(file, 5), "12345");
    await assertRejects(() => service.readWorkingTreeText(file, 4), Error, "exceeds 4 bytes");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("evidence remains scoped to its session and repository", () => {
  const service = new EvidenceService();
  service.record({
    kind: "test",
    label: "Session A",
    status: "passed",
    summary: "passed",
    sessionID: "a",
    repository: "/repo",
  });
  service.record({
    kind: "test",
    label: "Session B",
    status: "failed",
    summary: "failed",
    sessionID: "b",
    repository: "/repo",
  });
  assertEquals(
    service.list({ sessionID: "a", repository: "/repo" }).map((entry) =>
      entry.label
    ),
    ["Session A"],
  );
  assertEquals(service.list({ sessionID: "missing" }), []);
  assertThrows(
    () =>
      service.record({
        kind: "task",
        label: "Too wide",
        status: "unknown",
        summary: "bounded",
        sessionID: "x".repeat(1_025),
      }),
    Error,
    "Session ID",
  );
});

Deno.test("evidence references survive reload and corrupt persisted entries are ignored", () => {
  let persisted = [] as ReturnType<EvidenceService["list"]>;
  const first = new EvidenceService([], (entries) => {
    persisted = entries;
  }, 2);
  const original = first.record({
    kind: "test",
    label: "Synthetic suite",
    status: "passed",
    summary: "341 passed",
    sessionID: "session",
    repository: "/repo",
    observedAt: 5,
  });
  first.record({
    kind: "diagnostics",
    label: "Diagnostics",
    status: "passed",
    summary: "No errors",
    sessionID: "session",
    repository: "/repo",
    observedAt: 6,
  });
  const restored = new EvidenceService([
    ...persisted,
    { ...original, id: "", summary: "corrupt" },
  ]);
  assertEquals(
    restored.list({ sessionID: "session" }).map((entry) => entry.id),
    persisted.map((entry) => entry.id),
  );
  assertEquals(restored.list({ sessionID: "session" })[0]?.id, original.id);
});

Deno.test("imported evidence keeps its identity and rejects conflicting metadata", () => {
  let persisted = 0;
  const service = new EvidenceService([], () => persisted++);
  const reference = {
    id: "evidence:imported",
    kind: "test" as const,
    label: "Imported test",
    status: "passed" as const,
    observedAt: 5,
    sessionID: "session",
    repository: "/repo",
    summary: "12 passed",
  };
  const imported = service.merge([reference]);
  assertEquals(imported.length, 1);
  assertEquals(imported[0]?.id, reference.id);
  assertEquals(imported[0]?.summary, reference.summary);
  assertEquals(service.merge([reference]), []);
  assertEquals(persisted, 1);
  imported[0]!.summary = "mutated";
  assertEquals(service.list()[0]?.summary, "12 passed");
  assertThrows(
    () => service.merge([{ ...reference, status: "failed" }]),
    Error,
    "conflicts",
  );
});

Deno.test("durable evidence redacts human text and rejects credential-shaped identity fields", () => {
  const entry = new EvidenceService().record({
    kind: "task",
    label: "Authorization: Bearer task-secret",
    status: "failed",
    summary: "token=summary-secret at https://user:password@example.test/result",
    sessionID: "session",
    repository: "/repo",
  });
  assertEquals(JSON.stringify(entry).includes("task-secret"), false);
  assertEquals(JSON.stringify(entry).includes("summary-secret"), false);
  assertEquals(JSON.stringify(entry).includes("user:password"), false);
  assertThrows(
    () =>
      new EvidenceService().record({
        kind: "task",
        label: "Task",
        status: "unknown",
        summary: "Not run",
        sessionID: "access_token=identity-secret",
      }),
    Error,
    "credential-shaped",
  );
});

Deno.test("session diff includes untracked files in exact identity and summaries", async () => {
  const patch =
    "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n";
  const git = {
    run: async (args: string[]) => {
      if (args[0] === "ls-files") return { stdout: "new.ts\0", stderr: "" };
      if (args.includes("--no-index") && args.includes("--numstat")) {
        return {
          stdout: "1\t0\t\0/dev/null\0new.ts\0",
          stderr: "",
        };
      }
      if (args.includes("--no-index")) return { stdout: patch, stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  const capture = await new DiffService(git).capture({
    repository: "/repo",
    scope: "session",
    baseRef: "HEAD",
  });
  assertEquals(capture.snapshot.complete, true);
  assertEquals(capture.snapshot.files, [{
    path: "new.ts",
    additions: 1,
    deletions: 0,
    binary: false,
    hunks: [{
      header: "@@ -0,0 +1 @@",
      oldRange: { start: 0, end: -1 },
      newRange: { start: 1, end: 1 },
    }],
  }]);
  assertEquals(capture.unifiedDiff, patch);
});

Deno.test("untracked diff capture stops at explicit byte and file limits", async () => {
  const calls: string[][] = [];
  const patch =
    "diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n";
  const git = {
    run: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "ls-files") {
        return {
          stdout: `${
            Array.from({ length: 1_001 }, (_, index) => `new-${index}.ts`).join(
              "\0",
            )
          }\0`,
          stderr: "",
        };
      }
      if (args.includes("--no-index") && args.includes("--numstat")) {
        return {
          stdout: "1\t0\t\0/dev/null\0new.ts\0",
          stderr: "",
        };
      }
      if (args.includes("--no-index")) return { stdout: patch, stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  const byteLimited = await new DiffService(git, patch.length - 1).capture({
    repository: "/repo",
    scope: "session",
    baseRef: "HEAD",
  });
  assertEquals(byteLimited.snapshot.complete, false);
  assertMatch(byteLimited.snapshot.truncationReason!, /byte limit/);
  assertEquals(byteLimited.unifiedDiff, "");

  calls.length = 0;
  const fileLimited = await new DiffService(git, patch.length * 1_100).capture({
    repository: "/repo",
    scope: "session",
    baseRef: "HEAD",
  });
  assertEquals(fileLimited.snapshot.complete, false);
  assertMatch(fileLimited.snapshot.truncationReason!, /1000-file/);
  assertEquals(
    calls.filter((args) =>
      args.includes("--no-index") && !args.includes("--numstat")
    ).length,
    1_000,
  );
});
