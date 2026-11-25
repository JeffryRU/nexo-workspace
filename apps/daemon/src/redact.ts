const MASK = '[REDACTED]'
const MAX_DEPTH = 6
const MAX_STRING = 8192

const SENSITIVE_KEY = /token|authorization|secret|password|passwd|api[-_]?key|cookie|credential/i

/** Patrones de secretos con forma reconocible; el grupo 1, si existe, se conserva. */
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // Cabecera o campo Authorization con su esquema y valor.
  [/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi, `$1${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // `?t=...`, `&token=...`
  [/([?&](?:t|token|access_token|api_key|key)=)[^&\s"'#]+/gi, `$1${MASK}`],
  // Subprotocolo WebSocket con el token del daemon.
  [/nexo\.token\.[A-Za-z0-9._~%-]+/g, `nexo.token.${MASK}`],
  // Claves tipo sk-..., sk-ant-..., sk-proj-...
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  // `token=valor`, `"token":"valor"`
  [/((?:token|secret|password|api[-_]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, `$1${MASK}`],
]

export type Redactor = {
  /** Registra un secreto literal (p. ej. el token del daemon) para tacharlo donde aparezca. */
  addSecret(secret: string): void
  redactString(text: string): string
  redactValue(value: unknown): unknown
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createRedactor(): Redactor {
  const secrets = new Set<string>()

  const literal = (text: string): string => {
    let out = text
    for (const secret of secrets) {
      for (const form of new Set([secret, encodeURIComponent(secret)])) {
        out = out.replace(new RegExp(escapeRegExp(form), 'g'), MASK)
      }
    }
    return out
  }

  const redactString = (text: string): string => {
    let out = text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text
    out = literal(out)
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
    return out
  }

  const walk = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value === 'string') return redactString(value)
    if (value === null || typeof value !== 'object') {
      return typeof value === 'function' || typeof value === 'symbol' ? String(value) : value
    }
    if (seen.has(value)) return '[Circular]'
    if (depth >= MAX_DEPTH) return '[Truncated]'
    seen.add(value)
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
        ...(value.stack === undefined ? {} : { stack: redactString(value.stack) }),
      }
    }
    if (Array.isArray(value)) return value.slice(0, 100).map((v) => walk(v, depth + 1, seen))
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value).slice(0, 100)) {
      if (key === '__proto__') continue
      out[key] = SENSITIVE_KEY.test(key) ? MASK : walk(v, depth + 1, seen)
    }
    return out
  }

  return {
    addSecret(secret) {
      if (secret.length >= 8) secrets.add(secret)
    },
    redactString,
    redactValue: (value) => walk(value, 0, new WeakSet()),
  }
}
