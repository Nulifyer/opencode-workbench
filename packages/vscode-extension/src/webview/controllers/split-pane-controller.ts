/// <reference lib="dom" />

export type SplitPaneEdge = "left" | "right"

export interface SplitPaneBounds {
  minimum: number
  maximum: number
  /** Optional dynamic ceiling, normally derived from the current container. */
  available?: number
}

export interface SplitPaneDefinition {
  key: string
  separator: HTMLElement
  cssProperty: `--${string}`
  initialWidth: number
  minimumWidth: number
  maximumWidth: number
  /**
   * Returns the largest width that the surrounding layout can currently
   * afford. The fixed maximum still applies.
   */
  availableWidth?: () => number
  /** The pane controlled by the separator. Editor-side panes sit right of it. */
  edge?: SplitPaneEdge
  step?: number
}

export interface SplitPaneResizeObserver {
  observe(target: Element): void
  disconnect(): void
}

export interface SplitPaneControllerOptions {
  root: HTMLElement
  panes: readonly SplitPaneDefinition[]
  persist?: (widths: Readonly<Record<string, number>>) => void
  /** Injectable for tests and runtimes that do not expose ResizeObserver. */
  createResizeObserver?: (callback: () => void) => SplitPaneResizeObserver | undefined
  /** Injectable frame hooks keep pointer-driven layout writes deterministic in tests. */
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
}

interface ActivePointer {
  id: number
  key: string
  startX: number
  startWidth: number
}

const DEFAULT_STEP = 16

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/** Clamps a pane width to its fixed bounds and its current layout allowance. */
export function clampSplitPaneWidth(width: number, bounds: SplitPaneBounds): number {
  const minimum = Math.max(0, finite(bounds.minimum, 0))
  const configuredMaximum = Math.max(minimum, finite(bounds.maximum, minimum))
  const available = bounds.available === undefined
    ? configuredMaximum
    : Math.max(minimum, finite(bounds.available, minimum))
  const maximum = Math.min(configuredMaximum, available)
  return Math.round(Math.min(maximum, Math.max(minimum, finite(width, minimum))))
}

/**
 * Returns the width produced by an accessible separator key, or `undefined`
 * when the key should remain available to the browser/host.
 */
export function splitPaneWidthForKey(
  key: string,
  current: number,
  bounds: SplitPaneBounds,
  edge: SplitPaneEdge = "right",
  step = DEFAULT_STEP,
): number | undefined {
  const amount = Math.max(1, Math.round(finite(step, DEFAULT_STEP)))
  if (key === "Home") return clampSplitPaneWidth(bounds.minimum, bounds)
  if (key === "End") return clampSplitPaneWidth(bounds.maximum, bounds)
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined
  const grows = edge === "right" ? key === "ArrowLeft" : key === "ArrowRight"
  return clampSplitPaneWidth(current + (grows ? amount : -amount), bounds)
}

function defaultResizeObserver(callback: () => void): SplitPaneResizeObserver | undefined {
  const constructor = globalThis.ResizeObserver
  return typeof constructor === "function" ? new constructor(callback) : undefined
}

/**
 * Owns pointer and keyboard resizing for one or more vertical split panes.
 * It intentionally persists only numeric presentation state.
 */
export class SplitPaneController {
  private readonly definitions = new Map<string, SplitPaneDefinition>()
  /** User-selected widths. These survive temporary layout constraints. */
  private readonly widths: Record<string, number> = Object.create(null) as Record<string, number>
  /** Widths currently rendered after applying the available-space ceiling. */
  private readonly renderedWidths: Record<string, number> = Object.create(null) as Record<string, number>
  private readonly disposers: Array<() => void> = []
  private readonly observer?: SplitPaneResizeObserver
  private active?: ActivePointer
  private pendingPointerWidth?: number
  private pointerFrame?: number
  private pointerFramePending = false
  private disposed = false

  constructor(private readonly options: SplitPaneControllerOptions) {
    for (const definition of options.panes) {
      if (!definition.key || this.definitions.has(definition.key)) {
        throw new Error(`Duplicate split pane: ${definition.key || "<empty>"}`)
      }
      if (!definition.cssProperty.startsWith("--")) {
        throw new Error(`Split pane ${definition.key} requires a CSS custom property`)
      }
      this.definitions.set(definition.key, definition)
      this.widths[definition.key] = clampSplitPaneWidth(definition.initialWidth, {
        minimum: definition.minimumWidth,
        maximum: definition.maximumWidth,
      })
      this.renderedWidths[definition.key] = this.clamp(definition, this.widths[definition.key]!)
      this.bind(definition)
      this.apply(definition)
    }
    const factory = options.createResizeObserver ?? defaultResizeObserver
    this.observer = factory(() => this.reconcile())
    this.observer?.observe(options.root)
  }

  get layout(): Readonly<Record<string, number>> {
    return { ...this.widths }
  }

  setWidth(key: string, width: number, persist = true): number {
    const definition = this.require(key)
    const next = this.clamp(definition, width)
    if (next !== this.widths[key]) {
      this.widths[key] = next
      this.renderedWidths[key] = next
      this.apply(definition)
      if (persist) this.persist()
    }
    return next
  }

  reconcile(): void {
    if (this.disposed) return
    for (const definition of this.definitions.values()) {
      const next = this.clamp(definition, this.widths[definition.key]!)
      if (this.renderedWidths[definition.key] === next) {
        this.syncAria(definition)
        continue
      }
      this.renderedWidths[definition.key] = next
      this.apply(definition)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.cancelPointerFrame()
    this.disposed = true
    this.active = undefined
    this.observer?.disconnect()
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  private bind(definition: SplitPaneDefinition): void {
    const pointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || this.disposed) return
      event.preventDefault()
      this.active = {
        id: event.pointerId,
        key: definition.key,
        startX: event.clientX,
        startWidth: this.renderedWidths[definition.key]!,
      }
      definition.separator.setPointerCapture?.(event.pointerId)
    }
    const pointerMove = (event: PointerEvent): void => {
      const active = this.active
      if (!active || active.id !== event.pointerId || active.key !== definition.key || this.disposed) return
      event.preventDefault()
      const delta = event.clientX - active.startX
      const direction = (definition.edge ?? "right") === "right" ? -1 : 1
      this.schedulePointerWidth(active.startWidth + delta * direction)
    }
    const finishPointer = (event: PointerEvent): void => {
      if (!this.active || this.active.id !== event.pointerId || this.active.key !== definition.key) return
      this.flushPointerWidth(true)
      this.active = undefined
      if (definition.separator.hasPointerCapture?.(event.pointerId)) {
        definition.separator.releasePointerCapture?.(event.pointerId)
      }
      this.persist()
    }
    const keyDown = (event: KeyboardEvent): void => {
      const next = splitPaneWidthForKey(
        event.key,
        this.renderedWidths[definition.key]!,
        this.bounds(definition),
        definition.edge,
        definition.step,
      )
      if (next === undefined) return
      event.preventDefault()
      this.setWidth(definition.key, next)
    }
    const doubleClick = (): void => {
      this.setWidth(definition.key, definition.initialWidth)
    }

    definition.separator.addEventListener("pointerdown", pointerDown)
    definition.separator.addEventListener("pointermove", pointerMove)
    definition.separator.addEventListener("pointerup", finishPointer)
    definition.separator.addEventListener("pointercancel", finishPointer)
    definition.separator.addEventListener("lostpointercapture", finishPointer)
    definition.separator.addEventListener("keydown", keyDown)
    definition.separator.addEventListener("dblclick", doubleClick)
    this.disposers.push(() => {
      definition.separator.removeEventListener("pointerdown", pointerDown)
      definition.separator.removeEventListener("pointermove", pointerMove)
      definition.separator.removeEventListener("pointerup", finishPointer)
      definition.separator.removeEventListener("pointercancel", finishPointer)
      definition.separator.removeEventListener("lostpointercapture", finishPointer)
      definition.separator.removeEventListener("keydown", keyDown)
      definition.separator.removeEventListener("dblclick", doubleClick)
    })
  }

  private schedulePointerWidth(width: number): void {
    this.pendingPointerWidth = width
    if (this.pointerFramePending) return
    const request = this.options.requestFrame ?? globalThis.requestAnimationFrame?.bind(globalThis)
    if (!request) {
      this.flushPointerWidth()
      return
    }
    this.pointerFramePending = true
    this.pointerFrame = request(() => this.flushPointerWidth())
  }

  private flushPointerWidth(cancelScheduled = false): void {
    if (cancelScheduled && this.pointerFrame !== undefined) {
      const cancel = this.options.cancelFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis)
      cancel?.(this.pointerFrame)
    }
    this.pointerFramePending = false
    this.pointerFrame = undefined
    const width = this.pendingPointerWidth
    this.pendingPointerWidth = undefined
    const active = this.active
    if (width !== undefined && active && !this.disposed) this.setWidth(active.key, width, false)
  }

  private cancelPointerFrame(): void {
    if (this.pointerFrame !== undefined) {
      const cancel = this.options.cancelFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis)
      cancel?.(this.pointerFrame)
    }
    this.pointerFrame = undefined
    this.pointerFramePending = false
    this.pendingPointerWidth = undefined
  }

  private bounds(definition: SplitPaneDefinition): SplitPaneBounds {
    return {
      minimum: definition.minimumWidth,
      maximum: definition.maximumWidth,
      available: definition.availableWidth?.(),
    }
  }

  private clamp(definition: SplitPaneDefinition, width: number): number {
    return clampSplitPaneWidth(width, this.bounds(definition))
  }

  private apply(definition: SplitPaneDefinition): void {
    const width = this.renderedWidths[definition.key]!
    this.options.root.style.setProperty(definition.cssProperty, `${width}px`)
    this.syncAria(definition)
  }

  private syncAria(definition: SplitPaneDefinition): void {
    const bounds = this.bounds(definition)
    const minimum = clampSplitPaneWidth(bounds.minimum, bounds)
    const maximum = clampSplitPaneWidth(bounds.maximum, bounds)
    const current = this.renderedWidths[definition.key]!
    definition.separator.setAttribute("role", "separator")
    definition.separator.setAttribute("aria-orientation", "vertical")
    definition.separator.setAttribute("aria-valuemin", String(minimum))
    definition.separator.setAttribute("aria-valuemax", String(maximum))
    definition.separator.setAttribute("aria-valuenow", String(current))
    definition.separator.setAttribute("aria-valuetext", `${current} pixels`)
    if (definition.separator.tabIndex < 0) definition.separator.tabIndex = 0
  }

  private persist(): void {
    this.options.persist?.(this.layout)
  }

  private require(key: string): SplitPaneDefinition {
    const definition = this.definitions.get(key)
    if (!definition) throw new Error(`Unknown split pane: ${key}`)
    return definition
  }
}
