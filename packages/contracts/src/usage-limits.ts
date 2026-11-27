import { z } from 'zod'
import { ProviderId } from './agent.ts'
import { LIMITS } from './limits.ts'
import { lineText } from './text.ts'

/**
 * Límites de uso de los proveedores (F4.4): `limits.status` y el evento `limits.updated`. Solo ventanas de uso
 * (porcentaje usado y reinicio); nunca datos de la cuenta (correo, nombre, id, plan). Los métodos viven en
 * `limitsMethods`; `methods.ts` los suma al registro del protocolo.
 */

const Millis = z.int().nonnegative()

/** Estado de una ventana según el proveedor (solo si lo informa; no se deduce del porcentaje). */
export const USAGE_WINDOW_STATES = ['ok', 'warning', 'limit'] as const

export const UsageWindow = z.strictObject({
  /** Qué ventana es dentro de su cubo: `primary`, `secondary` (Codex), `five_hour`, `seven_day`... (Claude). */
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  /** Cubo de medición del proveedor (p. ej. `codex`), si distingue varios. */
  bucket: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
    .optional(),
  label: lineText(LIMITS.maxUsageLabelLength).optional(),
  /** Porcentaje usado, de 0 a 100. */
  usedPercent: z.number().min(0).max(100),
  /** Duración de la ventana en minutos, si se conoce. */
  windowMinutes: z.int().positive().max(LIMITS.maxUsageWindowMinutes).optional(),
  /** Cuándo se reinicia (ms Unix), si se conoce. */
  resetsAt: Millis.optional(),
  state: z.enum(USAGE_WINDOW_STATES).optional(),
})
export type UsageWindow = z.infer<typeof UsageWindow>

export const USAGE_STATUSES = [
  /** Hay ventanas. */
  'ok',
  /** El proveedor no ha informado límites (aún no hubo una sesión, o su plan no los tiene). */
  'unknown',
  /** El proveedor no ofrece límites. */
  'unsupported',
  'unavailable',
  'timeout',
  'error',
] as const

/** Dónde se leyó el dato. */
export const USAGE_SOURCES = [
  /** Consulta directa al proveedor (Codex `account/rateLimits/read`). */
  'query',
  /** Notificación espontánea del proveedor (Codex `account/rateLimits/updated`). */
  'notification',
  /** Evento que el SDK emitió dentro de una sesión (Claude `rate_limit_event`). */
  'session',
] as const

export const ProviderLimits = z.strictObject({
  provider: ProviderId,
  status: z.enum(USAGE_STATUSES),
  windows: z.array(UsageWindow).max(LIMITS.maxUsageWindows),
  /** `true` si el proveedor dice que el límite se alcanzó ahora. */
  reached: z.boolean().optional(),
  source: z.enum(USAGE_SOURCES).optional(),
  /** Cuándo se obtuvo el dato (ms Unix). */
  observedAt: Millis.optional(),
  /** `false` si el dato es viejo (más de `usageStaleAfterMs`) y puede no valer ya. Sin dato, se omite. */
  fresh: z.boolean().optional(),
  /** Motivo si `status` no es `ok`; también si el último dato conocido se muestra aunque el refresco falló. */
  reason: lineText(512).optional(),
})
export type ProviderLimits = z.infer<typeof ProviderLimits>

export const limitsMethods = {
  /**
   * Límites de uso por proveedor (todos o uno). Con `refresh`, los proveedores que se pueden consultar se
   * consultan aunque haya caché; los demás devuelven lo último que informó una sesión. Un proveedor que falla
   * no rompe la respuesta: su estado sale en su entrada.
   */
  'limits.status': {
    params: z.strictObject({
      provider: ProviderId.optional(),
      refresh: z.boolean().optional(),
    }),
    result: z.strictObject({
      providers: z.array(ProviderLimits).max(32),
    }),
  },
} as const

export type LimitsMethodName = keyof typeof limitsMethods
export const LIMITS_METHOD_NAMES = Object.keys(limitsMethods) as LimitsMethodName[]
