import { assertEquals, assertThrows } from "jsr:@std/assert"
import {
  clampSplitPaneWidth,
  SplitPaneController,
  splitPaneWidthForKey,
  type SplitPaneResizeObserver,
} from "../src/webview/controllers/split-pane-controller.ts"

type Listener = (event: Record<string, unknown>) => void

class FakeStyle {
  readonly values = new Map<string, string>()
  setProperty(name: string, value: string): void { this.values.set(name, value) }
}

class FakeElement {
  readonly style = new FakeStyle()
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Set<Listener>>()
  readonly captures = new Set<number>()
  tabIndex = -1

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(name: string, listener: Listener): void {
    const values = this.listeners.get(name) ?? new Set<Listener>()
    values.add(listener)
    this.listeners.set(name, values)
  }
  removeEventListener(name: string, listener: Listener): void { this.listeners.get(name)?.delete(listener) }
  setPointerCapture(id: number): void { this.captures.add(id) }
  hasPointerCapture(id: number): boolean { return this.captures.has(id) }
  releasePointerCapture(id: number): void { this.captures.delete(id) }
  dispatch(name: string, values: Record<string, unknown> = {}): { prevented: boolean } {
    let prevented = false
    const event = { ...values, preventDefault: () => { prevented = true } }
    for (const listener of this.listeners.get(name) ?? []) listener(event)
    return { prevented }
  }
}

Deno.test("split pane helpers clamp dynamic bounds and map keys by controlled edge", () => {
  assertEquals(clampSplitPaneWidth(50, { minimum: 100, maximum: 500 }), 100)
  assertEquals(clampSplitPaneWidth(600, { minimum: 100, maximum: 500 }), 500)
  assertEquals(clampSplitPaneWidth(400, { minimum: 100, maximum: 500, available: 320 }), 320)
  assertEquals(clampSplitPaneWidth(Number.NaN, { minimum: 100, maximum: 500 }), 100)

  const bounds = { minimum: 200, maximum: 500 }
  assertEquals(splitPaneWidthForKey("ArrowLeft", 300, bounds, "right", 20), 320)
  assertEquals(splitPaneWidthForKey("ArrowRight", 300, bounds, "right", 20), 280)
  assertEquals(splitPaneWidthForKey("ArrowLeft", 300, bounds, "left", 20), 280)
  assertEquals(splitPaneWidthForKey("ArrowRight", 300, bounds, "left", 20), 320)
  assertEquals(splitPaneWidthForKey("Home", 300, bounds), 200)
  assertEquals(splitPaneWidthForKey("End", 300, { ...bounds, available: 420 }), 420)
  assertEquals(splitPaneWidthForKey("Enter", 300, bounds), undefined)
})

Deno.test("split pane controller synchronizes CSS, ARIA, keyboard, pointer, and persistence", () => {
  const root = new FakeElement()
  const separator = new FakeElement()
  const persisted: Array<Record<string, number>> = []
  let available = 440
  let resizeCallback: (() => void) | undefined
  let disconnected = false
  const observer: SplitPaneResizeObserver = {
    observe: () => undefined,
    disconnect: () => { disconnected = true },
  }
  const controller = new SplitPaneController({
    root: root as unknown as HTMLElement,
    panes: [{
      key: "artifacts",
      separator: separator as unknown as HTMLElement,
      cssProperty: "--artifact-width",
      initialWidth: 380,
      minimumWidth: 280,
      maximumWidth: 620,
      availableWidth: () => available,
      edge: "right",
      step: 20,
    }],
    persist: (layout) => persisted.push({ ...layout }),
    createResizeObserver: (callback) => {
      resizeCallback = callback
      return observer
    },
  })

  assertEquals(root.style.values.get("--artifact-width"), "380px")
  assertEquals(separator.attributes.get("role"), "separator")
  assertEquals(separator.attributes.get("aria-orientation"), "vertical")
  assertEquals(separator.attributes.get("aria-valuemin"), "280")
  assertEquals(separator.attributes.get("aria-valuemax"), "440")
  assertEquals(separator.attributes.get("aria-valuenow"), "380")
  assertEquals(separator.tabIndex, 0)

  assertEquals(separator.dispatch("keydown", { key: "ArrowLeft" }).prevented, true)
  assertEquals(controller.layout, { artifacts: 400 })
  assertEquals(root.style.values.get("--artifact-width"), "400px")
  assertEquals(persisted.at(-1), { artifacts: 400 })

  separator.dispatch("pointerdown", { button: 0, pointerId: 7, clientX: 500 })
  separator.dispatch("pointermove", { pointerId: 7, clientX: 450 })
  assertEquals(controller.layout, { artifacts: 440 })
  assertEquals(separator.attributes.get("aria-valuenow"), "440")
  const beforeCommit = persisted.length
  separator.dispatch("pointerup", { pointerId: 7, clientX: 450 })
  assertEquals(persisted.length, beforeCommit + 1)

  available = 330
  resizeCallback?.()
  assertEquals(controller.layout, { artifacts: 330 })
  assertEquals(root.style.values.get("--artifact-width"), "330px")
  assertEquals(separator.attributes.get("aria-valuemax"), "330")

  controller.dispose()
  assertEquals(disconnected, true)
  assertEquals(separator.listeners.get("keydown")?.size, 0)
})

Deno.test("split pane controller remains usable without ResizeObserver and rejects duplicate keys", () => {
  const root = new FakeElement()
  const first = new FakeElement()
  const controller = new SplitPaneController({
    root: root as unknown as HTMLElement,
    panes: [{ key: "sessions", separator: first as unknown as HTMLElement, cssProperty: "--sessions-width", initialWidth: 300, minimumWidth: 220, maximumWidth: 420 }],
    createResizeObserver: () => undefined,
  })
  assertEquals(controller.setWidth("sessions", 500), 420)
  controller.dispose()

  assertThrows(() => new SplitPaneController({
    root: root as unknown as HTMLElement,
    panes: [
      { key: "same", separator: first as unknown as HTMLElement, cssProperty: "--one", initialWidth: 1, minimumWidth: 1, maximumWidth: 2 },
      { key: "same", separator: new FakeElement() as unknown as HTMLElement, cssProperty: "--two", initialWidth: 1, minimumWidth: 1, maximumWidth: 2 },
    ],
    createResizeObserver: () => ({ observe: () => undefined, disconnect: () => undefined }),
  }), Error, "Duplicate split pane")
})
