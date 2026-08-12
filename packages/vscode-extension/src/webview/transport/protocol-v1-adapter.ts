export function parseWithProtocolV1Adapter<T>(
  value: unknown,
  parseCurrent: (value: unknown) => T | undefined,
): T | undefined {
  const current = parseCurrent(value)
  if (current !== undefined) return current
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const legacy = value as Record<string, unknown>
  return legacy.type === "state" && legacy.state !== undefined
    ? parseCurrent({ type: "snapshot", snapshot: legacy.state })
    : undefined
}
