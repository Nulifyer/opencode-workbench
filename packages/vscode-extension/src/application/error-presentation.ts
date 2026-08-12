const AUTHORIZATION_VALUE = /\b((?:proxy-)?authorization\s*:\s*)[^\r\n]*/gi
const COOKIE_VALUE = /\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi
const SECRET_VALUE =
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|cookie|password|secret|token|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const URL_CREDENTIAL = /(https?:\/\/)[^/@\s]+@/gi

export function userFacingError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "")
  return raw
    .replace(AUTHORIZATION_VALUE, "$1[redacted]")
    .replace(COOKIE_VALUE, "$1[redacted]")
    .replace(SECRET_VALUE, "$1[redacted]")
    .replace(URL_CREDENTIAL, "$1[redacted]@")
    .replace(/[\r\n\t\0]+/g, " ")
    .trim()
    .slice(0, 2_000) || "The OpenCode Workbench operation failed"
}

export function isUserCancellation(error: unknown): boolean {
  return /\b(cancelled|canceled)\b/i.test(error instanceof Error ? error.message : String(error ?? ""))
}
