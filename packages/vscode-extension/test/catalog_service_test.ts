import { assertEquals, assertThrows } from "jsr:@std/assert"
import { CatalogService } from "../src/application/catalog-service.ts"

Deno.test("catalog service owns defaults and validated composer preferences", () => {
  const service = new CatalogService({ currentAgent: "build", lastModel: "p/m", modelVariants: [["p/m", "high"]] })
  service.apply({ agents: [{ name: "build" }], models: [{ id: "m", name: "Model", providerID: "p", capabilities: { reasoning: true, input: { text: true, image: false } }, variants: ["high"] }], defaults: { agent: "build", model: "p/m" } }, [])
  assertEquals(service.modelForAgent("build"), "p/m")
  assertEquals(service.remember("build", "p/m", "high"), false)
  assertThrows(() => service.validate("build", "p/m", "unknown"))
})
