export type Take = { ok: true } | { ok: false; retryAfterMs: number }

/** Ventana deslizante: como mucho `max` usos en `windowMs`. El reloj se inyecta para las pruebas. */
export class SlidingWindowLimiter {
  readonly #max: number
  readonly #windowMs: number
  readonly #now: () => number
  readonly #hits: number[] = []

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.#max = max
    this.#windowMs = windowMs
    this.#now = now
  }

  take(): Take {
    const now = this.#now()
    while (this.#hits.length > 0 && now - (this.#hits[0] as number) >= this.#windowMs) {
      this.#hits.shift()
    }
    if (this.#hits.length >= this.#max) {
      const oldest = this.#hits[0] as number
      return { ok: false, retryAfterMs: Math.max(1, oldest + this.#windowMs - now) }
    }
    this.#hits.push(now)
    return { ok: true }
  }
}
