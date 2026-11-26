import {
  BlockDraft,
  type HistoryBlock,
  type HistoryProviderStatus,
  HistorySession,
  LIMITS,
  type MethodParams,
  type MethodResult,
} from '@nexo/contracts'
import { DomainError } from './errors.ts'
import { decodeHistoryCursor, pageHistory, projectKeyOf } from './history-paging.ts'
import type { AgentProviderPort } from './ports/agent.ts'
import {
  HistoryError,
  type HistoryPort,
  type HistorySessionInfo,
  type HistoryTranscript,
} from './ports/history.ts'
import type { AbortSignalLike } from './ports/memory.ts'
import type { ClockPort, LoggerPort } from './ports/misc.ts'

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

export type HistoryServiceConfig = {
  /** Plazo de la lista de un proveedor (puede arrancar un proceso). */
  listTimeoutMs?: number
  /** Plazo de la lectura de una transcripción. */
  readTimeoutMs?: number
  /** Cuánto se reutiliza una lista correcta. Un fallo se recuerda `failureTtlMs`. */
  listTtlMs?: number
  failureTtlMs?: number
  /** Cuánto se reutiliza una transcripción ya leída (para paginar sin volver a leerla). */
  readTtlMs?: number
  /** Transcripciones que se guardan a la vez. */
  maxCachedTranscripts?: number
}

export type HistoryServiceDeps = {
  providers: readonly AgentProviderPort[]
  clock: ClockPort
  logger?: LoggerPort
  config?: HistoryServiceConfig
}

export const DEFAULT_HISTORY_CONFIG = {
  listTimeoutMs: 10_000,
  readTimeoutMs: 30_000,
  listTtlMs: 15_000,
  failureTtlMs: 3_000,
  readTtlMs: 30_000,
  maxCachedTranscripts: 4,
} as const satisfies Required<HistoryServiceConfig>

const MAX_LIST_CACHE = 64
const READ_CURSOR = /^o(\d{1,5})$/

type ListOutcome =
  | { kind: 'ok'; sessions: HistorySession[] }
  | { kind: 'fail'; status: HistoryProviderStatus['status']; reason: string }

type Cached<T> = { at: number; value: T }

type Transcript = { blocks: HistoryBlock[]; truncated: boolean }

const reasonOf = (e: unknown): string =>
  e instanceof HistoryError
    ? e.message.slice(0, 500)
    : 'el proveedor falló al consultar el historial'

/**
 * Casos de uso `history.list` y `history.read` (F4.3). Reúne el `history` de cada proveedor que lo tiene, valida
 * lo que devuelven (es salida ajena), ordena y pagina con cursor, y evita lanzar procesos caros en cada llamada:
 * la lista de cada proveedor se guarda unos segundos (y las llamadas simultáneas comparten una sola consulta) y
 * una transcripción leída se guarda un rato para paginarla. Cada consulta tiene plazo y se puede cancelar
 * (`close`).
 */
export class HistoryService {
  readonly #deps: HistoryServiceDeps
  readonly #cfg: Required<HistoryServiceConfig>
  readonly #ports = new Map<string, { provider: AgentProviderPort; history: HistoryPort }>()
  readonly #providers = new Map<string, AgentProviderPort>()
  readonly #lists = new Map<string, Cached<ListOutcome>>()
  readonly #listFlights = new Map<string, Promise<ListOutcome>>()
  readonly #transcripts = new Map<string, Cached<Transcript>>()
  readonly #readFlights = new Map<string, Promise<Transcript>>()
  readonly #stoppers = new Set<Stopper>()
  #closed = false

  constructor(deps: HistoryServiceDeps) {
    this.#deps = deps
    this.#cfg = { ...DEFAULT_HISTORY_CONFIG, ...deps.config }
    for (const p of deps.providers) {
      this.#providers.set(p.id, p)
      if (p.history !== undefined) this.#ports.set(p.id, { provider: p, history: p.history })
    }
  }

  readonly handlers = {
    'history.list': (p: MethodParams<'history.list'>) => this.list(p),
    'history.read': (p: MethodParams<'history.read'>) => this.read(p),
  }

  /** Cancela las consultas en curso y rechaza las nuevas. */
  close(): void {
    this.#closed = true
    for (const s of [...this.#stoppers]) s.abort()
    this.#lists.clear()
    this.#transcripts.clear()
  }

  async list(params: MethodParams<'history.list'>): Promise<MethodResult<'history.list'>> {
    if (this.#closed) throw new DomainError('PROVIDER_UNAVAILABLE', 'el historial está cerrado')
    const cursor = params.cursor === undefined ? undefined : decodeHistoryCursor(params.cursor)
    if (params.cursor !== undefined && cursor === undefined) {
      throw new DomainError('INVALID_PARAMS', 'cursor no válido')
    }
    const wanted = params.provider
    if (wanted !== undefined && !this.#providers.has(wanted)) {
      throw new DomainError('PROVIDER_UNAVAILABLE', `proveedor desconocido: ${wanted}`)
    }
    const cwdKey = params.cwd === undefined ? undefined : projectKeyOf(params.cwd)
    const targets = [...this.#providers.values()].filter(
      (p) => wanted === undefined || p.id === wanted,
    )
    const statuses: HistoryProviderStatus[] = []
    const sessions: HistorySession[] = []
    const outcomes = await Promise.all(
      targets.map(async (provider) => {
        const entry = this.#ports.get(provider.id)
        if (entry === undefined) {
          return {
            provider,
            outcome: {
              kind: 'fail',
              status: 'unsupported',
              reason: `${provider.displayName} no ofrece historial`,
            } as ListOutcome,
            cached: false,
          }
        }
        const got = await this.#listFor(entry.history, provider.id, params.cwd)
        return { provider, outcome: got.outcome, cached: got.cached }
      }),
    )
    for (const { provider, outcome, cached } of outcomes) {
      if (outcome.kind === 'fail') {
        statuses.push({ provider: provider.id, status: outcome.status, reason: outcome.reason })
        continue
      }
      statuses.push({ provider: provider.id, status: 'ok', ...(cached ? { cached: true } : {}) })
      for (const s of outcome.sessions) {
        if (cwdKey !== undefined && projectKeyOf(s.cwd) !== cwdKey) continue
        sessions.push(s)
      }
    }
    const page = pageHistory(sessions, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: params.limit ?? 50,
    })
    return { projects: page.projects, nextCursor: page.nextCursor, providers: statuses }
  }

  async read(params: MethodParams<'history.read'>): Promise<MethodResult<'history.read'>> {
    if (this.#closed) throw new DomainError('PROVIDER_UNAVAILABLE', 'el historial está cerrado')
    const provider = this.#providers.get(params.provider)
    if (provider === undefined) {
      throw new DomainError('PROVIDER_UNAVAILABLE', `proveedor desconocido: ${params.provider}`)
    }
    const entry = this.#ports.get(provider.id)
    if (entry === undefined || !entry.history.canRead) {
      throw new DomainError(
        'PROVIDER_UNAVAILABLE',
        `${provider.displayName} no permite leer su historial`,
      )
    }
    let offset = 0
    if (params.cursor !== undefined) {
      const m = READ_CURSOR.exec(params.cursor)
      if (m === null) throw new DomainError('INVALID_PARAMS', 'cursor no válido')
      offset = Number(m[1])
    }
    const transcript = await this.#transcriptFor(entry.history, params)
    if (offset > transcript.blocks.length) {
      throw new DomainError('INVALID_PARAMS', 'cursor fuera de la transcripción')
    }
    const limit = params.limit ?? 50
    const blocks: HistoryBlock[] = []
    let bytes = 0
    let at = offset
    while (at < transcript.blocks.length && blocks.length < limit) {
      const b = transcript.blocks[at] as HistoryBlock
      const size = JSON.stringify(b).length
      if (blocks.length > 0 && bytes + size > LIMITS.maxHistoryPageBytes) break
      blocks.push(b)
      bytes += size
      at++
    }
    return {
      provider: provider.id,
      sessionId: params.sessionId,
      blocks,
      nextCursor: at < transcript.blocks.length ? `o${at}` : null,
      total: transcript.blocks.length,
      truncated: transcript.truncated,
    }
  }

  // ---- lista ----

  async #listFor(
    history: HistoryPort,
    providerId: string,
    cwd: string | undefined,
  ): Promise<{ outcome: ListOutcome; cached: boolean }> {
    const key = `${providerId}|${cwd === undefined ? '' : (projectKeyOf(cwd) ?? '')}`
    const now = this.#deps.clock.now()
    const hit = this.#lists.get(key)
    if (hit !== undefined) {
      const stable = hit.value.kind === 'ok' || hit.value.status === 'unsupported'
      const ttl = stable ? this.#cfg.listTtlMs : this.#cfg.failureTtlMs
      if (now - hit.at < ttl) return { outcome: hit.value, cached: true }
      this.#lists.delete(key)
    }
    let flight = this.#listFlights.get(key)
    if (flight === undefined) {
      flight = this.#fetchList(history, providerId, cwd)
        .then((outcome) => {
          if (!this.#closed) {
            this.#lists.set(key, { at: this.#deps.clock.now(), value: outcome })
            while (this.#lists.size > MAX_LIST_CACHE) {
              const oldest = this.#lists.keys().next().value
              if (oldest === undefined) break
              this.#lists.delete(oldest)
            }
          }
          return outcome
        })
        .finally(() => this.#listFlights.delete(key))
      this.#listFlights.set(key, flight)
    }
    return { outcome: await flight, cached: false }
  }

  async #fetchList(
    history: HistoryPort,
    providerId: string,
    cwd: string | undefined,
  ): Promise<ListOutcome> {
    try {
      const raw = await this.#withDeadline(this.#cfg.listTimeoutMs, (signal) =>
        history.list({
          limit: LIMITS.maxHistorySessionsPerProvider,
          signal,
          ...(cwd === undefined ? {} : { cwd }),
        }),
      )
      return { kind: 'ok', sessions: this.#validSessions(providerId, history, raw) }
    } catch (error) {
      return this.#failure(providerId, error)
    }
  }

  #validSessions(providerId: string, history: HistoryPort, raw: unknown): HistorySession[] {
    if (!Array.isArray(raw)) return []
    const byId = new Map<string, HistorySession>()
    for (const item of raw.slice(0, LIMITS.maxHistorySessionsPerProvider)) {
      const s = this.#normalizeSession(providerId, history, item as HistorySessionInfo)
      if (s === undefined) continue
      const prev = byId.get(s.sessionId)
      if (prev === undefined || prev.updatedAt < s.updatedAt) byId.set(s.sessionId, s)
    }
    return [...byId.values()]
  }

  #normalizeSession(
    providerId: string,
    history: HistoryPort,
    info: HistorySessionInfo,
  ): HistorySession | undefined {
    if (typeof info !== 'object' || info === null) return undefined
    const base = {
      provider: providerId,
      sessionId: info.sessionId,
      updatedAt: info.updatedAt,
      resumable: info.resumable === true,
      readable: history.canRead,
    }
    const full = {
      ...base,
      ...(info.title === undefined ? {} : { title: info.title }),
      ...(info.cwd === undefined ? {} : { cwd: info.cwd }),
      ...(info.createdAt === undefined ? {} : { createdAt: info.createdAt }),
      ...(info.messageCount === undefined ? {} : { messageCount: info.messageCount }),
    }
    const parsed = HistorySession.safeParse(full)
    if (parsed.success) return parsed.data
    // Un título o una carpeta hostiles no deben esconder la sesión: se prueba sin los campos opcionales.
    const bare = HistorySession.safeParse(base)
    return bare.success ? bare.data : undefined
  }

  #failure(providerId: string, error: unknown): ListOutcome {
    if (error instanceof DeadlineError) {
      return { kind: 'fail', status: 'timeout', reason: 'el proveedor no respondió a tiempo' }
    }
    if (error instanceof HistoryError) {
      if (error.code === 'UNSUPPORTED') {
        return { kind: 'fail', status: 'unsupported', reason: reasonOf(error) }
      }
      if (error.code === 'UNAVAILABLE') {
        return { kind: 'fail', status: 'unavailable', reason: reasonOf(error) }
      }
    }
    this.#deps.logger?.warn('history.list falló', { provider: providerId, error: String(error) })
    return { kind: 'fail', status: 'error', reason: reasonOf(error) }
  }

  // ---- transcripción ----

  async #transcriptFor(
    history: HistoryPort,
    params: MethodParams<'history.read'>,
  ): Promise<Transcript> {
    const key = `${params.provider}|${params.sessionId}`
    const now = this.#deps.clock.now()
    const hit = this.#transcripts.get(key)
    if (hit !== undefined) {
      if (now - hit.at < this.#cfg.readTtlMs) return hit.value
      this.#transcripts.delete(key)
    }
    let flight = this.#readFlights.get(key)
    if (flight === undefined) {
      flight = this.#fetchTranscript(history, params)
        .then((value) => {
          if (!this.#closed) {
            this.#transcripts.set(key, { at: this.#deps.clock.now(), value })
            while (this.#transcripts.size > this.#cfg.maxCachedTranscripts) {
              const oldest = this.#transcripts.keys().next().value
              if (oldest === undefined) break
              this.#transcripts.delete(oldest)
            }
          }
          return value
        })
        .finally(() => this.#readFlights.delete(key))
      this.#readFlights.set(key, flight)
    }
    return flight
  }

  async #fetchTranscript(
    history: HistoryPort,
    params: MethodParams<'history.read'>,
  ): Promise<Transcript> {
    let raw: HistoryTranscript
    try {
      raw = await this.#withDeadline(this.#cfg.readTimeoutMs, (signal) =>
        history.read({
          sessionId: params.sessionId,
          maxBlocks: LIMITS.maxHistoryBlocks,
          signal,
          ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        }),
      )
    } catch (error) {
      throw this.#readError(params, error)
    }
    return this.#normalizeTranscript(raw)
  }

  #normalizeTranscript(raw: HistoryTranscript): Transcript {
    const blocks: HistoryBlock[] = []
    let truncated = raw?.truncated === true
    const items = Array.isArray(raw?.blocks) ? raw.blocks : []
    for (const item of items) {
      if (blocks.length >= LIMITS.maxHistoryBlocks) {
        truncated = true
        break
      }
      const parsed = BlockDraft.safeParse(item?.block)
      if (!parsed.success) {
        truncated = true
        continue
      }
      const turn = Number.isSafeInteger(item.turn) && item.turn >= 0 ? item.turn : 0
      let block: BlockDraft = parsed.data
      if (JSON.stringify(block).length > LIMITS.maxHistoryBlockJsonBytes) {
        truncated = true
        block = {
          type: 'text',
          text: '[bloque omitido: demasiado grande para mostrarlo]',
          complete: true,
          truncated: true,
        }
      }
      blocks.push({ index: blocks.length, turn, block })
    }
    return { blocks, truncated }
  }

  #readError(params: MethodParams<'history.read'>, error: unknown): DomainError {
    if (error instanceof DeadlineError) {
      return new DomainError('PROVIDER_UNAVAILABLE', 'el proveedor no respondió a tiempo')
    }
    if (error instanceof HistoryError) {
      switch (error.code) {
        case 'NOT_FOUND':
          return new DomainError('NOT_FOUND', 'la sesión no existe en el historial del proveedor')
        case 'INVALID':
          return new DomainError('INVALID_PARAMS', 'sesión o carpeta no válidas')
        default:
          return new DomainError('PROVIDER_UNAVAILABLE', reasonOf(error))
      }
    }
    this.#deps.logger?.warn('history.read falló', {
      provider: params.provider,
      error: String(error),
    })
    return new DomainError('PROVIDER_UNAVAILABLE', 'el proveedor falló al leer la sesión')
  }

  // ---- plazos y cancelación ----

  async #withDeadline<T>(ms: number, run: (signal: AbortSignalLike) => Promise<T>): Promise<T> {
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
          }, ms)
          stopper.addEventListener('abort', () => reject(new DeadlineError()))
        }),
      ])
    } catch (error) {
      // Si el plazo o `close()` cancelaron la consulta, ese es el motivo, no el `ABORTED` que lanza el puerto.
      if (stopper.aborted) throw new DeadlineError()
      throw error
    } finally {
      cancelTimer?.()
      this.#stoppers.delete(stopper)
    }
  }
}

class DeadlineError extends Error {
  constructor() {
    super('plazo agotado o cancelado')
    this.name = 'DeadlineError'
  }
}

export type HistoryHandlers = HistoryService['handlers']
