import { assertEquals } from "jsr:@std/assert"
import { type ScrollAnchor, ScrollController } from "../src/webview/controllers/scroll-controller.ts"

interface FakeNode {
  dataset: { messageId?: string }
  isConnected: boolean
  getBoundingClientRect(): { top: number }
}

function anchor(node: FakeNode, overrides: Partial<ScrollAnchor> = {}): ScrollAnchor {
  return {
    node: node as unknown as HTMLElement,
    viewportTop: 120,
    scrollTop: 100,
    scrollHeight: 1_000,
    messageID: node.dataset.messageId,
    ...overrides,
  }
}

Deno.test("prepend restoration follows a stable message identity when its turn node is replaced", () => {
  const original: FakeNode = {
    dataset: { messageId: "boundary-message" },
    isConnected: false,
    getBoundingClientRect: () => ({ top: 120 }),
  }
  const replacement: FakeNode = {
    dataset: { messageId: "boundary-message" },
    isConnected: true,
    getBoundingClientRect: () => ({ top: 520 }),
  }
  const container = {
    scrollTop: 100,
    scrollHeight: 1_500,
    clientHeight: 600,
    querySelectorAll: () => [replacement],
  }

  new ScrollController(container as unknown as HTMLElement).restorePrependAnchor(anchor(original))

  assertEquals(container.scrollTop, 500)
})

Deno.test("prepend restoration falls back to the added scroll height when no anchor node survives", () => {
  const original: FakeNode = { dataset: {}, isConnected: false, getBoundingClientRect: () => ({ top: 120 }) }
  const container = {
    scrollTop: 100,
    scrollHeight: 1_500,
    clientHeight: 600,
    querySelectorAll: () => [],
  }

  new ScrollController(container as unknown as HTMLElement).restorePrependAnchor(anchor(original))

  assertEquals(container.scrollTop, 600)
})

Deno.test("latest following survives layout growth until the user scrolls away", () => {
  const container = { scrollTop: 400, scrollHeight: 1_000, clientHeight: 600 }
  const controller = new ScrollController(container as unknown as HTMLElement)

  controller.latest()
  container.scrollHeight = 1_400
  assertEquals(controller.maintainLatest(), true)
  assertEquals(container.scrollTop, 1_400)

  container.scrollTop = 300
  assertEquals(controller.observeScroll(), false)
  container.scrollHeight = 1_800
  assertEquals(controller.maintainLatest(), false)
  assertEquals(container.scrollTop, 300)
})

Deno.test("restored viewport controls whether later layout changes follow latest", () => {
  const container = { scrollTop: 0, scrollHeight: 1_000, clientHeight: 600 }
  const controller = new ScrollController(container as unknown as HTMLElement)

  controller.restoreViewport({ atBottom: false, scrollTop: 125 })
  container.scrollHeight = 1_200
  assertEquals(controller.maintainLatest(), false)
  assertEquals(container.scrollTop, 125)

  controller.restoreViewport({ atBottom: true, scrollTop: 0 })
  container.scrollHeight = 1_500
  assertEquals(controller.maintainLatest(), true)
  assertEquals(container.scrollTop, 1_500)
})
