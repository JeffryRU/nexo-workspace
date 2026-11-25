export type RateVerdict = 'ok' | 'limited' | 'abuse'

/**
 * Ventana fija de mensajes por conexión. Pasado el máximo se responde `RATE_LIMITED`; si el
 * cliente insiste más allá de `abuseFactor` veces el máximo, es abuso y se cierra la conexión.
 */
export class RateLimiter {
  readonly #max: number
  readonly #windowMs: number
  readonly #abuseAt: number
  readonly #now: () => number
  #start: number
  #count = 0

  constructor(max: number, windowMs: number, now: () => number = Date.now, abuseFactor = 4) {
    this.#max = max
    this.#windowMs = windowMs
    this.#abuseAt = max * abuseFactor
    this.#now = now
    this.#start = now()
  }

  take(): RateVerdict {
    const t = this.#now()
    if (t - this.#start >= this.#windowMs) {
      this.#start = t
      this.#count = 0
    }
    this.#count++
    if (this.#count <= this.#max) return 'ok'
    return this.#count <= this.#abuseAt ? 'limited' : 'abuse'
  }
}
