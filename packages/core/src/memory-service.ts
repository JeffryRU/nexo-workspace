import {
  type AgentSessionId,
  type Block,
  type BlockRange,
  LIMITS,
  type MemoryUsageTotals,
  type MethodParams,
  type MethodResult,
  type ProjectMemory,
  type SummarizerUsage,
  utf8ByteLength,
} from '@nexo/contracts'
import type { MemoryHandlers } from './dispatcher.ts'
import { DomainError } from './errors.ts'
import { buildMemoryBlock, escapeMemoryText } from './memory-inject.ts'
import {
  addUsage,
  applyObserved,
  applyReflection,
  markObserved,
  normalizeProjectPath,
  observedThrough,
  priorityRank,
  searchObservations,
} from './memory-model.ts'
import {
  DEFAULT_MEMORY_THRESHOLDS,
  type MemoryThresholds,
  observationTokens,
  reflectionTargetTokens,
  reflectionTokens,
  resolveThresholds,
  shouldObserve,
  shouldReflect,
} from './memory-policy.ts'
import {
  DEFAULT_SELECT_LIMITS,
  pendingObserverTokens,
  recentTurnsFromBlocks,
  selectForObserver,
} from './memory-select.ts'
import { estimateTokens } from './memory-tokens.ts'
import {
  type AbortSignalLike,
  type MemoryStorePort,
  type ObserveRequest,
  type ReflectRequest,
  type SummarizeResponse,
  SummarizerError,
  type SummarizerPort,
} from './ports/memory.ts'
import type { BusEvent, ClockPort, EventBusPort, LoggerPort } from './ports/misc.ts'
import type { Unsubscribe } from './ports/pty.ts'

/** Lo que `MemoryService` necesita de `AgentService`: listar sesiones y leer su documento. */
export type MemorySessionSource = {
  list(): MethodResult<'agent.list'>
  snapshot(params: MethodParams<'agent.snapshot'>): MethodResult<'agent.snapshot'>
}

export type MemoryServiceConfig = {
  /** Esperas entre reintentos de un error `retryable` (ms); su longitud + 1 son los intentos. */
  retryDelaysMs?: readonly number[]
  /** Cuánto queda en pausa la memoria tras agotar los reintentos o si el resumidor no responde (ms). */
  pauseMs?: number
  /** Cuánto se fía de una comprobación de disponibilidad positiva (ms). */
  availabilityTtlMs?: number
  /** Espera tras un Reflector que no logró acortar el registro (ms). */
  reflectCooldownMs?: number
  /** Observaciones recientes que se pasan al Observador como contexto conocido. */
  recentContext?: number
  /** Tope de tokens del bloque que se inyecta al abrir una sesión (4000 por omisión). */
  injectTokens?: number
  /** Tokens de últimos turnos tal cual que se suman al bloque al renovar una sesión (6000 por omisión). */
  seedTurnTokens?: number
}

export type MemoryServiceDeps = {
  store: MemoryStorePort
  /** Sin él (no configurado), la memoria queda en pausa con `pausedReason`. */
  summarizer?: SummarizerPort
  /** Texto con el que `memory.status` muestra el resumidor (`ollama:llama3.2:3b`); por omisión, `summarizer.id`. */
  summarizerLabel?: string
  /** Motivo fijo de la pausa cuando no hay resumidor. */
  pausedReason?: string
  /** Sesiones de agente; sin ellas el servicio no observa nada ni puede hacer `memory.recall`. */
  sessions?: MemorySessionSource
  bus: EventBusPort
  clock: ClockPort
  logger?: LoggerPort
  /** `false` (por omisión en el daemon): no escucha ni llama al resumidor; los métodos solo leen lo guardado. */
  enabled: boolean
  /** Contexto estimado a partir del cual una sesión se renueva sola (F3.5.3); sin él, renovación automática apagada. */
  renewAtTokens?: number
  /**
   * Guarda los ajustes de `memory.configure` (el daemon los persiste). Si lanza, no se aplican y el método falla.
   * Sin él, los ajustes solo viven mientras viva el servicio.
   */
  onSettings?: (settings: { enabled: boolean; renewAtTokens: number | undefined }) => Promise<void>
  thresholds?: Partial<MemoryThresholds>
  config?: MemoryServiceConfig
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 40_000] as const
const DEFAULT_PAUSE_MS = 60_000
const DEFAULT_AVAILABILITY_TTL_MS = 60_000
const DEFAULT_REFLECT_COOLDOWN_MS = 10 * 60_000
const DEFAULT_RECENT_CONTEXT = 12
const DEFAULT_INJECT_TOKENS = 4_000
const DEFAULT_SEED_TURN_TOKENS = 6_000
const MAX_BATCHES_PER_DRAIN = 20
const MAX_REFLECT_ROUNDS = 3
const MAX_OBSERVATIONS_PER_BATCH = 20
/** Páginas de `agent.snapshot` que se leen en una pasada (200 bloques cada una). */
const MAX_SNAPSHOT_PAGES = 60
/** Bytes de texto original que devuelve `memory.recall`. */
export const RECALL_MAX_BYTES = 512 * 1024
const DEFAULT_LIST_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 20

const zeroTotals = (): MemoryUsageTotals => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
})

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

type SessionInfo = {
  project: string
  /** Tamaño (caracteres) de lo ya visto por evento de cada bloque desde la última comprobación. */
  sizes: Map<string, number>
  dirty: number
}

type ProjectQueue = { running: boolean; pending: Set<AgentSessionId> }

type Call =
  | { kind: 'ok'; response: SummarizeResponse }
  | { kind: 'paused' }
  | { kind: 'stopped' }
  | { kind: 'invalid'; error: SummarizerError }

function blockSize(block: Block): number {
  switch (block.type) {
    case 'user':
    case 'text':
    case 'reasoning':
      return block.text.length
    case 'action':
      return (block.output?.length ?? 0) + (block.input?.length ?? 0) + block.title.length
    case 'error':
      return block.message.length
    default:
      return 0
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : 'error').slice(0, 200)
}

/**
 * Memoria observacional en el daemon (F3.5.2, ADR 0007). Escucha el documento de cada sesión de agente
 * (los eventos `agent.block`/`agent.status` del bus) y, **en segundo plano**, llama al Observador cuando una
 * sesión acumula tokens nuevos y al Reflector cuando las observaciones del proyecto pasan del umbral. Las
 * reglas (lotes, rangos, aplicar, umbrales) son las de `core`; este servicio solo las orquesta.
 *
 * - **No toca el streaming**: el suscriptor del bus solo suma contadores. Todo lo demás (leer el documento,
 *   llamar al resumidor, guardar) ocurre fuera del manejador, en una cola por proyecto.
 * - **Una llamada en curso por proyecto** (cola en serie); proyectos distintos van en paralelo.
 * - **Sin repetir**: cada lote empieza en `observedThrough + 1` y el progreso avanza al guardar.
 * - **Reintentos acotados**: un error `retryable` se reintenta con espera creciente; si se agotan, o si el
 *   resumidor no está disponible, la memoria queda en pausa (`pausedReason` en `memory.status`) y el lote
 *   sigue pendiente. Un lote cuya salida es inutilizable se descarta tras dos intentos, para no atascarse.
 * - **Cancelación**: `stop()` aborta la llamada en curso y las esperas, y espera a que la cola termine.
 */
export class MemoryService {
  readonly #d: MemoryServiceDeps
  readonly #thresholds: MemoryThresholds
  readonly #retryDelays: readonly number[]
  readonly #pauseMs: number
  readonly #ttlMs: number
  readonly #cooldownMs: number
  readonly #recent: number
  readonly #injectTokens: number
  readonly #seedTurnTokens: number
  readonly #stopper = new Stopper()
  readonly #sessions = new Map<AgentSessionId, SessionInfo>()
  readonly #queues = new Map<string, ProjectQueue>()
  readonly #inflight = new Set<Promise<void>>()
  readonly #invalid = new Map<string, number>()
  readonly #reflectCooldown = new Map<string, number>()
  readonly #roles = { observer: zeroTotals(), reflector: zeroTotals() }
  #off: Unsubscribe | undefined
  #enabled: boolean
  #renewAtTokens: number | undefined
  #configuring: Promise<unknown> = Promise.resolve()
  #running = false
  #pausedUntil = 0
  #pausedReason: string | undefined
  #okUntil = 0

  constructor(deps: MemoryServiceDeps) {
    this.#d = deps
    this.#enabled = deps.enabled
    this.#renewAtTokens = deps.renewAtTokens
    this.#thresholds = resolveThresholds(deps.thresholds ?? DEFAULT_MEMORY_THRESHOLDS)
    const c = deps.config ?? {}
    this.#retryDelays = c.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.#pauseMs = c.pauseMs ?? DEFAULT_PAUSE_MS
    this.#ttlMs = c.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS
    this.#cooldownMs = c.reflectCooldownMs ?? DEFAULT_REFLECT_COOLDOWN_MS
    this.#recent = c.recentContext ?? DEFAULT_RECENT_CONTEXT
    this.#injectTokens = c.injectTokens ?? DEFAULT_INJECT_TOKENS
    this.#seedTurnTokens = c.seedTurnTokens ?? DEFAULT_SEED_TURN_TOKENS
  }

  /** Los manejadores de `memory.*` para `createDispatcher({ memory })`. */
  readonly handlers: MemoryHandlers = {
    'memory.status': (p) => this.status(p),
    'memory.list': (p) => this.list(p),
    'memory.search': (p) => this.search(p),
    'memory.recall': (p) => this.recall(p),
    'memory.configure': (p) => this.configure(p),
  }

  /** Umbral de renovación automática vigente (`undefined` = apagada); lo consulta `AgentService`. */
  renewAtTokens(): number | undefined {
    return this.#enabled ? this.#renewAtTokens : undefined
  }

  /** Empieza a escuchar el bus (si la memoria está activada). Idempotente. */
  start(): void {
    if (this.#running || !this.#enabled || this.#stopper.aborted) return
    this.#running = true
    this.#off = this.#d.bus.subscribe((event) => this.#onEvent(event))
    try {
      for (const s of this.#d.sessions?.list().sessions ?? []) this.#learn(s.id, s.cwd)
    } catch (error) {
      this.#d.logger?.warn('memoria: no se pudieron listar las sesiones', { error })
    }
    // Comprueba pronto el resumidor para que `memory.status` explique una pausa sin esperar a la primera sesión.
    this.#track(
      this.#ready().then(
        () => {},
        () => {},
      ),
    )
  }

  /**
   * Ajustes en caliente (`memory.configure`). Las llamadas se encolan (una a la vez); se guarda primero y se
   * aplica después, así que un fallo al guardar no deja el servicio a medias. Al apagar, deja de escuchar el bus;
   * una llamada ya en curso al resumidor termina sola (acotada por sus propios plazos).
   */
  configure(params: MethodParams<'memory.configure'>): Promise<MethodResult<'memory.configure'>> {
    const run = this.#configuring.then(async () => {
      const enabled = params.enabled ?? this.#enabled
      const renew =
        params.renewAtTokens === undefined
          ? this.#renewAtTokens
          : (params.renewAtTokens ?? undefined)
      if (this.#d.onSettings !== undefined) {
        try {
          await this.#d.onSettings({ enabled, renewAtTokens: renew })
        } catch (error) {
          this.#d.logger?.error('memoria: no se pudieron guardar los ajustes', { error })
          throw new DomainError('INTERNAL', 'no se pudieron guardar los ajustes de la memoria')
        }
      }
      this.#renewAtTokens = renew
      if (enabled !== this.#enabled) {
        this.#enabled = enabled
        if (enabled) this.start()
        else this.#listenOff()
      }
      return {
        enabled: this.#enabled,
        ...(renew === undefined ? {} : { renewAtTokens: renew }),
      }
    })
    this.#configuring = run.catch(() => undefined)
    return run
  }

  #listenOff(): void {
    this.#running = false
    this.#off?.()
    this.#off = undefined
    this.#sessions.clear()
  }

  /** Hay trabajo de fondo en curso (comprobaciones, llamadas al resumidor, esperas de reintento). */
  get busy(): boolean {
    return this.#inflight.size > 0
  }

  /** Cancela lo que esté en curso y espera a que las colas terminen. Idempotente. */
  async stop(): Promise<void> {
    this.#running = false
    this.#off?.()
    this.#off = undefined
    this.#stopper.abort()
    await Promise.allSettled([...this.#inflight])
  }

  // ---- Métodos ----

  async status(params: MethodParams<'memory.status'>): Promise<MethodResult<'memory.status'>> {
    const summarizer = this.#d.summarizerLabel ?? this.#d.summarizer?.id
    const pausedReason = this.#activePause()
    const o = this.#roles.observer
    const r = this.#roles.reflector
    const total: MemoryUsageTotals = {
      calls: o.calls + r.calls,
      inputTokens: o.inputTokens + r.inputTokens,
      outputTokens: o.outputTokens + r.outputTokens,
      costUsd: o.costUsd + r.costUsd,
    }
    let project: MethodResult<'memory.status'>['project']
    let projectUsage: MemoryUsageTotals | undefined
    if (params.cwd !== undefined) {
      const memory = await this.#d.store.load(normalizeProjectPath(params.cwd))
      project = {
        cwd: memory.project,
        observations: memory.observations.length,
        observationTokens: observationTokens(memory),
        reflectionTokens: reflectionTokens(memory),
        generation: memory.reflection?.generation ?? 0,
        sessions: memory.sessions.length,
        updatedAt: memory.updatedAt,
      }
      projectUsage = memory.usage
    }
    return {
      enabled: this.#enabled,
      ...(summarizer === undefined ? {} : { summarizer: summarizer.slice(0, 256) }),
      thresholds: {
        observerBatchTokens: this.#thresholds.observerBatchTokens,
        reflectorTokens: this.#thresholds.reflectorTokens,
      },
      ...(this.#enabled && pausedReason !== undefined ? { pausedReason } : {}),
      ...(project === undefined ? {} : { project }),
      usage: total,
      roles: { observer: { ...o }, reflector: { ...r } },
      ...(projectUsage === undefined ? {} : { projectUsage }),
      ...(this.#renewAtTokens === undefined ? {} : { renewAtTokens: this.#renewAtTokens }),
    }
  }

  async list(params: MethodParams<'memory.list'>): Promise<MethodResult<'memory.list'>> {
    const memory = await this.#d.store.load(normalizeProjectPath(params.cwd))
    const limit = Math.min(params.limit ?? DEFAULT_LIST_LIMIT, LIMITS.maxMemoryPage)
    const min = params.minPriority === undefined ? 0 : priorityRank(params.minPriority)
    const from = params.fromSeq ?? 1
    const matching = memory.observations.filter(
      (o) =>
        o.seq >= from &&
        (params.scope === undefined || o.scope === params.scope) &&
        priorityRank(o.priority) >= min,
    )
    const page = matching.slice(0, limit)
    const next = matching[limit]
    return {
      reflection: params.fromSeq === undefined ? memory.reflection : null,
      observations: page,
      nextSeq: next === undefined ? null : next.seq,
    }
  }

  async search(params: MethodParams<'memory.search'>): Promise<MethodResult<'memory.search'>> {
    const memory = await this.#d.store.load(normalizeProjectPath(params.cwd))
    const limit = Math.min(params.limit ?? DEFAULT_SEARCH_LIMIT, LIMITS.maxMemoryPage)
    const { matches, truncated } = searchObservations(memory.observations, params.query, limit)
    return { observations: matches, truncated }
  }

  /**
   * Texto original de un rango de bloques de una sesión **abierta** (el documento vive en memoria mientras la
   * sesión exista). Pasa de `RECALL_MAX_BYTES`: devuelve los primeros bloques y `truncated: true`.
   */
  recall(params: MethodParams<'memory.recall'>): MethodResult<'memory.recall'> {
    const sessions = this.#d.sessions
    if (sessions === undefined) {
      throw new DomainError('PROVIDER_UNAVAILABLE', 'no hay sesiones de agente configuradas')
    }
    const { from, to } = params.range
    const blocks: Block[] = []
    let bytes = 0
    let truncated = false
    let next: number | null = from
    for (let page = 0; next !== null && page < MAX_SNAPSHOT_PAGES && !truncated; page++) {
      const snap = sessions.snapshot({ sessionId: params.sessionId, fromIndex: next })
      for (const block of snap.blocks) {
        if (block.index > to) {
          next = null
          break
        }
        if (block.index < from) continue
        const size = utf8ByteLength(JSON.stringify(block))
        if (blocks.length > 0 && bytes + size > RECALL_MAX_BYTES) {
          truncated = true
          break
        }
        bytes += size
        blocks.push(block)
        if (blocks.length >= LIMITS.maxRecallBlocks) {
          truncated = block.index < to
          next = null
          break
        }
      }
      if (next !== null) next = snap.nextIndex
    }
    return { blocks, truncated }
  }

  // ---- Inyección (ADR 0007, punto 4; la usa AgentService) ----

  /**
   * Bloque de memoria para una sesión nueva en `cwd`: reflexión y observaciones del proyecto (las de alcance
   * `session` no, porque la sesión aún no existe). `null` con la memoria apagada, sin nada que inyectar o si el
   * almacén falla: la memoria nunca impide abrir una sesión.
   */
  async newSession(cwd: string): Promise<string | null> {
    if (!this.#enabled) return null
    return this.#block(cwd, {})
  }

  /** Bloque para renovar una sesión: lo anterior más sus últimos turnos tal cual. */
  async renewal(
    cwd: string,
    sessionId: AgentSessionId,
    blocks: readonly Block[],
  ): Promise<string | null> {
    if (!this.#enabled) return null
    const recentTurns = recentTurnsFromBlocks(blocks, this.#seedTurnTokens)
    return this.#block(cwd, { sessionId, recentTurns, extraTokens: this.#seedTurnTokens })
  }

  async #block(
    cwd: string,
    o: {
      sessionId?: AgentSessionId
      recentTurns?: { role: 'usuario' | 'agente'; text: string }[]
      extraTokens?: number
    },
  ): Promise<string | null> {
    try {
      const memory = await this.#d.store.load(normalizeProjectPath(cwd))
      const block = buildMemoryBlock(memory, {
        maxTokens: this.#injectTokens + (o.extraTokens ?? 0),
        ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }),
        ...(o.recentTurns === undefined ? {} : { recentTurns: o.recentTurns }),
      })
      return block?.text ?? null
    } catch (error) {
      this.#d.logger?.warn('memoria: no se pudo armar el bloque a inyectar', { error })
      return null
    }
  }

  // ---- Bus ----

  #learn(id: AgentSessionId, cwd: string): SessionInfo {
    const project = normalizeProjectPath(cwd)
    let info = this.#sessions.get(id)
    if (info === undefined) {
      info = { project, sizes: new Map(), dirty: 0 }
      this.#sessions.set(id, info)
    } else info.project = project
    return info
  }

  #forget(id: AgentSessionId): void {
    this.#sessions.delete(id)
    for (const key of this.#invalid.keys()) if (key.startsWith(`${id}:`)) this.#invalid.delete(key)
  }

  #onEvent(event: BusEvent): void {
    if (!this.#running) return
    switch (event.event) {
      case 'agent.session': {
        const data = event.data
        if ('removed' in data) this.#forget(data.sessionId)
        else this.#learn(data.session.id, data.session.cwd)
        break
      }
      case 'agent.block': {
        const info = this.#infoFor(event.data.sessionId)
        if (info === undefined) break
        const block = event.data.block
        const size = blockSize(block)
        const before = info.sizes.get(block.id) ?? 0
        if (size > before) {
          info.dirty += size - before
          info.sizes.set(block.id, size)
        }
        // 2 caracteres por token: se avisa antes de llegar al lote, la cuenta exacta la hace la cola.
        if (info.dirty >= this.#thresholds.observerBatchTokens * 2)
          this.#schedule(event.data.sessionId, info)
        break
      }
      case 'agent.status': {
        if (event.data.status !== 'idle') break
        const info = this.#sessions.get(event.data.sessionId)
        if (info !== undefined && info.dirty > 0) this.#schedule(event.data.sessionId, info)
        break
      }
      default:
        break
    }
  }

  #infoFor(id: AgentSessionId): SessionInfo | undefined {
    const known = this.#sessions.get(id)
    if (known !== undefined) return known
    try {
      const s = this.#d.sessions?.list().sessions.find((x) => x.id === id)
      return s === undefined ? undefined : this.#learn(s.id, s.cwd)
    } catch {
      return undefined
    }
  }

  // ---- Cola por proyecto ----

  #track(promise: Promise<void>): void {
    this.#inflight.add(promise)
    void promise.finally(() => this.#inflight.delete(promise))
  }

  #schedule(id: AgentSessionId, info: SessionInfo): void {
    info.dirty = 0
    info.sizes.clear()
    let q = this.#queues.get(info.project)
    if (q === undefined) {
      q = { running: false, pending: new Set() }
      this.#queues.set(info.project, q)
    }
    q.pending.add(id)
    if (q.running) return
    q.running = true
    const project = info.project
    // Fuera del manejador del bus: lo que sigue nunca corre dentro de la publicación de un evento.
    const run = Promise.resolve()
      .then(() => this.#drain(project, q))
      .catch((error: unknown) => this.#d.logger?.error('memoria: fallo en la cola', { error }))
      .finally(() => {
        q.running = false
      })
    this.#track(run)
  }

  async #drain(project: string, q: ProjectQueue): Promise<void> {
    while (!this.#stopper.aborted) {
      const ids = [...q.pending]
      q.pending.clear()
      if (ids.length === 0) break
      if (!(await this.#ready())) break
      for (const id of ids) {
        if (this.#stopper.aborted) return
        try {
          // Con un documento larguísimo, tras `MAX_BATCHES_PER_DRAIN` lotes cede el turno a las demás sesiones.
          if (await this.#observeSession(project, id)) q.pending.add(id)
        } catch (error) {
          this.#d.logger?.warn('memoria: no se pudo observar una sesión', { error })
        }
      }
      try {
        await this.#reflectIfNeeded(project)
      } catch (error) {
        this.#d.logger?.warn('memoria: no se pudo reflexionar', { error })
      }
    }
    if (q.pending.size === 0) this.#queues.delete(project)
  }

  // ---- Resumidor ----

  #activePause(): string | undefined {
    if (this.#d.summarizer === undefined)
      return this.#d.pausedReason ?? 'no hay resumidor configurado'
    return this.#pausedUntil > this.#d.clock.now() ? this.#pausedReason : undefined
  }

  #pause(reason: string): void {
    this.#pausedUntil = this.#d.clock.now() + this.#pauseMs
    this.#pausedReason = reason.slice(0, 256)
    this.#okUntil = 0
    this.#d.logger?.warn('memoria en pausa', { reason: this.#pausedReason })
  }

  async #ready(): Promise<boolean> {
    const summarizer = this.#d.summarizer
    if (summarizer === undefined) return false
    const now = this.#d.clock.now()
    if (this.#pausedUntil > now) return false
    if (this.#okUntil > now) return true
    let ok = false
    try {
      ok = await summarizer.isAvailable()
    } catch {
      ok = false
    }
    if (this.#stopper.aborted) return false
    if (!ok) {
      this.#pause(`el resumidor ${this.#d.summarizerLabel ?? summarizer.id} no está disponible`)
      return false
    }
    this.#okUntil = this.#d.clock.now() + this.#ttlMs
    this.#pausedReason = undefined
    return true
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        off()
        this.#stopper.removeEventListener('abort', done)
        resolve()
      }
      const off = this.#d.clock.setTimeout(done, ms)
      this.#stopper.addEventListener('abort', done)
    })
  }

  /** Llama al resumidor con reintentos acotados; no lanza. */
  async #call(request: ObserveRequest | ReflectRequest): Promise<Call> {
    const summarizer = this.#d.summarizer
    if (summarizer === undefined) return { kind: 'paused' }
    const attempts = this.#retryDelays.length + 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.#stopper.aborted) return { kind: 'stopped' }
      try {
        const response = await summarizer.summarize(request, { signal: this.#stopper })
        if (response.kind !== request.kind) {
          return {
            kind: 'invalid',
            error: new SummarizerError('INVALID_OUTPUT', 'respuesta de otro tipo'),
          }
        }
        return { kind: 'ok', response }
      } catch (e) {
        if (this.#stopper.aborted) return { kind: 'stopped' }
        const error =
          e instanceof SummarizerError
            ? e
            : new SummarizerError('INVALID_OUTPUT', `fallo inesperado: ${errorText(e)}`, {
                cause: e,
                retryable: false,
              })
        if (error.code === 'ABORTED') return { kind: 'stopped' }
        if (error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT') {
          const delay = this.#retryDelays[attempt]
          if (error.retryable && delay !== undefined) {
            await this.#sleep(delay)
            continue
          }
          this.#pause(`el resumidor falló: ${errorText(error)}`)
          return { kind: 'paused' }
        }
        return { kind: 'invalid', error }
      }
    }
    return { kind: 'paused' }
  }

  #addRole(role: 'observer' | 'reflector', usage: SummarizerUsage): void {
    const t = this.#roles[role]
    t.calls += 1
    t.inputTokens += usage.inputTokens ?? 0
    t.outputTokens += usage.outputTokens ?? 0
    t.costUsd += usage.costUsd ?? 0
  }

  // ---- Observador ----

  /** Lee los bloques de una sesión desde `from`; `undefined` si la sesión ya no existe. */
  #fetchBlocks(id: AgentSessionId, from: number): Block[] | undefined {
    const sessions = this.#d.sessions
    if (sessions === undefined) return undefined
    const blocks: Block[] = []
    let next: number | null = from
    try {
      for (let page = 0; next !== null && page < MAX_SNAPSHOT_PAGES; page++) {
        const snap = sessions.snapshot({ sessionId: id, fromIndex: next })
        blocks.push(...snap.blocks)
        next = snap.nextIndex
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'NOT_FOUND') return undefined
      throw error
    }
    return blocks
  }

  /** Observa lotes de la sesión mientras haya tokens de sobra; `true` si aún queda trabajo tras el tope de lotes. */
  async #observeSession(project: string, id: AgentSessionId): Promise<boolean> {
    for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch++) {
      if (this.#stopper.aborted) return false
      const memory = await this.#d.store.load(project)
      const through = observedThrough(memory, id)
      const blocks = this.#fetchBlocks(id, through + 1)
      if (blocks === undefined) {
        this.#forget(id)
        return false
      }
      if (!shouldObserve(pendingObserverTokens(blocks, through), this.#thresholds)) return false
      const input = selectForObserver(blocks, through, {
        ...DEFAULT_SELECT_LIMITS,
        maxBatchTokens: this.#thresholds.maxBatchTokens,
      })
      if (input === null) return false
      const request: ObserveRequest = {
        kind: 'observe',
        project,
        sessionId: id,
        range: input.range,
        transcript: input.transcript,
        known: {
          reflection: memory.reflection === null ? null : escapeMemoryText(memory.reflection.text),
          recent: memory.observations.slice(-this.#recent).map((o) => escapeMemoryText(o.text)),
        },
        now: this.#d.clock.now(),
        maxObservations: MAX_OBSERVATIONS_PER_BATCH,
      }
      const call = await this.#call(request)
      if (call.kind === 'paused' || call.kind === 'stopped') return false
      const key = `${id}:${input.range.from}`
      if (call.kind === 'invalid') {
        const failures = (this.#invalid.get(key) ?? 0) + 1
        if (failures < 2) {
          this.#invalid.set(key, failures)
          this.#d.logger?.warn('memoria: salida inutilizable del Observador', {
            error: call.error.message,
          })
          return false
        }
        this.#invalid.delete(key)
        this.#d.logger?.warn('memoria: lote descartado tras dos salidas inutilizables', {
          sessionId: id,
          range: input.range,
        })
        await this.#commitObserved(project, id, input.range, undefined)
        continue
      }
      this.#invalid.delete(key)
      await this.#commitObserved(project, id, input.range, call.response)
    }
    return true
  }

  /** Guarda el lote: con respuesta, las observaciones y el uso; sin ella, solo avanza el progreso. */
  async #commitObserved(
    project: string,
    id: AgentSessionId,
    range: BlockRange,
    response: SummarizeResponse | undefined,
  ): Promise<void> {
    const now = this.#d.clock.now()
    const memory = await this.#d.store.update(project, (m) =>
      response === undefined || response.kind !== 'observe'
        ? markObserved(m, id, range.to, now)
        : applyObserved(m, {
            sessionId: id,
            range,
            content: response.content,
            usage: response.usage,
            now,
          }),
    )
    if (response?.kind === 'observe') this.#addRole('observer', response.usage)
    this.#publish(project, 'observe', memory)
  }

  // ---- Reflector ----

  async #reflectIfNeeded(project: string): Promise<void> {
    for (let round = 0; round < MAX_REFLECT_ROUNDS; round++) {
      if (this.#stopper.aborted) return
      const memory = await this.#d.store.load(project)
      if (!shouldReflect(memory, this.#thresholds)) return
      if ((this.#reflectCooldown.get(project) ?? 0) > this.#d.clock.now()) return
      const chosen: ProjectMemory['observations'] = []
      let tokens = 0
      const budget = this.#thresholds.reflectorTokens
      for (const o of memory.observations) {
        const cost = estimateTokens(o.text) + 8
        if (chosen.length > 0 && tokens + cost > budget) break
        chosen.push(o)
        tokens += cost
      }
      const last = chosen[chosen.length - 1]
      if (last === undefined) return
      const request: ReflectRequest = {
        kind: 'reflect',
        project,
        reflection: memory.reflection,
        observations: chosen,
        targetTokens: reflectionTargetTokens(this.#thresholds),
        coversThroughSeq: last.seq,
        now: this.#d.clock.now(),
      }
      const call = await this.#call(request)
      if (call.kind === 'paused' || call.kind === 'stopped') return
      if (call.kind === 'invalid' || call.response.kind !== 'reflect') {
        this.#reflectCooldown.set(project, this.#d.clock.now() + this.#cooldownMs)
        this.#d.logger?.warn('memoria: salida inutilizable del Reflector')
        return
      }
      const { text, usage } = call.response
      const now = this.#d.clock.now()
      let applied = false
      const updated = await this.#d.store.update(project, (m) => {
        const result = applyReflection(m, { text, coversThroughSeq: last.seq }, now)
        applied = result.ok
        return addUsage(result.ok ? result.memory : m, usage, now)
      })
      this.#addRole('reflector', usage)
      if (!applied) {
        this.#reflectCooldown.set(project, this.#d.clock.now() + this.#cooldownMs)
        this.#d.logger?.warn('memoria: el Reflector no acortó el registro; se descarta su salida')
        return
      }
      this.#publish(project, 'reflect', updated)
    }
  }

  #publish(project: string, kind: 'observe' | 'reflect', memory: ProjectMemory): void {
    this.#d.bus.publish({
      event: 'memory.updated',
      data: {
        cwd: project,
        kind,
        observations: memory.observations.length,
        generation: memory.reflection?.generation ?? 0,
        updatedAt: memory.updatedAt,
      },
    })
  }
}
