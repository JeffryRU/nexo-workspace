import { LIMITS } from '@nexo/contracts'
import type { Unsubscribe, UsageLimitsPort, UsageReading, UsageWindowInfo } from '@nexo/core'
import { z } from 'zod'

/**
 * Límites de uso de Claude (F4.4), solo con lo que el Agent SDK informa durante las sesiones: el mensaje
 * `rate_limit_event` (`SDKRateLimitEvent`, `@anthropic-ai/claude-agent-sdk` 0.3.331). Nexo no hace llamadas
 * propias a ninguna API ni lee archivos de Claude: mientras no haya una sesión que reciba ese evento, los límites
 * de Claude son «desconocidos». No hay `query`.
 *
 * El esquema es `z.object` (descarta todo campo no declarado): del evento solo se leen estado, reinicio, tipo de
 * ventana y utilización; el resto (créditos, sobreuso, métodos de pago, `uuid`, `session_id`) no sale del borde.
 */
const RateLimitEvent = z.object({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.object({
    status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
    utilization: z.number().optional(),
  }),
})

/** Ventanas que conoce el SDK: etiqueta y duración. Una desconocida se muestra con su id y sin duración. */
const KNOWN: Record<string, { label: string; minutes?: number }> = {
  five_hour: { label: 'Sesión de 5 horas', minutes: 300 },
  seven_day: { label: 'Semana', minutes: 10_080 },
  seven_day_opus: { label: 'Semana (Opus)', minutes: 10_080 },
  seven_day_sonnet: { label: 'Semana (Sonnet)', minutes: 10_080 },
  seven_day_overage_included: { label: 'Semana (con uso extra)', minutes: 10_080 },
  overage: { label: 'Uso extra' },
}

const ID = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_MS = 8.64e15

/**
 * `utilization` del evento: la documentación del SDK dice «porcentaje», pero la CLI lo emite como fracción
 * (0-1). Sin poder verificarlo en vivo se aceptan las dos lecturas: hasta 1 es una fracción, de 1 a 100 ya es un
 * porcentaje, y fuera de 0-100 no es un dato (se descarta).
 */
export function percentOf(utilization: number | undefined, rejected: boolean): number | undefined {
  if (utilization === undefined || !Number.isFinite(utilization) || utilization < 0) {
    return rejected ? 100 : undefined
  }
  if (utilization <= 1) return utilization * 100
  if (utilization <= 100) return utilization
  return undefined
}

/** `resetsAt` llega en segundos Unix (el de la cabecera de la API); un valor ya en ms también se acepta. */
export function resetMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  const ms = value < 1e11 ? value * 1000 : value
  return ms < MAX_MS ? Math.trunc(ms) : undefined
}

/** `UsageLimitsPort` de Claude: junta los `rate_limit_event` de todas las sesiones y avisa con la lectura completa. */
export class ClaudeUsageLimits implements UsageLimitsPort {
  readonly providerId = 'claude'
  readonly #windows = new Map<string, UsageWindowInfo>()
  readonly #listeners = new Set<(reading: UsageReading) => void>()
  readonly #now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
  }

  onUpdate(listener: (reading: UsageReading) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Mensaje del SDK de una sesión. Devuelve `true` si era un `rate_limit_event` (válido o no). */
  ingest(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false
    if ((message as { type?: unknown }).type !== 'rate_limit_event') return false
    const parsed = RateLimitEvent.safeParse(message)
    if (!parsed.success) return true
    const info = parsed.data.rate_limit_info
    const rejected = info.status === 'rejected'
    const usedPercent = percentOf(info.utilization, rejected)
    if (usedPercent === undefined) return true
    const rawId = info.rateLimitType ?? 'unknown'
    const id = ID.test(rawId) ? rawId : 'unknown'
    if (!this.#windows.has(id) && this.#windows.size >= LIMITS.maxUsageWindows) return true
    const known = KNOWN[id]
    const resetsAt = resetMs(info.resetsAt)
    this.#windows.set(id, {
      id,
      ...(known === undefined ? {} : { label: known.label }),
      usedPercent: Math.min(100, usedPercent),
      ...(known?.minutes === undefined ? {} : { windowMinutes: known.minutes }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      state: rejected ? 'limit' : info.status === 'allowed_warning' ? 'warning' : 'ok',
    })
    const windows = [...this.#windows.values()]
    const reading: UsageReading = {
      windows,
      reached: windows.some((w) => w.state === 'limit'),
      observedAt: this.#now(),
    }
    for (const l of [...this.#listeners]) {
      try {
        l(reading)
      } catch {
        // un oyente roto no impide avisar a los demás
      }
    }
    return true
  }
}
