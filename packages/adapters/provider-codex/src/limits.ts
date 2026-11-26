import { LIMITS } from '@nexo/contracts'
import {
  type AbortSignalLike,
  type Unsubscribe,
  UsageLimitsError,
  type UsageLimitsPort,
  type UsageReading,
  type UsageWindowInfo,
} from '@nexo/core'
import { RpcClosedError, RpcError, RpcTimeoutError } from '@nexo/jsonrpc'
import { z } from 'zod'
import type { CodexClient } from './client.ts'
import type { CodexCommand } from './resolve.ts'
import { line } from './text.ts'

/**
 * Límites de uso de Codex (F4.4), con `account/rateLimits/read` y la notificación `account/rateLimits/updated`
 * de `codex app-server` (esquema de codex-cli 0.158.0).
 *
 * Los esquemas de abajo son `z.object` (no `looseObject`) a propósito: **descartan** todo campo que no declaran,
 * y aquí solo se declaran ventanas, su porcentaje, duración y reinicio. Los datos de la cuenta que acompañan a la
 * respuesta (`accountId`, `planType`, `credits`, saldo, créditos de reinicio...) nunca se leen ni salen del borde.
 * No se llama a `account/read`.
 */
const Window = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullish(),
  resetsAt: z.number().nullish(),
})

const Snapshot = z.object({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  // Cada ventana se valida por separado (`Window`): una mal formada no tira la respuesta entera.
  primary: z.unknown().optional(),
  secondary: z.unknown().optional(),
  rateLimitReachedType: z.string().nullish(),
})
type Snapshot = z.infer<typeof Snapshot>

export const RateLimitsResult = z.object({
  rateLimits: Snapshot,
  rateLimitsByLimitId: z.record(z.string(), Snapshot).nullish(),
})

export const RateLimitsNotification = z.object({ rateLimits: Snapshot })

export const RATE_LIMITS_READ = 'account/rateLimits/read'
export const RATE_LIMITS_UPDATED = 'account/rateLimits/updated'

const DEFAULT_BUCKET = 'codex'
const BUCKET = /^[A-Za-z0-9_.:-]{1,64}$/
const MAX_BUCKETS = 8

const secondsToMs = (s: number | null | undefined): number | undefined =>
  typeof s === 'number' && Number.isFinite(s) && s >= 0 && s < 1e11
    ? Math.trunc(s * 1000)
    : undefined

const minutes = (m: number | null | undefined): number | undefined =>
  typeof m === 'number' && Number.isFinite(m) && m >= 1 && m <= LIMITS.maxUsageWindowMinutes
    ? Math.trunc(m)
    : undefined

/** Ventanas de un cubo. Un porcentaje no finito o negativo descarta la ventana; uno por encima de 100 se acota. */
export function windowsOf(snapshot: Snapshot, bucketKey?: string): UsageWindowInfo[] {
  const wanted = snapshot.limitId ?? bucketKey ?? DEFAULT_BUCKET
  const bucket = BUCKET.test(wanted) ? wanted : DEFAULT_BUCKET
  const rawLabel = snapshot.limitName
  const label =
    rawLabel === null || rawLabel === undefined ? '' : line(rawLabel, LIMITS.maxUsageLabelLength)
  const out: UsageWindowInfo[] = []
  for (const [id, candidate] of [
    ['primary', snapshot.primary],
    ['secondary', snapshot.secondary],
  ] as const) {
    const parsed = Window.safeParse(candidate)
    if (!parsed.success) continue
    const w = parsed.data
    if (!Number.isFinite(w.usedPercent) || w.usedPercent < 0) continue
    const usedPercent = Math.min(100, w.usedPercent)
    const windowMinutes = minutes(w.windowDurationMins)
    const resetsAt = secondsToMs(w.resetsAt)
    out.push({
      id,
      bucket,
      ...(label === '' ? {} : { label }),
      usedPercent,
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(usedPercent >= 100 ? { state: 'limit' as const } : {}),
    })
  }
  return out
}

/** Todas las ventanas de una respuesta completa: el mapa por cubo si lo trae; si no, el cubo único. */
export function readingOf(result: z.infer<typeof RateLimitsResult>): UsageReading {
  const buckets = Object.entries(result.rateLimitsByLimitId ?? {}).slice(0, MAX_BUCKETS)
  const snapshots: [Snapshot, string | undefined][] =
    buckets.length > 0 ? buckets.map(([key, s]) => [s, key]) : [[result.rateLimits, undefined]]
  const windows = snapshots.flatMap(([s, key]) => windowsOf(s, key))
  const reached = snapshots.some(([s]) => s.rateLimitReachedType != null)
  return { windows, reached }
}

export type CodexLimitsDeps = {
  /** Resuelve el ejecutable (`codex`); `error` si no está instalado. */
  command(): CodexCommand | { error: string }
  /** Lanza un `codex app-server` nuevo (sin abrir hilos ni tocar la sesión del usuario). */
  client(command: CodexCommand, cwd: string): CodexClient
  requestTimeoutMs: number
  now?: () => number
}

const keyOf = (w: UsageWindowInfo): string => `${w.bucket ?? ''}\u0000${w.id}`

/**
 * `UsageLimitsPort` de Codex. `query` lanza un `codex app-server` efímero y pide `account/rateLimits/read` (sin
 * abrir hilos); las sesiones reenvían aquí `account/rateLimits/updated` (`ingest`). Las actualizaciones son
 * parciales («junta lo disponible con la última lectura»): se mezclan con lo último que se sabe y se entrega la
 * lectura completa.
 */
export class CodexUsageLimits implements UsageLimitsPort {
  readonly providerId = 'codex'
  readonly #deps: CodexLimitsDeps
  readonly #windows = new Map<string, UsageWindowInfo>()
  readonly #listeners = new Set<(reading: UsageReading) => void>()

  constructor(deps: CodexLimitsDeps) {
    this.#deps = deps
  }

  onUpdate(listener: (reading: UsageReading) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async query(request: { signal?: AbortSignalLike }): Promise<UsageReading> {
    const signal = request.signal
    if (signal?.aborted) throw new UsageLimitsError('ABORTED', 'cancelado')
    const command = this.#deps.command()
    if ('error' in command) {
      throw new UsageLimitsError('UNAVAILABLE', `No se encontró Codex: ${line(command.error, 200)}`)
    }
    const client = this.#deps.client(command, process.cwd())
    const onAbort = () => client.close(200)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await client.handshake()
      const result = await client.call(
        RATE_LIMITS_READ,
        undefined,
        RateLimitsResult,
        this.#deps.requestTimeoutMs,
      )
      const reading = readingOf(result)
      this.#windows.clear()
      for (const w of reading.windows) this.#windows.set(keyOf(w), w)
      return { ...reading, observedAt: (this.#deps.now ?? Date.now)() }
    } catch (error) {
      if (signal?.aborted) throw new UsageLimitsError('ABORTED', 'cancelado')
      throw fail(error)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      client.close(500)
    }
  }

  /** Notificación de una sesión. Devuelve `true` si era de límites (la sesión no la trata como de un turno). */
  ingest(method: string, params: unknown): boolean {
    if (method !== RATE_LIMITS_UPDATED) return false
    const parsed = RateLimitsNotification.safeParse(params)
    if (!parsed.success) return true
    const windows = windowsOf(parsed.data.rateLimits)
    // Una notificación sin ventanas válidas no cambia nada: no se avisa.
    if (windows.length === 0) return true
    for (const w of windows) {
      const key = keyOf(w)
      if (this.#windows.has(key) || this.#windows.size < LIMITS.maxUsageWindows) {
        this.#windows.set(key, w)
      }
    }
    const reading: UsageReading = {
      windows: [...this.#windows.values()],
      reached: parsed.data.rateLimits.rateLimitReachedType != null,
      observedAt: (this.#deps.now ?? Date.now)(),
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

/** Errores sin detalle del servidor: su mensaje podría llevar datos de la cuenta, así que no se reenvía. */
function fail(error: unknown): UsageLimitsError {
  if (error instanceof UsageLimitsError) return error
  if (error instanceof RpcTimeoutError) {
    return new UsageLimitsError('UNAVAILABLE', 'Codex no respondió a tiempo', { cause: error })
  }
  if (error instanceof RpcError) {
    return new UsageLimitsError(
      'UNAVAILABLE',
      'Codex no informa límites (¿sesión de ChatGPT iniciada con «codex login»?)',
      { cause: error },
    )
  }
  if (error instanceof RpcClosedError) {
    return new UsageLimitsError('UNAVAILABLE', 'Codex terminó antes de informar sus límites', {
      cause: error,
    })
  }
  return new UsageLimitsError('UNAVAILABLE', 'Codex devolvió una respuesta que no se pudo usar', {
    cause: error,
  })
}
