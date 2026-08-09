export type MenuNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End"

/** Returns the next roving menu index without depending on browser focus state. */
export function nextMenuIndex(key: MenuNavigationKey, current: number, length: number): number | undefined {
  if (!Number.isSafeInteger(length) || length < 1) return undefined
  if (key === "Home") return 0
  if (key === "End") return length - 1
  if (current < 0 || current >= length) return key === "ArrowDown" ? 0 : length - 1
  return key === "ArrowDown" ? (current + 1) % length : (current + length - 1) % length
}
