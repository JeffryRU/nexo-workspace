const MASK = '[REDACTED]'
const MAX_STRING = 8192

/** Variables cuyo valor nunca se deja pasar a un log. */
const SENSITIVE_ENV = /key|token|secret|password|passwd|credential|auth|cookie/i

/** Patrones de secretos con forma reconocible; el grupo 1, si existe, se conserva. */
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi, `$1${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  [
    /((?:token|secret|password|api[-_]?key|oauth[-_]?token)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    `$1${MASK}`,
  ],
]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type SecretRedactor = {
  /** Tacha los valores literales de las credenciales del entorno y los patrones con forma de secreto. */
  redact(text: string): string
  /** Solo los valores literales (barato; para texto de contenido que no debe alterarse de otro modo). */
  scrub(text: string): string
}

/**
 * Redactor mínimo del adaptador (el del daemon vive en `apps/` y un adaptador no puede importarlo).
 * Conoce los valores reales de las variables sensibles de `env`, además de los patrones habituales.
 */
export function createSecretRedactor(
  env: Readonly<Record<string, string | undefined>>,
): SecretRedactor {
  const literals = new Set<string>()
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= 8 && SENSITIVE_ENV.test(key)) literals.add(value)
  }
  const matchers = [...literals]
    .sort((a, b) => b.length - a.length)
    .map((secret) => new RegExp(escapeRegExp(secret), 'g'))

  const scrub = (text: string): string => {
    let out = text
    for (const matcher of matchers) out = out.replace(matcher, MASK)
    return out
  }
  const redact = (text: string): string => {
    let out = scrub(text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text)
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
    return out
  }
  return { redact, scrub }
}

/** Copia del entorno apta para un log: los valores de variables sensibles se sustituyen por la máscara. */
export function redactEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === '__proto__') continue
    out[key] = SENSITIVE_ENV.test(key) ? MASK : value
  }
  return out
}
