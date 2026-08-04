export function localDevelopmentVersion(releaseVersion: string, now = new Date()): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(releaseVersion)
  if (!match) throw new Error(`Local builds require a stable release version, received ${releaseVersion}`)
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger) || patch >= Number.MAX_SAFE_INTEGER) throw new Error(`Invalid release version: ${releaseVersion}`)
  const stamp = now.toISOString()
  const day = stamp.slice(0, 10).replaceAll("-", "")
  const time = stamp.slice(11, 19).replaceAll(":", "")
  return `${major}.${minor}.${patch + 1}-dev.${day}.t${time}`
}
