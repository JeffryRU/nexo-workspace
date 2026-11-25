import {
  type AgentSession,
  type AgentSessionId,
  type Attention,
  applyBlockDelta,
  type Block,
  type BlockId,
  type EventData,
  type MethodParams,
  type MethodResult,
} from '@nexo/contracts'
import type { CallOptions, NexoClient } from './client.ts'
import { NexoClientError } from './errors.ts'

/** Lo mínimo del cliente que usa el documento (se inyecta uno falso en las pruebas). */
export type AgentDocumentClient = {
  call<M extends 'agent.snapshot'>(
    method: M,
    params: MethodParams<M>,
    options?: CallOptions<MethodResult<M>>,
  ): Promise<MethodResult<M>>
  on: NexoClient['on']
}

export type AgentDocumentOptions = {
  /** Bloques por página de `agent.snapshot` (el servidor puede devolver menos). */
  pageSize?: number
  /** Tope de páginas de una sincronización: un servidor que no avanza no deja el bucle abierto. */
  maxPages?: number
}

/** Qué cambió en el documento; la interfaz decide qué repintar. */
export type AgentDocumentEvent =
  /** Bloque nuevo o reemplazado (`agent.block`, o una página de `agent.snapshot`). */
  | { type: 'block'; block: Block }
  /** Texto añadido a un bloque en streaming; `block` ya lo incluye. */
  | { type: 'delta'; block: Block; field: 'text' | 'output'; text: string }
  | { type: 'session'; session: AgentSession }
  | { type: 'status'; status: Attention; reason?: string }
  /** La sesión se cerró en el daemon: el documento ya no recibe más. */
  | { type: 'removed' }
  /** Terminó una sincronización completa (alta, reconexión, hueco...). */
  | { type: 'synced' }
  /** Falló una sincronización; se reintenta en el siguiente `resync` del cliente. */
  | { type: 'error'; error: Error }

const DEFAULT_PAGE_SIZE = 100
const DEFAULT_MAX_PAGES = 1000

/**
 * Documento vivo de una sesión de agente en el cliente. Aplica `agent.block` como upsert por `block.id` y
 * `agent.delta` con `applyBlockDelta`; ante un hueco o un delta inválido pide `agent.snapshot` desde el
 * `index` del bloque y recorre las páginas con `nextIndex` hasta `null`; tras una reconexión (o cualquier
 * `resync` del cliente) vuelve a sincronizar todo.
 *
 * El llamador debe estar suscrito a los eventos `agent.*` (`client.subscribe()`) antes de `open`. Cada página
 * del snapshot se aplica de forma síncrona al llegar su respuesta (`CallOptions.onResult`): los eventos
 * anteriores quedan reemplazados por ella y los posteriores se aplican encima, sin carreras.
 */
export class AgentDocument {
  readonly sessionId: AgentSessionId
  readonly #client: AgentDocumentClient
  readonly #pageSize: number
  readonly #maxPages: number
  readonly #blocks = new Map<BlockId, Block>()
  readonly #listeners = new Set<(event: AgentDocumentEvent) => void>()
  readonly #offs: (() => void)[] = []
  #session: AgentSession | undefined
  #removed = false
  #disposed = false
  #syncing = false
  /** Primer `index` de la sincronización en curso. */
  #syncFrom = 0
  /** Índice desde el que hay que volver a sincronizar cuando termine la actual. */
  #again: number | undefined
  #running: Promise<void> | undefined

  private constructor(
    client: AgentDocumentClient,
    sessionId: AgentSessionId,
    options: AgentDocumentOptions,
  ) {
    this.#client = client
    this.sessionId = sessionId
    this.#pageSize = Math.max(1, Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, 200))
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  }

  /** Registra los manejadores y sincroniza el documento completo; rechaza si la primera sincronización falla. */
  static async open(
    client: AgentDocumentClient,
    sessionId: AgentSessionId,
    options: AgentDocumentOptions = {},
  ): Promise<AgentDocument> {
    const doc = new AgentDocument(client, sessionId, options)
    doc.#attach()
    try {
      await doc.#sync(0)
    } catch (error) {
      doc.dispose()
      throw error
    }
    return doc
  }

  /** Sesión tal como la conoce el cliente (se actualiza con `agent.session` y `agent.status`). */
  get session(): AgentSession | undefined {
    return this.#session
  }

  /** `true` si el daemon cerró la sesión. */
  get removed(): boolean {
    return this.#removed
  }

  /** `true` mientras se recorre `agent.snapshot`. */
  get syncing(): boolean {
    return this.#syncing
  }

  /** Bloques ordenados por `index`. */
  blocks(): Block[] {
    return [...this.#blocks.values()].sort((a, b) => a.index - b.index)
  }

  block(id: BlockId): Block | undefined {
    return this.#blocks.get(id)
  }

  /** Bloques `permission` o `question` que esperan respuesta. */
  pending(): Block[] {
    return this.blocks().filter(
      (b) => (b.type === 'permission' || b.type === 'question') && b.state === 'pending',
    )
  }

  /** Suscribe a los cambios; devuelve la función para dejar de escuchar. */
  subscribe(listener: (event: AgentDocumentEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Fuerza una sincronización completa y espera a que termine. */
  resync(): Promise<void> {
    return this.#sync(0)
  }

  /** Espera a que no haya sincronización en curso ni pendiente. */
  async settled(): Promise<void> {
    while (this.#running !== undefined) await this.#running.catch(() => {})
  }

  dispose(): void {
    this.#disposed = true
    for (const off of this.#offs.splice(0)) off()
    this.#listeners.clear()
  }

  // ---- internos ----

  #emit(event: AgentDocumentEvent): void {
    if (this.#disposed) return
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch {
        // un oyente defectuoso no rompe el documento
      }
    }
  }

  #attach(): void {
    const c = this.#client
    this.#offs.push(
      c.on('agent.block', (data) => this.#onBlock(data)),
      c.on('agent.delta', (data) => this.#onDelta(data)),
      c.on('agent.status', (data) => this.#onStatus(data)),
      c.on('agent.session', (data) => this.#onSession(data)),
      c.on('resync', () => {
        if (!this.#removed) void this.#sync(0).catch(() => {})
      }),
    )
  }

  /** Primer `index` que falta en el documento (donde empieza lo que no tenemos). */
  #firstMissing(): number {
    const seen = new Set<number>()
    for (const b of this.#blocks.values()) seen.add(b.index)
    let i = 0
    while (seen.has(i)) i++
    return i
  }

  #onBlock(data: EventData<'agent.block'>): void {
    if (data.sessionId !== this.sessionId || this.#removed) return
    const block = data.block
    this.#blocks.set(block.id, block)
    this.#emit({ type: 'block', block })
    // Un hueco en los índices significa que se perdió un `agent.block`.
    if (!this.#syncing && block.index > this.#firstMissing()) {
      this.#request(this.#firstMissing())
    }
  }

  #onDelta(delta: EventData<'agent.delta'>): void {
    if (delta.sessionId !== this.sessionId || this.#removed) return
    const block = this.#blocks.get(delta.blockId)
    if (block === undefined) {
      // Durante una sincronización, las páginas que faltan ya lo incluirán.
      if (!this.#syncing) this.#request(this.#firstMissing())
      return
    }
    const outcome = applyBlockDelta(block, delta)
    if (outcome.status === 'duplicate') return
    if (outcome.status === 'applied') {
      this.#blocks.set(block.id, outcome.block)
      this.#emit({ type: 'delta', block: outcome.block, field: delta.field, text: delta.text })
      return
    }
    // `gap` o `invalid`: se pide el documento desde ese bloque (si ya vamos a pasar por él, no hace falta).
    if (!this.#syncing || block.index < this.#syncFrom) this.#request(block.index)
  }

  #onStatus(data: EventData<'agent.status'>): void {
    if (data.sessionId !== this.sessionId || this.#removed) return
    if (this.#session !== undefined) {
      this.#session = { ...this.#session, status: data.status, updatedAt: data.updatedAt }
    }
    this.#emit({
      type: 'status',
      status: data.status,
      ...(data.reason === undefined ? {} : { reason: data.reason }),
    })
  }

  #onSession(data: EventData<'agent.session'>): void {
    if ('removed' in data) {
      if (data.sessionId !== this.sessionId) return
      this.#removed = true
      this.#emit({ type: 'removed' })
      return
    }
    if (data.session.id !== this.sessionId || this.#removed) return
    this.#session = data.session
    this.#emit({ type: 'session', session: data.session })
  }

  /** Pide sincronizar desde `fromIndex` sin esperar el resultado. */
  #request(fromIndex: number): void {
    void this.#sync(fromIndex).catch(() => {})
  }

  #sync(fromIndex: number): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = Math.min(this.#again ?? Number.POSITIVE_INFINITY, fromIndex)
      return this.#running
    }
    const run = (async () => {
      let from: number | undefined = fromIndex
      while (from !== undefined && !this.#disposed && !this.#removed) {
        this.#again = undefined
        await this.#pages(from)
        from = this.#again
      }
    })()
    this.#running = run
    const done = () => {
      if (this.#running === run) this.#running = undefined
      this.#syncing = false
    }
    run.then(done, (error: unknown) => {
      done()
      this.#again = undefined
      if (!(error instanceof NexoClientError && error.code === 'CLOSED')) {
        this.#emit({
          type: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    })
    return run
  }

  async #pages(fromIndex: number): Promise<void> {
    this.#syncing = true
    this.#syncFrom = fromIndex
    let from = fromIndex
    for (let page = 0; page < this.#maxPages; page++) {
      if (this.#disposed || this.#removed) return
      const wanted = from
      let applied = false
      let next: number | null = null
      let failure: unknown
      const apply = (result: MethodResult<'agent.snapshot'>) => {
        if (applied) return
        applied = true
        try {
          next = this.#applyPage(result, wanted)
        } catch (error) {
          failure = error
        }
      }
      const result = await this.#client.call(
        'agent.snapshot',
        { sessionId: this.sessionId, fromIndex: wanted, limit: this.#pageSize },
        { onResult: apply },
      )
      apply(result)
      if (failure !== undefined) throw failure
      if (next === null) {
        this.#emit({ type: 'synced' })
        return
      }
      from = next
    }
    throw new NexoClientError('INVALID_RESPONSE', 'agent.snapshot no termina de paginar')
  }

  /** Aplica una página; devuelve el `index` de la siguiente o `null` si es la última. */
  #applyPage(result: MethodResult<'agent.snapshot'>, wanted: number): number | null {
    if (result.session.id !== this.sessionId) {
      throw new NexoClientError('INVALID_RESPONSE', 'agent.snapshot de otra sesión')
    }
    this.#session = result.session
    this.#emit({ type: 'session', session: result.session })
    let previous = wanted - 1
    for (const block of result.blocks) {
      // Páginas fuera de orden o repetidas: el servidor no cumple el contrato.
      if (block.index <= previous) {
        throw new NexoClientError('INVALID_RESPONSE', 'agent.snapshot con bloques desordenados')
      }
      previous = block.index
      this.#blocks.set(block.id, block)
      this.#emit({ type: 'block', block })
    }
    const next = result.nextIndex
    if (next === null) return null
    if (next <= wanted) {
      throw new NexoClientError('INVALID_RESPONSE', 'agent.snapshot no avanza (nextIndex)')
    }
    return next
  }
}
