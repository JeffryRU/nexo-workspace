import {
  type AgentSession,
  type AgentSessionId,
  applyBlockDelta,
  type Block,
  type BlockDraft,
  type BlockId,
  blockIssues,
  LIMITS,
  type MethodParams,
  type MethodResult,
  type PaneId,
  ProviderCapabilities,
  ProviderEvent,
  ProviderInfo,
  ProviderSessionToken,
  sanitizeBodyText,
  truncateUtf8,
  utf8ByteLength,
  validateAnswers,
} from '@nexo/contracts'
import type { AgentHandlers } from './dispatcher.ts'
import { DomainError } from './errors.ts'
import type { AgentPaneDirectory } from './layout-service.ts'
import { OutputBatcher } from './output-batcher.ts'
import {
  AgentProviderError,
  type AgentProviderPort,
  type AgentProviderSession,
} from './ports/agent.ts'
import type { ClockPort, EventBusPort, IdPort, LoggerPort } from './ports/misc.ts'
import type { Unsubscribe } from './ports/pty.ts'

export type AgentServiceConfig = {
  /** Sesiones de agente a la vez (por omisión `LIMITS.maxAgentSessions`). */
  maxSessions?: number
  /** Bloques por sesión (por omisión `LIMITS.maxBlocksPerSession`). */
  maxBlocksPerSession?: number
  /** Posiciones al final del documento que solo usan permisos, preguntas, errores y uso. */
  reservedBlocks?: number
  /** Intervalo de agrupación de deltas. */
  batchMs?: number
  /** Tamaño máximo de un `agent.delta` (bytes UTF-8). */
  maxDeltaBytes?: number
  /** Tamaño máximo de un mensaje; los bloques se recortan para caber. */
  maxMessageBytes?: number
  /** Eventos inválidos seguidos tras los cuales la sesión pasa a `error`. */
  maxConsecutiveInvalid?: number
  /** Espera tras `interrupt` antes de dar la sesión por perdida si el turno no termina. */
  interruptTimeoutMs?: number
}

export type AgentServiceDeps = {
  providers: readonly AgentProviderPort[]
  bus: EventBusPort
  clock: ClockPort
  ids: IdPort
  panes: AgentPaneDirectory
  logger?: LoggerPort
  config?: AgentServiceConfig
}

export type AgentStats = {
  /** Eventos del proveedor descartados por inválidos (esquema, orden o `ref` desconocida). */
  invalidEvents: number
  /** Bloques que no cupieron en el documento (tope blando). */
  droppedBlocks: number
  /** Deltas descartados (bloque ya recortado, o campo que no corresponde). */
  droppedDeltas: number
}

export const DEFAULT_AGENT_BATCH_MS = 16
export const DEFAULT_RESERVED_BLOCKS = 8
export const DEFAULT_MAX_CONSECUTIVE_INVALID = 20
export const DEFAULT_INTERRUPT_TIMEOUT_MS = 5000
/** Margen del sobre del mensaje (versión, nombre del evento, sesión...) sobre el bloque serializado. */
const ENVELOPE_MARGIN = 8 * 1024
const MAX_DROPPED_REFS = 1024
const MAX_TOMBSTONES = 256

type Request = { blockId: BlockId; kind: 'permission' | 'question' }

type Entry = {
  id: AgentSessionId
  provider: AgentProviderSession
  providerId: string
  paneId: PaneId
  providerSessionId?: string
  title?: string
  model?: string
  effort?: string
  permissionMode: AgentSession['permissionMode']
  cwd: string
  status: AgentSession['status']
  reason?: string
  turn: number
  createdAt: number
  updatedAt: number
  blocks: Block[]
  byId: Map<BlockId, number>
  /** `ref` del proveedor de los bloques abiertos. */
  refs: Map<string, BlockId>
  droppedRefs: Set<string>
  requests: Map<string, Request>
  cancelledRequests: Set<string>
  responding: Set<BlockId>
  active: boolean
  dead: boolean
  closing: boolean
  turnUsage?: Extract<ProviderEvent, { type: 'usage' }>['usage']
  batcher: OutputBatcher
  target?: { blockId: BlockId; field: 'text' | 'output' }
  watchdog?: Unsubscribe
  offEvents?: Unsubscribe
  stats: AgentStats
  invalidStreak: number
}

/** Un mensaje de una sola línea para `reason` (sin control ni sustitutos sueltos). */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

function oneLine(text: string, max = 200): string {
  let clean = ''
  for (const ch of sanitizeBodyText(text)) clean += isControl(ch.charCodeAt(0)) ? ' ' : ch
  const cut = truncateUtf8(clean.trim(), max)
  return cut.length === 0 ? 'error' : cut
}

function bodyMessage(text: string): string {
  const cut = truncateUtf8(sanitizeBodyText(text), 8 * 1024)
  return cut.length === 0 ? 'error' : cut
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'error desconocido'
}

function mapProviderError(error: unknown): DomainError {
  if (error instanceof DomainError) return error
  if (error instanceof AgentProviderError) {
    switch (error.code) {
      case 'UNAVAILABLE':
        return new DomainError('PROVIDER_UNAVAILABLE', oneLine(error.message))
      case 'INVALID_OPTIONS':
        return new DomainError('INVALID_PARAMS', oneLine(error.message))
      case 'BUSY':
      case 'CLOSED':
      case 'UNKNOWN_REQUEST':
        return new DomainError('CONFLICT', oneLine(error.message))
      default:
        return new DomainError('INTERNAL', oneLine(error.message))
    }
  }
  return new DomainError('INTERNAL', 'falló el proveedor de agente')
}

const jsonBytes = (value: unknown): number => utf8ByteLength(JSON.stringify(value))

type Cut = { size: number; apply: (bytes: number) => Block }

/** Campos de texto recortables de un bloque, con lo que hace falta para recortarlos. */
function cuts(block: Block): Cut[] {
  const out: Cut[] = []
  const flag = block.type === 'text' || block.type === 'reasoning' || block.type === 'action'
  const record = block as Record<string, unknown>
  for (const key of ['text', 'output', 'input', 'detail', 'markdown']) {
    const value = record[key]
    if (typeof value !== 'string' || value.length === 0) continue
    out.push({
      size: utf8ByteLength(value),
      apply: (bytes) =>
        ({
          ...block,
          [key]: truncateUtf8(value, bytes),
          ...(flag ? { truncated: true } : {}),
        }) as Block,
    })
  }
  if (block.type === 'action' && block.diff !== undefined) {
    const { diff } = block
    out.push({
      size: utf8ByteLength(diff.patch),
      apply: (bytes) =>
        ({
          ...block,
          diff: { ...diff, patch: truncateUtf8(diff.patch, bytes) },
          truncated: true,
        }) as Block,
    })
  }
  return out
}

/**
 * Recorta los campos de texto más grandes (sin partir caracteres) hasta que el bloque serializado cabe en
 * `limit`. Cada byte UTF-8 ocupa al menos un byte en JSON, así que quitar `exceso` bytes de texto basta.
 */
export function fitBlock(block: Block, limit: number): Block {
  let current = block
  for (let i = 0; i < 8; i++) {
    const size = jsonBytes(current)
    if (size <= limit) return current
    const excess = size - limit
    const biggest = cuts(current).sort((a, b) => b.size - a.size)[0]
    if (biggest === undefined || biggest.size === 0) return current
    current = biggest.apply(Math.max(0, biggest.size - excess))
  }
  return current
}

const FALLBACK_CAPABILITIES: ProviderCapabilities = {
  models: [],
  efforts: [],
  permissionModes: ['ask'],
  resume: false,
  warmup: false,
  streaming: false,
}

/**
 * Sesiones de agente del daemon. Normaliza lo que emite el proveedor (`ProviderEvent`) en un documento de
 * bloques con `id`, `index` sin huecos, `turn` y `seq`; agrupa los deltas por lote; convierte solicitudes de
 * permiso y preguntas en bloques que se resuelven con `agent.respond`; y mantiene el estado de atención de la
 * sesión (y del panel). Un evento inválido del proveedor se descarta y se cuenta; demasiados seguidos
 * cierran la sesión en `error`.
 *
 * Ciclo de vida de una sesión: `idle` → (`send`) `working` ⇄ `needs-input` → (`turn-end`) `done`/`idle`/`error`.
 * `exit` sin pedirlo, un error fatal o un proveedor que no cumple el protocolo la dejan en `error` (legible,
 * sin más turnos) hasta `agent.close`, que la quita.
 */
export class AgentService {
  readonly #deps: AgentServiceDeps
  readonly #providers = new Map<string, AgentProviderPort>()
  readonly #sessions = new Map<AgentSessionId, Entry>()
  readonly #opening = new Set<PaneId>()
  readonly #maxSessions: number
  readonly #maxBlocks: number
  readonly #reserved: number
  readonly #batchMs: number
  readonly #maxDeltaBytes: number
  readonly #blockLimit: number
  readonly #maxInvalid: number
  readonly #interruptTimeoutMs: number

  constructor(deps: AgentServiceDeps) {
    this.#deps = deps
    for (const p of deps.providers) this.#providers.set(p.id, p)
    const c = deps.config ?? {}
    this.#maxSessions = c.maxSessions ?? LIMITS.maxAgentSessions
    this.#maxBlocks = Math.min(
      c.maxBlocksPerSession ?? LIMITS.maxBlocksPerSession,
      LIMITS.maxBlocksPerSession,
    )
    this.#reserved = Math.min(
      c.reservedBlocks ?? DEFAULT_RESERVED_BLOCKS,
      Math.floor(this.#maxBlocks / 2),
    )
    this.#batchMs = c.batchMs ?? DEFAULT_AGENT_BATCH_MS
    this.#maxDeltaBytes = Math.min(c.maxDeltaBytes ?? LIMITS.maxDeltaBytes, LIMITS.maxDeltaBytes)
    const maxMessage = c.maxMessageBytes ?? LIMITS.maxMessageBytes
    this.#blockLimit = Math.max(1024, maxMessage - ENVELOPE_MARGIN)
    this.#maxInvalid = c.maxConsecutiveInvalid ?? DEFAULT_MAX_CONSECUTIVE_INVALID
    this.#interruptTimeoutMs = c.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS
  }

  /** Los manejadores de `agent.*` para `createDispatcher({ agents })`. */
  readonly handlers: AgentHandlers = {
    'agent.providers': () => this.providers(),
    'agent.create': (p) => this.create(p),
    'agent.send': (p) => this.send(p),
    'agent.interrupt': (p) => this.interrupt(p),
    'agent.respond': (p) => this.respond(p),
    'agent.list': () => this.list(),
    'agent.snapshot': (p) => this.snapshot(p),
    'agent.close': (p) => this.close(p),
  }

  /** Contadores de la sesión (eventos inválidos, bloques y deltas descartados); `undefined` si no existe. */
  stats(sessionId: AgentSessionId): AgentStats | undefined {
    const e = this.#sessions.get(sessionId)
    return e === undefined ? undefined : { ...e.stats }
  }

  // ---- Métodos ----

  async providers(): Promise<MethodResult<'agent.providers'>> {
    const providers: ProviderInfo[] = []
    for (const port of this.#providers.values()) {
      const available = await port.isAvailable().catch(() => false)
      const parsed = ProviderCapabilities.safeParse(
        await port.capabilities().catch(() => undefined),
      )
      const reason = available ? undefined : safeReason(port)
      const info = ProviderInfo.safeParse({
        id: port.id,
        name: port.displayName,
        available: available && parsed.success,
        ...(reason === undefined || reason === '' ? {} : { reason }),
        capabilities: parsed.success ? parsed.data : FALLBACK_CAPABILITIES,
      })
      if (info.success) providers.push(info.data)
    }
    return { providers }
  }

  async create(params: MethodParams<'agent.create'>): Promise<MethodResult<'agent.create'>> {
    const port = this.#providers.get(params.provider)
    if (port === undefined) {
      throw new DomainError('PROVIDER_UNAVAILABLE', `proveedor desconocido: ${params.provider}`)
    }
    const context = this.#deps.panes.paneContext(params.paneId)
    if (context === undefined)
      throw new DomainError('NOT_FOUND', `panel inexistente: ${params.paneId}`)
    if (context.pane.kind !== 'agent') {
      throw new DomainError('CONFLICT', 'solo los paneles de agente admiten sesiones de agente')
    }
    const existing = context.pane.agentSessionId
    if (
      this.#opening.has(params.paneId) ||
      (existing !== undefined && this.#sessions.has(existing))
    ) {
      throw new DomainError('CONFLICT', 'el panel ya tiene una sesión de agente')
    }
    const cwd = params.cwd ?? context.cwd
    if (cwd === undefined) throw new DomainError('INVALID_PARAMS', 'falta el directorio de trabajo')
    if (this.#sessions.size + this.#opening.size >= this.#maxSessions) {
      throw new DomainError('CONFLICT', 'se alcanzó el máximo de sesiones de agente', {
        limit: this.#maxSessions,
      })
    }
    const id = this.#deps.ids.agentSession()
    if (this.#sessions.has(id)) throw new DomainError('CONFLICT', `id de sesión repetido: ${id}`)

    this.#opening.add(params.paneId)
    let provider: AgentProviderSession
    try {
      provider = await port.open({
        cwd,
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.effort === undefined ? {} : { effort: params.effort }),
        ...(params.permissionMode === undefined ? {} : { permissionMode: params.permissionMode }),
        ...(params.resume === undefined ? {} : { resume: params.resume }),
      })
    } catch (error) {
      throw mapProviderError(error)
    } finally {
      this.#opening.delete(params.paneId)
    }
    if (this.#deps.panes.paneContext(params.paneId) === undefined || this.#sessions.has(id)) {
      await provider.close().catch(() => undefined)
      throw new DomainError('CONFLICT', 'el panel se cerró mientras se abría la sesión')
    }

    const now = this.#deps.clock.now()
    const token = ProviderSessionToken.safeParse(provider.providerSessionId)
    const entry: Entry = {
      id,
      provider,
      providerId: port.id,
      paneId: params.paneId,
      ...(token.success ? { providerSessionId: token.data } : {}),
      ...(params.model === undefined ? {} : { model: params.model }),
      ...(params.effort === undefined ? {} : { effort: params.effort }),
      permissionMode: params.permissionMode ?? 'ask',
      cwd,
      status: 'idle',
      turn: 0,
      createdAt: now,
      updatedAt: now,
      blocks: [],
      byId: new Map(),
      refs: new Map(),
      droppedRefs: new Set(),
      requests: new Map(),
      cancelledRequests: new Set(),
      responding: new Set(),
      active: false,
      dead: false,
      closing: false,
      batcher: new OutputBatcher({
        clock: this.#deps.clock,
        flushMs: this.#batchMs,
        maxBytes: this.#maxDeltaBytes,
        emit: (data) => this.#emitDelta(entry, data),
      }),
      stats: { invalidEvents: 0, droppedBlocks: 0, droppedDeltas: 0 },
      invalidStreak: 0,
    }
    this.#sessions.set(id, entry)
    entry.offEvents = provider.onEvent((event) => this.#onProviderEvent(entry, event))
    this.#deps.panes.attachAgentSession(params.paneId, id)
    this.#publishSession(entry)
    return { session: this.#view(entry) }
  }

  async send(params: MethodParams<'agent.send'>): Promise<MethodResult<'agent.send'>> {
    const e = this.#get(params.sessionId)
    if (e.dead || e.closing) throw new DomainError('CONFLICT', 'la sesión está cerrada o en error')
    if (e.active) throw new DomainError('CONFLICT', 'ya hay un turno en curso')
    if (e.blocks.length >= this.#maxBlocks - this.#reserved) {
      throw new DomainError('CONFLICT', 'la sesión alcanzó el máximo de bloques', {
        limit: this.#maxBlocks,
      })
    }
    e.active = true
    e.turn++
    delete e.turnUsage
    const user = this.#add(e, { type: 'user', text: params.text })
    if (user === undefined) throw new DomainError('CONFLICT', 'la sesión no admite más bloques')
    this.#refreshStatus(e)
    try {
      await e.provider.send(params.text)
    } catch (error) {
      if (!e.dead && !e.closing) {
        if (error instanceof AgentProviderError && error.code === 'CLOSED') {
          this.#die(e, 'PROVIDER_CLOSED', 'la sesión del proveedor está cerrada', false)
        } else if (e.active) {
          this.#endTurnLocally(e)
          this.#add(e, {
            type: 'error',
            code: 'SEND_FAILED',
            message: bodyMessage(errorText(error)),
            fatal: false,
          })
          this.#setStatus(e, 'error', oneLine(errorText(error)))
        }
      }
      throw mapProviderError(error)
    }
    return { blockId: user.id, index: user.index, turn: user.turn }
  }

  async interrupt(
    params: MethodParams<'agent.interrupt'>,
  ): Promise<MethodResult<'agent.interrupt'>> {
    const e = this.#get(params.sessionId)
    if (e.dead || e.closing || !e.active) return {}
    e.batcher.flush()
    e.watchdog?.()
    e.watchdog = this.#deps.clock.setTimeout(() => {
      delete e.watchdog
      if (e.active && !e.dead && !e.closing) {
        this.#die(e, 'INTERRUPT_TIMEOUT', 'el proveedor no respondió a la interrupción', true)
      }
    }, this.#interruptTimeoutMs)
    try {
      await e.provider.interrupt()
    } catch (error) {
      throw mapProviderError(error)
    } finally {
      if (!e.dead && !e.closing) this.#cancelRequests(e)
    }
    return {}
  }

  async respond(params: MethodParams<'agent.respond'>): Promise<MethodResult<'agent.respond'>> {
    const e = this.#get(params.sessionId)
    const index = e.byId.get(params.blockId)
    const block = index === undefined ? undefined : e.blocks[index]
    if (block === undefined)
      throw new DomainError('NOT_FOUND', `bloque inexistente: ${params.blockId}`)
    if (block.type !== params.type) {
      throw new DomainError('INVALID_PARAMS', `el bloque no es de tipo ${params.type}`)
    }
    if (block.type !== 'permission' && block.type !== 'question') {
      throw new DomainError('INVALID_PARAMS', 'el bloque no admite respuesta')
    }
    if (block.state !== 'pending') {
      throw new DomainError('CONFLICT', `la solicitud ya se resolvió (${block.state})`)
    }
    if (e.dead || e.closing) throw new DomainError('CONFLICT', 'la sesión está cerrada o en error')
    const entry = [...e.requests.entries()].find(([, r]) => r.blockId === block.id)
    if (entry === undefined || e.responding.has(block.id)) {
      throw new DomainError('CONFLICT', 'la solicitud ya no está pendiente')
    }
    const requestId = entry[0]

    let chosen: { kind: string } | undefined
    if (params.type === 'permission' && block.type === 'permission') {
      chosen = block.options.find((o) => o.id === params.optionId)
      if (chosen === undefined) throw new DomainError('INVALID_PARAMS', 'opción desconocida')
    } else if (params.type === 'question' && block.type === 'question') {
      const problem = validateAnswers(block.questions, params.answers)
      if (problem !== null) throw new DomainError('INVALID_PARAMS', problem)
    }

    e.responding.add(block.id)
    try {
      await e.provider.respond(
        params.type === 'permission'
          ? { type: 'permission', requestId, optionId: params.optionId }
          : { type: 'question', requestId, answers: params.answers },
      )
    } catch (error) {
      if (error instanceof AgentProviderError && error.code === 'UNKNOWN_REQUEST') {
        this.#resolve(e, requestId, 'cancelled')
      }
      throw mapProviderError(error)
    } finally {
      e.responding.delete(block.id)
    }
    if (e.requests.get(requestId) === undefined) return {}
    this.#resolve(e, requestId, 'answered', params, chosen?.kind)
    return {}
  }

  list(): MethodResult<'agent.list'> {
    return { sessions: [...this.#sessions.values()].map((e) => this.#view(e)) }
  }

  snapshot(params: MethodParams<'agent.snapshot'>): MethodResult<'agent.snapshot'> {
    const e = this.#get(params.sessionId)
    e.batcher.flush()
    const from = params.fromIndex ?? 0
    const limit = Math.min(params.limit ?? LIMITS.maxSnapshotBlocks, LIMITS.maxSnapshotBlocks)
    const session = this.#view(e)
    let budget = this.#blockLimit - jsonBytes(session)
    const blocks: Block[] = []
    let next = from
    while (next < e.blocks.length && blocks.length < limit) {
      const block = e.blocks[next] as Block
      const size = jsonBytes(block) + 1
      if (blocks.length > 0 && size > budget) break
      budget -= size
      blocks.push(block)
      next++
    }
    return { session, blocks, nextIndex: next < e.blocks.length ? next : null }
  }

  async close(params: MethodParams<'agent.close'>): Promise<MethodResult<'agent.close'>> {
    const e = this.#get(params.sessionId)
    await this.#closeEntry(e)
    return {}
  }

  /** Cierra la sesión del panel (el panel se cerró). No hace nada si no tiene. */
  closePane(paneId: PaneId): void {
    for (const e of [...this.#sessions.values()]) {
      if (e.paneId === paneId) void this.#closeEntry(e)
    }
  }

  /** Cierra todas las sesiones (apagado del daemon). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((e) => this.#closeEntry(e)))
  }

  // ---- Sesiones ----

  #get(id: AgentSessionId): Entry {
    const e = this.#sessions.get(id)
    if (e === undefined) throw new DomainError('NOT_FOUND', `sesión de agente inexistente: ${id}`)
    return e
  }

  #view(e: Entry): AgentSession {
    return {
      id: e.id,
      provider: e.providerId,
      ...(e.providerSessionId === undefined ? {} : { providerSessionId: e.providerSessionId }),
      paneId: e.paneId,
      ...(e.title === undefined ? {} : { title: e.title }),
      ...(e.model === undefined ? {} : { model: e.model }),
      ...(e.effort === undefined ? {} : { effort: e.effort }),
      permissionMode: e.permissionMode,
      cwd: e.cwd,
      status: e.status,
      turn: e.turn,
      blockCount: e.blocks.length,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    } as AgentSession
  }

  #publishSession(e: Entry): void {
    this.#deps.bus.publish({ event: 'agent.session', data: { session: this.#view(e) } })
  }

  async #closeEntry(e: Entry): Promise<void> {
    if (e.closing) return
    e.closing = true
    e.watchdog?.()
    e.batcher.dispose()
    e.offEvents?.()
    this.#sessions.delete(e.id)
    this.#deps.panes.detachAgentSession(e.paneId, e.id)
    if (e.status !== 'idle') {
      this.#deps.panes.setPaneAttention(e.paneId, 'idle')
      this.#deps.bus.publish({
        event: 'pane.attention',
        data: { paneId: e.paneId, attention: 'idle' },
      })
    }
    this.#deps.bus.publish({ event: 'agent.session', data: { sessionId: e.id, removed: true } })
    await e.provider.close().catch((error: unknown) => {
      this.#deps.logger?.warn('no se pudo cerrar la sesión del proveedor', { error })
    })
  }

  // ---- Estado de atención ----

  #setStatus(e: Entry, status: AgentSession['status'], reason?: string): void {
    if (e.status === status && e.reason === reason) return
    const changed = e.status !== status
    e.status = status
    if (reason === undefined) delete e.reason
    else e.reason = reason
    e.updatedAt = this.#deps.clock.now()
    this.#deps.bus.publish({
      event: 'agent.status',
      data: {
        sessionId: e.id,
        status,
        updatedAt: e.updatedAt,
        ...(reason === undefined ? {} : { reason }),
      },
    })
    if (changed) {
      this.#deps.panes.setPaneAttention(e.paneId, status)
      this.#deps.bus.publish({
        event: 'pane.attention',
        data: { paneId: e.paneId, attention: status },
      })
    }
  }

  /** Estado mientras la sesión vive: espera respuesta, trabaja o (si no hay turno) conserva el de reposo. */
  #refreshStatus(e: Entry): void {
    if (e.dead) return
    if (e.requests.size > 0) this.#setStatus(e, 'needs-input', 'esperando una respuesta')
    else if (e.active) this.#setStatus(e, 'working')
  }

  // ---- Bloques ----

  #publishBlock(e: Entry, block: Block): void {
    e.updatedAt = this.#deps.clock.now()
    this.#deps.bus.publish({ event: 'agent.block', data: { sessionId: e.id, block } })
  }

  /** Añade un bloque al final. `soft`: los bloques del proveedor no usan las posiciones reservadas. */
  #add(e: Entry, draft: BlockDraft, soft = false): Block | undefined {
    const index = e.blocks.length
    if (index >= this.#maxBlocks - (soft ? this.#reserved : 0)) {
      if (soft) e.stats.droppedBlocks++
      else this.#die(e, 'BLOCK_LIMIT', 'la sesión alcanzó el máximo de bloques', true)
      return undefined
    }
    let id: BlockId | undefined
    for (let attempt = 0; attempt < 3 && id === undefined; attempt++) {
      const candidate = this.#deps.ids.block()
      if (!e.byId.has(candidate)) id = candidate
    }
    if (id === undefined) {
      this.#die(e, 'DUPLICATE_ID', 'el generador de ids repitió un bloque', true)
      return undefined
    }
    const block = fitBlock(
      { ...draft, id, index, turn: e.turn, seq: 0, createdAt: this.#deps.clock.now() } as Block,
      this.#blockLimit,
    )
    e.blocks.push(block)
    e.byId.set(id, index)
    this.#publishBlock(e, block)
    return block
  }

  /** Sustituye el bloque (misma identidad) y emite el reemplazo. */
  #replace(e: Entry, block: Block): Block {
    const fitted = fitBlock(block, this.#blockLimit)
    e.blocks[fitted.index] = fitted
    this.#publishBlock(e, fitted)
    return fitted
  }

  #blockOf(e: Entry, blockId: BlockId): Block | undefined {
    const index = e.byId.get(blockId)
    return index === undefined ? undefined : e.blocks[index]
  }

  #emitDelta(e: Entry, text: string): void {
    const target = e.target
    const block = target === undefined ? undefined : this.#blockOf(e, target.blockId)
    if (target === undefined || block === undefined || e.dead || e.closing) return
    if ('truncated' in block && block.truncated === true) {
      e.stats.droppedDeltas++
      return
    }
    const outcome = applyBlockDelta(block, {
      sessionId: e.id,
      blockId: block.id,
      field: target.field,
      seq: block.seq + 1,
      text,
    })
    if (outcome.status !== 'applied') {
      e.stats.droppedDeltas++
      return
    }
    const next = outcome.block
    if (next.type === 'action' && jsonBytes(next) > this.#blockLimit) {
      // El documento no cabe en un mensaje: se envía el bloque recortado en vez del delta.
      this.#replace(e, fitBlock(next, this.#blockLimit))
      return
    }
    e.blocks[next.index] = next
    e.updatedAt = this.#deps.clock.now()
    this.#deps.bus.publish({
      event: 'agent.delta',
      data: { sessionId: e.id, blockId: block.id, field: target.field, seq: next.seq, text },
    })
  }

  /** Cierra lo que el proveedor dejó abierto al terminar el turno. */
  #closeOpen(e: Entry): void {
    for (const blockId of e.refs.values()) {
      const block = this.#blockOf(e, blockId)
      if (block === undefined) continue
      if ((block.type === 'text' || block.type === 'reasoning') && !block.complete) {
        this.#replace(e, { ...block, complete: true })
      } else if (
        block.type === 'action' &&
        (block.status === 'pending' || block.status === 'running')
      ) {
        this.#replace(e, { ...block, status: 'error' })
      }
    }
    e.refs.clear()
    e.droppedRefs.clear()
  }

  #remember(set: Set<string>, value: string, max: number): void {
    if (set.size < max) set.add(value)
  }

  /** Permisos y preguntas pendientes pasan a `cancelled`. */
  #cancelRequests(e: Entry): void {
    for (const requestId of [...e.requests.keys()]) {
      this.#resolve(e, requestId, 'cancelled')
      this.#remember(e.cancelledRequests, requestId, MAX_TOMBSTONES)
    }
  }

  #resolve(
    e: Entry,
    requestId: string,
    outcome: 'answered' | 'cancelled',
    params?: MethodParams<'agent.respond'>,
    optionKind?: string,
  ): void {
    const request = e.requests.get(requestId)
    if (request === undefined) return
    e.requests.delete(requestId)
    const block = this.#blockOf(e, request.blockId)
    if (block?.type === 'permission' && block.state === 'pending') {
      if (outcome === 'cancelled' || params?.type !== 'permission') {
        this.#replace(e, { ...block, state: 'cancelled' })
      } else {
        const accepted = optionKind?.startsWith('allow') === true
        this.#replace(e, {
          ...block,
          state: accepted ? 'accepted' : 'rejected',
          selectedOptionId: params.optionId,
        })
      }
    } else if (block?.type === 'question' && block.state === 'pending') {
      if (outcome === 'cancelled' || params?.type !== 'question') {
        this.#replace(e, { ...block, state: 'cancelled' })
      } else {
        this.#replace(e, { ...block, state: 'answered', answers: params.answers })
      }
    }
    this.#refreshStatus(e)
  }

  #endTurnLocally(e: Entry): void {
    e.batcher.flush()
    this.#closeOpen(e)
    this.#cancelRequests(e)
    e.active = false
    e.watchdog?.()
    delete e.watchdog
  }

  /** La sesión no puede seguir: error legible en el documento, estado `error` y sin más turnos. */
  #die(e: Entry, code: string, message: string, closeProvider: boolean): void {
    if (e.dead) return
    this.#endTurnLocally(e)
    e.dead = true
    try {
      this.#add(e, { type: 'error', code, message: bodyMessage(message), fatal: true })
    } catch (error) {
      this.#deps.logger?.error('no se pudo registrar el error de la sesión', { error })
    }
    e.offEvents?.()
    e.batcher.dispose()
    this.#setStatus(e, 'error', oneLine(message))
    if (closeProvider) {
      void e.provider.close().catch((error: unknown) => {
        this.#deps.logger?.warn('no se pudo cerrar la sesión del proveedor', { error })
      })
    }
  }

  // ---- Eventos del proveedor ----

  #onProviderEvent(e: Entry, raw: unknown): void {
    if (e.dead || e.closing) return
    const parsed = ProviderEvent.safeParse(raw)
    if (!parsed.success) {
      this.#reject(e, 'evento del proveedor inválido')
      return
    }
    try {
      if (this.#handle(e, parsed.data)) e.invalidStreak = 0
    } catch (error) {
      this.#deps.logger?.error('error al aplicar un evento del proveedor', { error })
      this.#die(e, 'INTERNAL', 'error interno al aplicar un evento del proveedor', true)
    }
  }

  /** Descarta un evento inválido y lo cuenta; demasiados seguidos cierran la sesión. */
  #reject(e: Entry, reason: string): false {
    e.stats.invalidEvents++
    e.invalidStreak++
    this.#deps.logger?.warn('evento de proveedor descartado', { sessionId: e.id, reason })
    if (e.invalidStreak >= this.#maxInvalid) {
      this.#die(e, 'PROTOCOL', 'el proveedor emitió demasiados eventos inválidos', true)
    }
    return false
  }

  /** Aplica un evento válido. Devuelve `false` si lo descartó. */
  #handle(e: Entry, event: ProviderEvent): boolean {
    if (event.type === 'block-delta') return this.#onDelta(e, event)
    e.batcher.flush()
    switch (event.type) {
      case 'session-info':
        return this.#onSessionInfo(e, event)
      case 'exit':
        this.#die(
          e,
          'EXITED',
          `el proveedor terminó sin que se pidiera (código ${event.exitCode ?? 'ninguno'}${
            event.signal === null ? '' : `, señal ${oneLine(event.signal, 32)}`
          })`,
          false,
        )
        return true
      case 'error':
        return this.#onError(e, event)
      default:
        if (!e.active) return this.#reject(e, `${event.type} fuera de un turno`)
    }
    switch (event.type) {
      case 'block-start':
        return this.#onStart(e, event)
      case 'block-update':
      case 'block-end':
        return this.#onUpdate(e, event)
      case 'permission-request':
        return this.#onRequest(e, event.requestId, {
          type: 'permission',
          tool: event.tool,
          title: event.title,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
          options: event.options,
          state: 'pending',
        })
      case 'question-request':
        return this.#onRequest(e, event.requestId, {
          type: 'question',
          questions: event.questions,
          state: 'pending',
        })
      case 'request-cancelled':
        if (e.requests.has(event.requestId)) {
          this.#resolve(e, event.requestId, 'cancelled')
          return true
        }
        if (e.cancelledRequests.delete(event.requestId)) return true
        return this.#reject(e, 'solicitud desconocida')
      case 'usage':
        e.turnUsage = event.usage
        return true
      case 'turn-end':
        this.#onTurnEnd(e, event)
        return true
      default:
        return false
    }
  }

  #onSessionInfo(e: Entry, event: Extract<ProviderEvent, { type: 'session-info' }>): boolean {
    if (event.providerSessionId !== undefined) e.providerSessionId = event.providerSessionId
    if (event.model !== undefined) e.model = event.model
    if (event.effort !== undefined) e.effort = event.effort
    if (event.permissionMode !== undefined) e.permissionMode = event.permissionMode
    if (event.title !== undefined) e.title = event.title
    e.updatedAt = this.#deps.clock.now()
    this.#publishSession(e)
    return true
  }

  #onError(e: Entry, event: Extract<ProviderEvent, { type: 'error' }>): boolean {
    const { error } = event
    if (error.fatal) {
      this.#die(e, error.code, error.message, true)
      return true
    }
    this.#add(e, {
      type: 'error',
      code: error.code,
      message: error.message,
      fatal: false,
      ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    })
    return true
  }

  #onStart(e: Entry, event: Extract<ProviderEvent, { type: 'block-start' }>): boolean {
    const { ref, block: draft } = event
    if (draft.type === 'user' || draft.type === 'permission' || draft.type === 'question') {
      return this.#reject(e, `el proveedor no puede abrir bloques ${draft.type}`)
    }
    if (e.refs.has(ref) || e.droppedRefs.has(ref)) return this.#reject(e, `ref repetida: ${ref}`)
    const block = this.#add(e, draft, true)
    if (block === undefined) {
      if (!e.dead) this.#remember(e.droppedRefs, ref, MAX_DROPPED_REFS)
      return !e.dead
    }
    e.refs.set(ref, block.id)
    return true
  }

  #onUpdate(
    e: Entry,
    event: Extract<ProviderEvent, { type: 'block-update' | 'block-end' }>,
  ): boolean {
    const { ref } = event
    const ending = event.type === 'block-end'
    if (e.droppedRefs.has(ref)) {
      if (ending) e.droppedRefs.delete(ref)
      return true
    }
    const blockId = e.refs.get(ref)
    const block = blockId === undefined ? undefined : this.#blockOf(e, blockId)
    if (block === undefined) return this.#reject(e, `ref desconocida: ${ref}`)
    const draft = event.block
    if (draft !== undefined && draft.type !== block.type) {
      return this.#reject(e, 'el bloque no puede cambiar de tipo')
    }
    let next: Block = draft === undefined ? block : ({ ...draft, ...identity(block) } as Block)
    if (ending) {
      if (next.type === 'text' || next.type === 'reasoning') next = { ...next, complete: true }
      else if (
        next.type === 'action' &&
        draft === undefined &&
        (next.status === 'pending' || next.status === 'running')
      ) {
        next = { ...next, status: 'ok' }
      }
      e.refs.delete(ref)
    }
    if (next !== block) this.#replace(e, next)
    return true
  }

  #onDelta(e: Entry, event: Extract<ProviderEvent, { type: 'block-delta' }>): boolean {
    if (!e.active) return this.#reject(e, 'block-delta fuera de un turno')
    if (e.droppedRefs.has(event.ref)) return true
    const blockId = e.refs.get(event.ref)
    const block = blockId === undefined ? undefined : this.#blockOf(e, blockId)
    if (block === undefined) return this.#reject(e, `ref desconocida: ${event.ref}`)
    const fits =
      event.field === 'text'
        ? (block.type === 'text' || block.type === 'reasoning') && !block.complete
        : block.type === 'action' && block.status !== 'ok' && block.status !== 'error'
    if (!fits) return this.#reject(e, 'el delta no corresponde al bloque')
    if ('truncated' in block && block.truncated === true) {
      // Ya en el tope: no hace falta ni acumularlo.
      e.stats.droppedDeltas++
      return true
    }
    if (e.target?.blockId !== block.id || e.target.field !== event.field) {
      e.batcher.flush()
      e.target = { blockId: block.id, field: event.field }
    }
    e.batcher.push(event.text)
    return true
  }

  #onRequest(e: Entry, requestId: string, draft: BlockDraft): boolean {
    if (e.requests.has(requestId)) return this.#reject(e, `solicitud repetida: ${requestId}`)
    const issues = blockIssues(draft)
    if (issues.length > 0) return this.#reject(e, issues.join('; '))
    e.cancelledRequests.delete(requestId)
    const block = this.#add(e, draft)
    if (block === undefined) return false
    e.requests.set(requestId, {
      blockId: block.id,
      kind: draft.type === 'permission' ? 'permission' : 'question',
    })
    this.#refreshStatus(e)
    return true
  }

  #onTurnEnd(e: Entry, event: Extract<ProviderEvent, { type: 'turn-end' }>): void {
    this.#endTurnLocally(e)
    e.cancelledRequests.clear()
    this.#add(e, {
      type: 'usage',
      stopReason: event.stopReason,
      usage: event.usage ?? e.turnUsage ?? {},
    })
    delete e.turnUsage
    if (e.dead) return
    if (event.stopReason === 'interrupted') this.#setStatus(e, 'idle')
    else if (event.stopReason === 'error') this.#setStatus(e, 'error', 'el turno terminó con error')
    else this.#setStatus(e, 'done')
  }
}

function identity(block: Block) {
  return {
    id: block.id,
    index: block.index,
    turn: block.turn,
    seq: block.seq,
    createdAt: block.createdAt,
  }
}

function safeReason(port: AgentProviderPort): string | undefined {
  try {
    const raw = port.unavailableReason?.()
    return raw === undefined ? undefined : oneLine(raw, 512)
  } catch {
    return undefined
  }
}
