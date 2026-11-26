import type {
  AgentSession,
  AgentSessionId,
  Block,
  BlockId,
  MethodParams,
  MethodResult,
} from '@nexo/contracts'
import {
  DomainError,
  MemoryService,
  type MemoryServiceConfig,
  type MemoryServiceDeps,
  type MemorySessionSource,
  type MemoryThresholds,
  type SummarizerPort,
} from '@nexo/core'
import { FakeMemoryStore, FakeSummarizer } from './fake-memory.ts'
import { FakeClock, FakeLogger, RecordingEventBus } from './fakes.ts'
import { sleep } from './timers.ts'

/** Documentos de sesión en memoria para probar `MemoryService` (hace de `AgentService`). */
export class FakeSessionSource implements MemorySessionSource {
  readonly sessions = new Map<AgentSessionId, { cwd: string; blocks: Block[] }>()
  /** Cuántas veces se leyó el documento (para comprobar que no se lee de más). */
  snapshots = 0

  add(id: AgentSessionId, cwd: string): void {
    this.sessions.set(id, { cwd, blocks: [] })
  }

  remove(id: AgentSessionId): void {
    this.sessions.delete(id)
  }

  list(): MethodResult<'agent.list'> {
    return {
      sessions: [...this.sessions].map(([id, s]) => sessionView(id, s.cwd, s.blocks.length)),
    }
  }

  snapshot(params: MethodParams<'agent.snapshot'>): MethodResult<'agent.snapshot'> {
    this.snapshots++
    const s = this.sessions.get(params.sessionId)
    if (s === undefined)
      throw new DomainError('NOT_FOUND', `sesión inexistente: ${params.sessionId}`)
    const from = params.fromIndex ?? 0
    const limit = params.limit ?? 200
    const blocks = s.blocks.slice(from, from + limit)
    const next = from + blocks.length
    return {
      session: sessionView(params.sessionId, s.cwd, s.blocks.length),
      blocks,
      nextIndex: next < s.blocks.length ? next : null,
    }
  }
}

export function sessionView(id: AgentSessionId, cwd: string, blockCount = 0): AgentSession {
  return {
    id,
    provider: 'fake',
    paneId: 'pane-1',
    permissionMode: 'ask',
    cwd,
    status: 'idle',
    turn: 0,
    blockCount,
    createdAt: 0,
    updatedAt: 0,
  } as AgentSession
}

const baseBlock = (index: number) => ({
  id: `blk-${index}` as BlockId,
  index,
  turn: 1,
  seq: 0,
  createdAt: 1,
})
export const userBlock = (index: number, text: string): Block => ({
  ...baseBlock(index),
  type: 'user',
  text,
})
export const agentBlock = (index: number, text: string, complete = true): Block => ({
  ...baseBlock(index),
  type: 'text',
  text,
  complete,
})

export type MemoryRigOptions = {
  enabled?: boolean
  summarizer?: SummarizerPort | null
  thresholds?: Partial<MemoryThresholds>
  config?: MemoryServiceConfig
  pausedReason?: string
  /** Sin fuente de sesiones (daemon sin agentes). */
  noSessions?: boolean
  renewAtTokens?: number
  /** Guarda de los ajustes en caliente (`memory.configure`); si lanza, no se aplican. */
  onSettings?: MemoryServiceDeps['onSettings']
}

/** Un `MemoryService` con todos sus falsos, y atajos para simular una conversación. */
export class MemoryRig {
  readonly clock = new FakeClock(1_700_000_000_000)
  readonly bus = new RecordingEventBus()
  readonly store = new FakeMemoryStore({ now: () => this.clock.now() })
  readonly summarizer: SummarizerPort
  readonly fake: FakeSummarizer | undefined
  readonly sessions = new FakeSessionSource()
  readonly logger = new FakeLogger()
  readonly service: MemoryService
  /** Para mostrar siempre un lote del Observador con unos 500 tokens. */
  static readonly SMALL = { observerBatchTokens: 500, reflectorTokens: 1000, maxBatchTokens: 2000 }

  constructor(options: MemoryRigOptions = {}) {
    if (options.summarizer === undefined) {
      this.fake = new FakeSummarizer()
      this.summarizer = this.fake
    } else {
      this.summarizer = options.summarizer as SummarizerPort
    }
    this.service = new MemoryService({
      store: this.store,
      bus: this.bus,
      clock: this.clock,
      logger: this.logger,
      enabled: options.enabled ?? true,
      ...(options.renewAtTokens === undefined ? {} : { renewAtTokens: options.renewAtTokens }),
      ...(options.onSettings === undefined ? {} : { onSettings: options.onSettings }),
      ...(options.summarizer === null ? {} : { summarizer: this.summarizer }),
      ...(options.pausedReason === undefined ? {} : { pausedReason: options.pausedReason }),
      ...(options.noSessions === true ? {} : { sessions: this.sessions }),
      thresholds: options.thresholds ?? MemoryRig.SMALL,
      config: { retryDelaysMs: [10, 20], pauseMs: 1000, availabilityTtlMs: 100, ...options.config },
    })
  }

  /** Abre una sesión y avisa por el bus, como lo hace `AgentService`. */
  open(id = 's1', cwd = '/work/app'): AgentSessionId {
    const sid = id as AgentSessionId
    this.sessions.add(sid, cwd)
    this.bus.publish({ event: 'agent.session', data: { session: sessionView(sid, cwd) } })
    return sid
  }

  /** Añade bloques al documento y publica `agent.block` por cada uno. */
  push(id: AgentSessionId, ...blocks: Block[]): void {
    const s = this.sessions.sessions.get(id)
    if (s === undefined) throw new Error(`sesión ${id} no abierta`)
    for (const block of blocks) {
      s.blocks.push(block)
      this.bus.publish({ event: 'agent.block', data: { sessionId: id, block } })
    }
  }

  /** Una pareja usuario/agente de ~`chars` caracteres cada uno, con el siguiente `index`. */
  turn(id: AgentSessionId, chars: number, label = 'tema'): void {
    const s = this.sessions.sessions.get(id)
    const n = s?.blocks.length ?? 0
    this.push(
      id,
      userBlock(n, `${label} ${'u'.repeat(chars)}`),
      agentBlock(n + 1, `respuesta ${'a'.repeat(chars)}`),
    )
  }

  idle(id: AgentSessionId): void {
    this.bus.publish({
      event: 'agent.status',
      data: { sessionId: id, status: 'idle', updatedAt: this.clock.now() },
    })
  }

  /** Cede el turno al bucle de eventos hasta que la cola termine (avanzando el reloj falso si se pide). */
  async drain(advanceMs = 0): Promise<void> {
    for (let i = 0; i < 400; i++) {
      await sleep(0)
      if (advanceMs > 0) this.clock.advance(advanceMs)
      if (!this.service.busy) return
    }
    throw new Error('el servicio de memoria no terminó')
  }
}

export function createMemoryRig(options: MemoryRigOptions = {}): MemoryRig {
  const rig = new MemoryRig(options)
  if (options.enabled !== false) rig.service.start()
  return rig
}
