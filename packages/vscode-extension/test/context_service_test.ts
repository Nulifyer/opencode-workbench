import { assertEquals, assertThrows } from "jsr:@std/assert";
import { ContextReceiptService } from "../src/application/context-service.ts";

Deno.test("context receipt commits only after authoritative prompt admission", () => {
  let persisted = 0;
  const service = new ContextReceiptService([], () => persisted++);
  service.stage("session", "prompt", [{
    id: "item",
    kind: "selection",
    label: "main.ts:1",
    contentHash: "sha256:test",
    bytes: 10,
  }], "none");
  assertEquals(service.forSession("session"), []);
  assertEquals(service.admit("other", "prompt", 5), undefined);
  const receipt = service.admit("session", "prompt", 5);
  assertEquals(receipt?.id, "context:prompt");
  assertEquals(service.forSession("session").length, 1);
  assertEquals(persisted, 1);
});

Deno.test("rejected prompt admission does not create a receipt", () => {
  const service = new ContextReceiptService();
  service.stage("session", "prompt", [], "none");
  service.reject("prompt");
  assertEquals(service.admit("session", "prompt"), undefined);
});

Deno.test("imported receipts are idempotent, conflict checked, and clone safe", () => {
  let persisted = 0;
  const service = new ContextReceiptService([], () => persisted++);
  const receipt = {
    id: "context:imported",
    sessionID: "session",
    promptID: "imported",
    admittedAt: 5,
    items: [{
      id: "item",
      kind: "file" as const,
      label: "src/main.ts",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    }],
    truncation: "none" as const,
  };
  const imported = service.merge([receipt]);
  assertEquals(imported.length, 1);
  assertEquals(service.merge([receipt]), []);
  assertEquals(persisted, 1);

  imported[0]!.items[0]!.label = "mutated";
  imported[0]!.items[0]!.range!.startLine = 99;
  const fetched = service.get(receipt.id)!;
  assertEquals(fetched.items[0]?.label, "src/main.ts");
  assertEquals(fetched.items[0]?.range?.startLine, 1);
  fetched.items[0]!.label = "also mutated";
  assertEquals(
    service.forSession("session")[0]?.items[0]?.label,
    "src/main.ts",
  );
  assertThrows(
    () => service.merge([{ ...receipt, admittedAt: 6 }]),
    Error,
    "conflicts",
  );
});
