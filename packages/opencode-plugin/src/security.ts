export const LIMITS = {
  preferenceKey: 64,
  preferenceValue: 500,
  rationale: 500,
  search: 100,
  bridgeRequest: 128 * 1024,
  bridgeResponse: 64 * 1024,
  injectedPreferences: 20,
  injectedCharacters: 4_000,
} as const

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\b(?:sk|rk)-(?:live|test|proj)-[A-Za-z0-9_-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s,;]{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
]

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+(?:(?:system|developer)\s+)?(?:instructions?|messages?|prompts?)\b/i,
  /\b(?:reveal|repeat|print|exfiltrate)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\b(?:system|developer)\s+prompt\s*:/i,
  /<\/?(?:system|developer|assistant|tool)(?:\s|>)/i,
  /\[(?:INST|SYSTEM)\]/i,
  /\byou\s+are\s+(?:chatgpt|an?\s+assistant|the\s+system)\b/i,
  /\b(?:do\s+not|don't)\s+(?:follow|obey)\s+(?:the\s+)?(?:user|system|developer)\b/i,
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:rules?|directives?|guidance)\b/i,
]

export function validateDurableText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim().replace(/\r\n/g, "\n")
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`)
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) throw new Error(`${field} appears to contain a secret`)
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(normalized))) throw new Error(`${field} appears to contain prompt injection`)
  return normalized
}

export function validatePreferenceKey(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(normalized)) {
    throw new Error("key must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens")
  }
  return normalized
}

export function validateSkillName(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 64) {
    throw new Error("skill name must be a lowercase hyphen-separated name up to 64 characters")
  }
  return normalized
}

export function safeSubject(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const normalized = value.trim()
  return /^[a-zA-Z0-9_.:@/-]{1,128}$/.test(normalized) ? normalized : fallback
}
