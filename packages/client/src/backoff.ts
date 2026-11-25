export type BackoffOptions = {
  /** Retardo mínimo y base de la progresión (ms). */
  baseMs: number
  /** Tope (ms). */
  maxMs: number
}

/**
 * Backoff exponencial con jitter: el retardo crece como `base * 2^intento`, se acota a `maxMs` y se
 * reparte entre la mitad y el total (jitter). Nunca baja de `baseMs` ni pasa de `maxMs`.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const { baseMs, maxMs } = options
  const exponent = Number.isFinite(attempt) ? Math.min(Math.max(0, Math.trunc(attempt)), 30) : 30
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent)
  const sample = random()
  const r = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 1
  const jittered = ceiling * (0.5 + 0.5 * r)
  return Math.min(maxMs, Math.max(baseMs, jittered))
}
