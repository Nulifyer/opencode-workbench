import path from "node:path"
import type { EvidenceReference } from "@opencode-workbench/shared"

export interface DiagnosticObservation {
  file: string
  errors: number
  warnings: number
}

export interface DiagnosticsSnapshot {
  errors: number
  warnings: number
  files: number
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function captureDiagnostics(
  repository: string,
  observations: readonly DiagnosticObservation[],
): DiagnosticsSnapshot {
  if (!path.isAbsolute(repository)) throw new Error("Diagnostics repository must be absolute")
  const root = path.resolve(repository)
  let errors = 0
  let warnings = 0
  let files = 0
  for (const observation of observations) {
    if (
      !path.isAbsolute(observation.file) || !nonNegativeInteger(observation.errors) ||
      !nonNegativeInteger(observation.warnings)
    ) continue
    const candidate = path.resolve(observation.file)
    const relative = path.relative(root, candidate)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    errors += observation.errors
    warnings += observation.warnings
    if (observation.errors || observation.warnings) files += 1
  }
  return { errors, warnings, files }
}

export function diagnosticsSummary(snapshot: DiagnosticsSnapshot): string {
  return `${snapshot.errors} errors, ${snapshot.warnings} warnings across ${snapshot.files} files`
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

export function diagnosticsDelta(
  before: DiagnosticsSnapshot,
  after: DiagnosticsSnapshot,
): { status: EvidenceReference["status"]; summary: string } {
  const errorDelta = after.errors - before.errors
  const warningDelta = after.warnings - before.warnings
  const fileDelta = after.files - before.files
  const status: EvidenceReference["status"] = errorDelta > 0
    ? "failed"
    : after.errors === 0 && after.warnings === 0
    ? "passed"
    : "warning"
  return {
    status,
    summary: `Before: ${diagnosticsSummary(before)}; after: ${diagnosticsSummary(after)}; delta: ${
      signed(errorDelta)
    } errors, ${signed(warningDelta)} warnings, ${signed(fileDelta)} files`,
  }
}
