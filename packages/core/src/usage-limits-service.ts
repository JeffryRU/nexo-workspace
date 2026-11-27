import {
  LIMITS,
  type MethodParams,
  type MethodResult,
  ProviderLimits,
  UsageWindow,
} from '@nexo/contracts'
import { DomainError } from './errors.ts'
import type { AgentProviderPort } from './ports/agent.ts'
import type { AbortSignalLike } from './ports/memory.ts'
import type { ClockPort, EventBusPort, LoggerPort } from './ports/misc.ts'
import { UsageLimitsError, type UsageLimitsPort, type UsageReading } from './ports/usage-limits.ts'

export type UsageLimitsConfig = {
  /** Plazo de una consulta al proveedor (puede arrancar un proceso). */
  queryTimeoutMs?: number
  /** Cuánto se reutiliza una consulta correcta; un fallo se recuerda `failureTtlMs`. */
  ttlMs?: number
  failureTtlMs?: number
  /** Más viejo que esto, el dato sale `fresh: false`. */
  staleAfterMs?: number
  /** Como mucho un evento `limits.updated` por proveedor en este intervalo (el último dato manda). */
  emitIntervalMs?: number
}

export const DEFAULT_USAGE_LIMITS_CONFIG = {
  queryTimeoutMs: 10_000,
  ttlMs: 30_000,
  failureTtlMs: 5_000,
  staleAfterMs: LIMITS.usageStaleAfterMs,
  emitIntervalMs: 500,
} as const satisfies Required<UsageLimitsConfig>

export type UsageLimitsServiceDeps = {
  providers: readonly AgentProviderPort[]
  bus: EventBusPort
  clock: ClockPort
  logger?: LoggerPort
  config?: UsageLimitsConfig
}

type Source = NonNullable<ProviderLimits['source']>
type Latest = {
  windows: UsageWindow[]
  reached: boolean | undefined
  observedAt: number
  source: Source
}
type Failure = { at: number; status: 'unavailable' | 'timeout' | 'error'; reason: string }
type Entry = {
  provider: AgentProviderPort
  port: UsageLimitsPort
  latest?: Latest
  queriedAt?: number
  failure?: Failure | undefined
  flight?: Promise<void> | undefined
  lastEmitAt?: number
  lastEmitted?: string
  timer?: (() => void) | undefined
  unsubscribe: () => void
}

/** Señal de cancelación propia (core no usa `AbortController`: no hay DOM ni Node). */
class Stopper implements AbortSignalLike {
  aborted = false
  readonly #listeners = new Set<() => void>()
  abort(): void {
    if (this.aborted) return
    this.aborted = true
    for (const l of [...this.#listeners]) l()
    this.#listeners.clear()
  }
  addEventListener(_type: 'abort', listener: () => void): void {
    if (this.aborted) listener()
    else this.#listeners.add(listener)
  }
  removeEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners.delete(listener)
  }
}

class DeadlineError extends Error {}

const MAX_MS = 8.64e15

export type NormalizedReading = {
  windows: UsageWindow[]
  reached: boolean | undefined
  observedAt: number | undefined
}

/** Solo los campos conocidos: ningún campo extra (p. ej. de la cuenta) pasa de aquí. */
function pick(item: object, bare = false): Record<string, unknown> {
  const i = item as Record<string, unknown>
  const out: Record<string, unknown> = { id: i.id, usedPercent: i.usedPercent }
  if (bare) return out
  for (const k of ['bucket', 'label', 'windowMinutes', 'resetsAt', 'state']) {
    if (i[k] !== undefined) out[k] = i[k]
  }
  return out
}

/**
 * Valida una lectura ajena: las ventanas mal formadas o fuera de rango se descartan (un campo opcional hostil no
 * esconde la ventana), se acotan en número y se deduplican por cubo e id. `undefined` si no es una lectura.
 */
export function normalizeUsageReading(raw: unknown): NormalizedReading | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Partial<UsageReading>
  if (!Array.isArray(r.windows)) return undefined
  const byKey = new Map<string, UsageWindow>()
  for (const item of r.windows.slice(0, LIMITS.maxUsageWindows * 4)) {
    if (typeof item !== 'object' || item === null) continue
    const full = UsageWindow.safeParse(pick(item))
    const window = full.success ? full.data : UsageWindow.safeParse(pick(item, true)).data
    if (window === undefined) continue
    const key = `${window.bucket ?? ''}\u0000${window.id}`
    byKey.delete(key)
    byKey.set(key, window)
  }
  const observed = r.observedAt
  return {
    windows: [...byKey.values()].slice(-LIMITS.maxUsageWindows),
    reached: typeof r.reached === 'boolean' ? r.reached : undefined,
    observedAt:
      typeof observed === 'number' &&
      Number.isSafeInteger(observed) &&
      observed >= 0 &&
      observed < MAX_MS
        ? observed
        : undefined,
  }
}

/**
 * Casos de uso `limits.status` y `limits.updated` (F4.4). Reúne el `usageLimits` de cada proveedor que lo
 * tiene, valida lo que devuelven, guarda el último dato de cada uno y lo publica por el bus sin inundarlo:
 * como mucho un evento por proveedor y por intervalo, y solo si algo cambió. Las consultas tienen plazo, se
 * comparten si coinciden y se cachean unos segundos; un proveedor que no responde no bloquea a los demás.
 */
export class UsageLimitsService {
  readonly #deps: UsageLimitsServiceDeps
  readonly #cfg: Required<UsageLimitsConfig>
  readonly #entries = new Map<string, Entry>()
  readonly #providers = new Map<string, AgentProviderPort>()
  readonly #stoppers = new Set<Stopper>()
  #closed = false

  constructor(deps: UsageLimitsServiceDeps) {
    this.#deps = deps
    this.#cfg = { ...DEFAULT_USAGE_LIMITS_CONFIG, ...deps.config }
    for (const provider of deps.providers) {
      this.#providers.set(provider.id, provider)
      const port = provider.usageLimits
      if (port === undefined) continue
      const entry: Entry = { provider, port, unsubscribe: () => {} }
      entry.unsubscribe = port.onUpdate((reading) => this.#ingest(entry, reading))
      this.#entries.set(provider.id, entry)
    }
  }

  readonly handlers = {
    'limits.status': (p: MethodParams<'limits.status'>) => this.status(p),
  }

  /** Cancela las consultas en curso, deja de oír a los proveedores y rechaza las nuevas. */
  close(): void {
    this.#closed = true
    for (const s of [...this.#stoppers]) s.abort()
    for (const e of this.#entries.values()) {
      e.unsubscribe()
      e.timer?.()
      e.timer = undefined
    }
  }

  async status(params: MethodParams<'limits.status'>): Promise<MethodResult<'limits.status'>> {
    if (this.#closed) throw new DomainError('PROVIDER_UNAVAILABLE', 'los límites están cerrados')
    const wanted = params.provider
    if (wanted !== undefined && !this.#providers.has(wanted)) {
      throw new DomainError('PROVIDER_UNAVAILABLE', `proveedor desconocido: ${wanted}`)
    }
    const targets = [...this.#providers.values()].filter(
      (p) => wanted === undefined || p.id === wanted,
    )
    const providers = await Promise.all(
      targets.map(async (provider): Promise<ProviderLimits> => {
        const entry = this.#entries.get(provider.id)
        if (entry === undefined) {
          return {
            provider: provider.id,
            status: 'unsupported',
            windows: [],
            reason: `${provider.displayName} no ofrece límites de uso`,
          }
        }
        if (entry.port.query !== undefined) await this.#refresh(entry, params.refresh === true)
        return this.#build(entry)
      }),
    )
    return { providers }
  }

  // ---- consulta ----

  #refresh(entry: Entry, force: boolean): Promise<void> {
    const now = this.#deps.clock.now()
    if (!force) {
      if (entry.failure !== undefined && now - entry.failure.at < this.#cfg.failureTtlMs) {
        return Promise.resolve()
      }
      if (entry.queriedAt !== undefined && now - entry.queriedAt < this.#cfg.ttlMs) {
        return Promise.resolve()
      }
    }
    entry.flight ??= this.#query(entry).finally(() => {
      entry.flight = undefined
    })
    return entry.flight
  }

  async #query(entry: Entry): Promise<void> {
    const query = entry.port.query?.bind(entry.port)
    if (query === undefined) return
    try {
      const raw = await this.#withDeadline((signal) => query({ signal }))
      if (this.#closed) return
      const reading = normalizeUsageReading(raw)
      if (reading === undefined) {
        throw new UsageLimitsError(
          'UNAVAILABLE',
          'el proveedor devolvió una lectura que no se pudo usar',
        )
      }
      const now = this.#deps.clock.now()
      entry.failure = undefined
      entry.queriedAt = now
      this.#store(entry, reading, 'query', now)
      this.#schedule(entry)
    } catch (error) {
      if (this.#closed) return
      entry.failure = { at: this.#deps.clock.now(), ...this.#failure(entry, error) }
    }
  }

  #failure(entry: Entry, error: unknown): Pick<Failure, 'status' | 'reason'> {
    if (error instanceof DeadlineError) {
      return { status: 'timeout', reason: 'el proveedor no respondió a tiempo' }
    }
    if (error instanceof UsageLimitsError) {
      return { status: 'unavailable', reason: error.message.slice(0, 500) }
    }
    this.#deps.logger?.warn('limits.status falló', { provider: entry.provider.id })
    return { status: 'error', reason: 'el proveedor falló al consultar sus límites' }
  }

  async #withDeadline<T>(run: (signal: AbortSignalLike) => Promise<T>): Promise<T> {
    const stopper = new Stopper()
    this.#stoppers.add(stopper)
    let cancelTimer: (() => void) | undefined
    try {
      return await Promise.race([
        run(stopper),
        new Promise<never>((_, reject) => {
          cancelTimer = this.#deps.clock.setTimeout(() => {
            stopper.abort()
            reject(new DeadlineError())
          }, this.#cfg.queryTimeoutMs)
          stopper.addEventListener('abort', () => reject(new DeadlineError()))
        }),
      ])
    } catch (error) {
      if (stopper.aborted) throw new DeadlineError()
      throw error
    } finally {
      cancelTimer?.()
      this.#stoppers.delete(stopper)
    }
  }

  // ---- estado y eventos ----

  #store(entry: Entry, reading: NormalizedReading, source: Source, now: number): void {
    entry.latest = {
      windows: reading.windows,
      reached: reading.reached,
      observedAt: Math.min(reading.observedAt ?? now, now),
      source,
    }
  }

  #ingest(entry: Entry, raw: UsageReading): void {
    if (this.#closed) return
    const reading = normalizeUsageReading(raw)
    if (reading === undefined) {
      this.#deps.logger?.debug('lectura de límites descartada', { provider: entry.provider.id })
      return
    }
    // Un aviso sin ventanas válidas no dice nada: no borra lo que ya se sabía ni publica.
    if (reading.windows.length === 0) return
    const source = entry.port.query === undefined ? 'session' : 'notification'
    this.#store(entry, reading, source, this.#deps.clock.now())
    this.#schedule(entry)
  }

  /** Publica `limits.updated` con el último dato, como mucho una vez por intervalo y solo si cambió. */
  #schedule(entry: Entry): void {
    if (this.#closed || entry.timer !== undefined) return
    const now = this.#deps.clock.now()
    const wait =
      entry.lastEmitAt === undefined ? 0 : entry.lastEmitAt + this.#cfg.emitIntervalMs - now
    if (wait <= 0) {
      this.#emit(entry)
      return
    }
    entry.timer = this.#deps.clock.setTimeout(() => {
      entry.timer = undefined
      this.#emit(entry)
    }, wait)
  }

  #emit(entry: Entry): void {
    if (this.#closed) return
    const data = this.#build(entry)
    // `fresh` cambia solo con el tiempo: lo que decide si hay novedad es el contenido.
    const key = JSON.stringify([data.status, data.windows, data.reached, data.source])
    if (key === entry.lastEmitted) return
    const checked = ProviderLimits.safeParse(data)
    if (!checked.success) return
    entry.lastEmitted = key
    entry.lastEmitAt = this.#deps.clock.now()
    this.#deps.bus.publish({ event: 'limits.updated', data: checked.data })
  }

  #build(entry: Entry): ProviderLimits {
    const provider = entry.provider.id
    const { latest, failure } = entry
    if (latest === undefined || latest.windows.length === 0) {
      if (failure !== undefined) {
        return { provider, status: failure.status, windows: [], reason: failure.reason }
      }
      return {
        provider,
        status: 'unknown',
        windows: [],
        ...(latest === undefined
          ? {
              reason: `${entry.provider.displayName} aún no ha informado sus límites${
                entry.port.query === undefined ? ' (solo los informa durante una sesión)' : ''
              }`,
            }
          : { source: latest.source, observedAt: latest.observedAt }),
        ...(latest?.reached === undefined ? {} : { reached: latest.reached }),
      }
    }
    const now = this.#deps.clock.now()
    const resetPassed = latest.windows.some((w) => w.resetsAt !== undefined && w.resetsAt <= now)
    const fresh = now - latest.observedAt <= this.#cfg.staleAfterMs && !resetPassed
    return {
      provider,
      status: 'ok',
      windows: latest.windows,
      ...(latest.reached === undefined ? {} : { reached: latest.reached }),
      source: latest.source,
      observedAt: latest.observedAt,
      fresh,
      ...(failure === undefined ? {} : { reason: `no se pudo refrescar: ${failure.reason}` }),
    }
  }
}

export type UsageLimitsHandlers = UsageLimitsService['handlers']
