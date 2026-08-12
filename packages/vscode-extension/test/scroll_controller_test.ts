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
