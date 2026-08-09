import { assertEquals } from "jsr:@std/assert"
import { nextMenuIndex } from "../src/webview/controllers/menu-navigation.ts"

Deno.test("menu navigation starts at an edge and wraps deterministically", () => {
  assertEquals(nextMenuIndex("ArrowDown", -1, 3), 0)
  assertEquals(nextMenuIndex("ArrowUp", -1, 3), 2)
  assertEquals(nextMenuIndex("ArrowDown", 2, 3), 0)
  assertEquals(nextMenuIndex("ArrowUp", 0, 3), 2)
})

Deno.test("menu navigation honors Home and End and ignores empty menus", () => {
  assertEquals(nextMenuIndex("Home", 1, 3), 0)
  assertEquals(nextMenuIndex("End", 1, 3), 2)
  assertEquals(nextMenuIndex("ArrowDown", 0, 0), undefined)
})
