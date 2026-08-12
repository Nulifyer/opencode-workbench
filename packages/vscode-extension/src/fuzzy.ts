function boundaryBonus(value: string, index: number): number {
  if (index === 0) return 18
  const previous = value[index - 1]!
  const current = value[index]!
  if (previous === "/") return 22
  if ("._- ".includes(previous)) return 16
  if (previous >= "a" && previous <= "z" && current >= "A" && current <= "Z") return 12
  return 0
}

function scorePrepared(
  needle: string,
  candidate: string,
  haystack: string,
  scratch?: { previous: Float64Array; next: Float64Array },
): number | undefined {
  if (!needle) return -candidate.length
  if (needle.length > haystack.length) return undefined
  let previous = scratch && scratch.previous.length >= candidate.length
    ? scratch.previous
    : new Float64Array(candidate.length)
  let next = scratch && scratch.next.length >= candidate.length ? scratch.next : new Float64Array(candidate.length)
  previous.fill(Number.NEGATIVE_INFINITY, 0, candidate.length)
  for (let index = 0; index < candidate.length; index += 1) {
    if (haystack[index] === needle[0]) previous[index] = 16 + boundaryBonus(candidate, index) - Math.min(index, 24)
  }
  for (let queryIndex = 1; queryIndex < needle.length; queryIndex += 1) {
    next.fill(Number.NEGATIVE_INFINITY, 0, candidate.length)
    let best = Number.NEGATIVE_INFINITY
    for (let index = 0; index < candidate.length; index += 1) {
      if (index > 0) best = Math.max(best - 1, previous[index - 1]!)
      if (haystack[index] !== needle[queryIndex] || !Number.isFinite(best)) continue
      const consecutive =
        index > 0 && haystack[index - 1] === needle[queryIndex - 1] && Number.isFinite(previous[index - 1]!)
          ? previous[index - 1]! + 24
          : Number.NEGATIVE_INFINITY
      next[index] = 16 + boundaryBonus(candidate, index) + Math.max(best, consecutive)
    }
    const swap = previous
    previous = next
    next = swap
  }
  let score = Number.NEGATIVE_INFINITY
  for (let index = 0; index < candidate.length; index += 1) if (previous[index]! > score) score = previous[index]!
  if (!Number.isFinite(score)) return undefined
  const basename = candidate.slice(candidate.lastIndexOf("/") + 1).toLowerCase()
  const exact = basename.indexOf(needle)
  return score + (exact === 0 ? 80 : exact > 0 ? 30 : 0) - Math.min(candidate.length / 8, 20)
}

export function fzfScore(query: string, candidate: string): number | undefined {
  return scorePrepared(query.toLowerCase(), candidate, candidate.toLowerCase())
}

export interface PreparedFzfIndex {
  candidates: Array<{ value: string; lower: string }>
  maxLength: number
}

export function workspaceSearchPaths(files: string[], limit = 20_000): string[] {
  const paths = new Set(files.slice(0, limit))
  for (const file of files) {
    const separator = file.lastIndexOf("/")
    let parent = separator < 0 ? "" : file.slice(0, separator)
    while (parent && paths.size < limit) {
      paths.add(parent)
      const parentSeparator = parent.lastIndexOf("/")
      parent = parentSeparator < 0 ? "" : parent.slice(0, parentSeparator)
    }
    if (paths.size >= limit) break
  }
  return [...paths]
}

export function prepareFzf(candidates: string[]): PreparedFzfIndex {
  let maxLength = 0
  const prepared = candidates.map((value) => {
    maxLength = Math.max(maxLength, value.length)
    return { value, lower: value.toLowerCase() }
  })
  return { candidates: prepared, maxLength }
}

export function rankPreparedFzf(query: string, index: PreparedFzfIndex, limit = 20): string[] {
  if (limit <= 0) return []
  const needle = query.toLowerCase()
  const scratch = { previous: new Float64Array(index.maxLength), next: new Float64Array(index.maxLength) }
  const best: Array<{ candidate: string; score: number }> = []
  const compare = (left: { candidate: string; score: number }, right: { candidate: string; score: number }) =>
    right.score - left.score || left.candidate.length - right.candidate.length ||
    left.candidate.localeCompare(right.candidate)
  for (const candidate of index.candidates) {
    const score = scorePrepared(needle, candidate.value, candidate.lower, scratch)
    if (score === undefined) continue
    const entry = { candidate: candidate.value, score }
    let position = best.findIndex((current) => compare(entry, current) < 0)
    if (position < 0) position = best.length
    if (position < limit) best.splice(position, 0, entry)
    else if (best.length < limit) best.push(entry)
    if (best.length > limit) best.pop()
  }
  return best.map((entry) => entry.candidate)
}

export function rankFzf(query: string, candidates: string[], limit = 20): string[] {
  return rankPreparedFzf(query, prepareFzf(candidates), limit)
}
