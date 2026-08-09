export function processLockCanBeReclaimed(
  owner: string,
  modifiedAt: number,
  now: number,
  staleMilliseconds: number,
  isAlive: (pid: number) => boolean,
): boolean {
  const ownerPID = Number(owner.split(":", 1)[0])
  const validOwnerPID = Number.isSafeInteger(ownerPID) && ownerPID > 0
  if (validOwnerPID) return !isAlive(ownerPID)
  // An owner can be briefly empty between exclusive creation and its first
  // write. Give that ambiguous state a short grace period, but keep it below
  // the acquisition timeout so a crash in that window remains recoverable.
  const ambiguousGrace = Math.min(staleMilliseconds, 250)
  return Number.isFinite(modifiedAt) && now - modifiedAt > ambiguousGrace
}
