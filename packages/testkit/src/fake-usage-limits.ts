import {
  type AbortSignalLike,
  type Unsubscribe,
  UsageLimitsError,
  type UsageLimitsPort,
  type UsageReading,
  type UsageWindowInfo,
} from '@nexo/core'

/**
 * Falso en memoria de `UsageLimitsPort`. `set` fija lo que responde `query`; `report` simula lo que el proveedor
 * informa por su cuenta (notificación o evento de sesión) y también actualiza el dato. Cuenta las consultas y
 * puede «colgarse» (`hang`) o fallar (`failWith`) para probar plazos y errores. Cumple la suite de conformidad.
 */
export class FakeUsageLimits implements UsageLimitsPort {
  readonly providerId: string
  readonly calls = { query: 0 }
  /** Si es `true`, `query` no responde hasta que se cancela la señal. */
  hang = false
  failWith: Error | undefined
  /** Lo que devuelve `query` (puede ser basura, para las pruebas adversariales). */
  current: unknown = { windows: [] }
  readonly #listeners = new Set<(reading: UsageReading) => void>()

  query?: (request: { signal?: AbortSignalLike }) => Promise<UsageReading>

  constructor(providerId = 'fake', options: { queryable?: boolean } = {}) {
    this.providerId = providerId
    if (options.queryable !== false) this.query = (request) => this.#query(request)
  }

  async #query(request: { signal?: AbortSignalLike }): Promise<UsageReading> {
    this.calls.query++
    if (request.signal?.aborted) throw new UsageLimitsError('ABORTED', 'cancelado')
    if (this.failWith !== undefined) throw this.failWith
    if (this.hang) {
      await new Promise<void>((_, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => reject(new UsageLimitsError('ABORTED', 'cancelado')),
          { once: true },
        )
      })
    }
    return this.current as UsageReading
  }

  set(windows: UsageWindowInfo[], extra: Partial<UsageReading> = {}): void {
    this.current = { windows, ...extra }
  }

  /** El proveedor informa por su cuenta: se guarda y se avisa a los oyentes. */
  report(windows: UsageWindowInfo[], extra: Partial<UsageReading> = {}): void {
    this.set(windows, extra)
    this.emitRaw(this.current)
  }

  /** Entrega tal cual (sin validar) una lectura a los oyentes. */
  emitRaw(reading: unknown): void {
    for (const l of [...this.#listeners]) {
      try {
        l(reading as UsageReading)
      } catch {
        // un oyente roto no impide avisar a los demás
      }
    }
  }

  onUpdate(listener: (reading: UsageReading) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
