import {
  type AgentApi,
  AgentDocument,
  type AgentDocumentEvent,
  agentApi,
  type NexoClient,
} from '@nexo/client'
import type {
  AgentSession,
  Attention,
  Block,
  MethodParams,
  PermissionMode,
  QuestionAnswer,
} from '@nexo/contracts'
import { AgentSessionId as AgentSessionIdSchema, BlockId } from '@nexo/contracts'
import { type Accessor, createSignal, type Setter } from 'solid-js'

export type AgentClient = Pick<NexoClient, 'call' | 'on'>

export type AgentPaneDeps = {
  paneId: string
  /** El cliente actual del daemon (solo cuando hay conexión). */
  getClient: () => AgentClient | undefined
  frame: (cb: () => void) => void
  /** Aviso al usuario de un fallo (la barra de errores de la interfaz). */
  onError: (message: string) => void
  /** Texto de un error del cliente; la interfaz lo traduce. */
  describeError?: (error: unknown) => string
}

export type CreateOptions = {
  provider: string
  model?: string | undefined
  effort?: string | undefined
  permissionMode?: PermissionMode | undefined
  cwd?: string | undefined
}

export type PaneDocState = 'none' | 'opening' | 'live' | 'failed'

type Signal<T> = { get: Accessor<T>; set: Setter<T> }
const signal = <T>(initial: T): Signal<T> => {
  const [get, set] = createSignal<T>(initial)
  return { get, set }
}

/**
 * Estado de un panel de agente. Envuelve a `AgentDocument` (que ya sincroniza y se recupera solo) y le añade
 * lo que la interfaz necesita: los eventos se agrupan por fotograma (una ráfaga de deltas pinta una vez) y
 * cada bloque tiene su propia señal, así que un delta solo reactualiza el bloque que cambió.
 */
export class AgentPaneModel {
  readonly paneId: string
  readonly #deps: AgentPaneDeps
  readonly #ids = signal<string[]>([])
  readonly #blocks = new Map<string, Signal<Block | undefined>>()
  readonly #session = signal<AgentSession | undefined>(undefined)
  readonly #status = signal<Attention>('idle')
  readonly #removed = signal(false)
  readonly #docState = signal<PaneDocState>('none')
  readonly #docError = signal<string | undefined>(undefined)
  readonly #syncing = signal(false)
  readonly #busy = signal(false)
  readonly #expanded = new Map<string, Signal<boolean>>()
  readonly #draft = signal('')
  readonly #pendingBlocks = new Map<string, Block>()
  readonly #pending = signal<string[]>([])
  #known = new Set<string>()
  #structureDirty = false
  #structureChanged = false
  #fullDirty = false
  #scheduled = false
  #doc: AgentDocument | undefined
  #offDoc: (() => void) | undefined
  readonly #sid = signal<string | undefined>(undefined)
  #boundClient: AgentClient | undefined
  #opening = 0
  #disposed = false

  /** Selección del redactor antes de crear la sesión. */
  readonly provider = signal<string | undefined>(undefined)
  readonly modelChoice = signal<string | undefined>(undefined)
  readonly effort = signal<string | undefined>(undefined)
  readonly permissionMode = signal<PermissionMode | undefined>(undefined)
  readonly cwd = signal('')

  constructor(deps: AgentPaneDeps) {
    this.paneId = deps.paneId
    this.#deps = deps
  }

  // ---- lectura ----

  get ids(): Accessor<string[]> {
    return this.#ids.get
  }
  get session(): Accessor<AgentSession | undefined> {
    return this.#session.get
  }
  get status(): Accessor<Attention> {
    return this.#status.get
  }
  get removed(): Accessor<boolean> {
    return this.#removed.get
  }
  get docState(): Accessor<PaneDocState> {
    return this.#docState.get
  }
  get docError(): Accessor<string | undefined> {
    return this.#docError.get
  }
  get syncing(): Accessor<boolean> {
    return this.#syncing.get
  }
  /** `true` mientras se envía o se crea (evita enviar dos veces). */
  get busy(): Accessor<boolean> {
    return this.#busy.get
  }
  get draft(): Accessor<string> {
    return this.#draft.get
  }
  setDraft(text: string): void {
    this.#draft.set(text)
  }
  get sessionId(): string | undefined {
    return this.#sid.get()
  }

  /** Señal del bloque `id` (se crea al pedirla). */
  block(id: string): Accessor<Block | undefined> {
    return this.#blockSignal(id).get
  }

  #blockSignal(id: string): Signal<Block | undefined> {
    let s = this.#blocks.get(id)
    if (s === undefined) {
      s = signal<Block | undefined>(this.#doc?.block(BlockId.parse(id)))
      this.#blocks.set(id, s)
    }
    return s
  }

  /** ¿Está desplegado el bloque plegable `id`? Se conserva aunque el bloque salga de la ventana virtual. */
  expanded(id: string): Accessor<boolean> {
    let s = this.#expanded.get(id)
    if (s === undefined) {
      s = signal(false)
      this.#expanded.set(id, s)
    }
    return s.get
  }
  toggle(id: string): void {
    this.expanded(id)
    const s = this.#expanded.get(id) as Signal<boolean>
    s.set(!s.get())
  }

  /** Ids de los bloques `permission`/`question` que esperan respuesta, en orden (reactivo). */
  pendingIds(): string[] {
    return this.#pending.get()
  }

  /** ¿Se puede escribir? No con la sesión caída, cerrada o en error. */
  get canSend(): boolean {
    return (
      this.#sid.get() !== undefined &&
      !this.#removed.get() &&
      this.#docState.get() === 'live' &&
      (this.#status.get() === 'idle' || this.#status.get() === 'done')
    )
  }

  // ---- conexión con la sesión ----

  /** Asocia el panel a una sesión (o a ninguna). Idempotente. */
  bind(sessionId: string | undefined, client: AgentClient | undefined): void {
    if (this.#disposed) return
    const same = sessionId === this.#sid.get() && client === this.#boundClient
    if (same && (this.#doc !== undefined || this.#docState.get() === 'opening')) return
    // Un panel no pierde su sesión salvo que se cierre (evento `removed`): sin id no hay nada que hacer.
    if (sessionId === undefined) return
    if (client === undefined) {
      // Sin conexión: se conserva lo que hay en pantalla; al volver se reabre.
      this.#boundClient = undefined
      return
    }
    void this.#open(sessionId, client)
  }

  /** Reintenta abrir la sesión tras un fallo. */
  retry(): void {
    const id = this.#sid.get()
    const client = this.#deps.getClient()
    if (id !== undefined && client !== undefined) void this.#open(id, client)
  }

  async #open(sessionId: string, client: AgentClient): Promise<void> {
    const token = ++this.#opening
    this.#closeDoc()
    this.#sid.set(sessionId)
    this.#boundClient = client
    this.#docState.set('opening')
    this.#docError.set(undefined)
    this.#removed.set(false)
    try {
      const doc = await AgentDocument.open(client, AgentSessionIdSchema.parse(sessionId))
      if (token !== this.#opening || this.#disposed) {
        doc.dispose()
        return
      }
      this.#doc = doc
      this.#offDoc = doc.subscribe((e) => this.#onEvent(e))
      this.#docState.set('live')
      this.#syncSession(doc)
      this.#structureDirty = true
      this.#fullDirty = true
      this.#flush()
    } catch (error) {
      if (token !== this.#opening || this.#disposed) return
      this.#docState.set('failed')
      this.#docError.set(this.#describe(error))
    }
  }

  #describe(error: unknown): string {
    return (
      this.#deps.describeError?.(error) ?? (error instanceof Error ? error.message : String(error))
    )
  }

  #closeDoc(): void {
    this.#offDoc?.()
    this.#offDoc = undefined
    this.#doc?.dispose()
    this.#doc = undefined
    this.#pendingBlocks.clear()
    this.#ids.set([])
    this.#pending.set([])
    this.#known = new Set()
    for (const s of this.#blocks.values()) s.set(undefined)
    this.#blocks.clear()
    this.#session.set(undefined)
    this.#syncing.set(false)
  }

  #syncSession(doc: AgentDocument): void {
    this.#session.set(doc.session)
    if (doc.session !== undefined) this.#status.set(doc.session.status)
    this.#removed.set(doc.removed)
    this.#syncing.set(doc.syncing)
  }

  #onEvent(e: AgentDocumentEvent): void {
    const doc = this.#doc
    if (doc === undefined) return
    switch (e.type) {
      case 'block':
        if (!this.#known.has(e.block.id)) this.#structureDirty = true
        this.#pendingBlocks.set(e.block.id, e.block)
        this.#schedule()
        return
      case 'delta':
        this.#pendingBlocks.set(e.block.id, e.block)
        this.#schedule()
        return
      case 'session':
        this.#session.set(e.session)
        this.#status.set(e.session.status)
        return
      case 'status':
        this.#status.set(e.status)
        if (e.status === 'needs-input') this.#schedule()
        return
      case 'removed':
        this.#removed.set(true)
        return
      case 'synced':
        this.#syncing.set(false)
        this.#structureDirty = true
        this.#fullDirty = true
        this.#schedule()
        return
      case 'error':
        this.#deps.onError(this.#describe(e.error))
        return
    }
  }

  #schedule(): void {
    if (this.#scheduled || this.#disposed) return
    this.#scheduled = true
    this.#deps.frame(() => {
      this.#scheduled = false
      this.#flush()
    })
  }

  /** Vuelca a las señales todo lo acumulado desde el último fotograma. */
  #flush(): void {
    const doc = this.#doc
    if (doc === undefined || this.#disposed) return
    if (this.#structureDirty) {
      this.#structureDirty = false
      this.#structureChanged = true
      const blocks = doc.blocks()
      this.#ids.set(blocks.map((b) => b.id))
      this.#known = new Set(this.#ids.get())
      if (this.#fullDirty) {
        this.#fullDirty = false
        for (const b of blocks) this.#blockSignal(b.id).set(b)
      }
    }
    let touchedPending = this.#structureChanged
    for (const [id, b] of this.#pendingBlocks) {
      this.#blockSignal(id).set(b)
      if (b.type === 'permission' || b.type === 'question') touchedPending = true
    }
    this.#pendingBlocks.clear()
    if (touchedPending) {
      const next = doc.pending().map((b) => b.id)
      const prev = this.#pending.get()
      if (next.length !== prev.length || next.some((id, i) => id !== prev[i]))
        this.#pending.set(next)
    }
    this.#structureChanged = false
    this.#syncing.set(doc.syncing)
  }

  // ---- órdenes ----

  async #run<T>(fn: (api: AgentApi) => Promise<T>): Promise<T | undefined> {
    const client = this.#deps.getClient()
    if (client === undefined) return undefined
    try {
      return await fn(agentApi(client))
    } catch (error) {
      this.#deps.onError(this.#describe(error))
      return undefined
    }
  }

  /** Crea la sesión del panel; con `text`, envía además el primer mensaje. */
  async create(options: CreateOptions, text?: string): Promise<boolean> {
    if (this.#busy.get() || this.#sid.get() !== undefined) return false
    this.#busy.set(true)
    try {
      const params: MethodParams<'agent.create'> = {
        paneId: this.#paneIdParam(),
        provider: options.provider,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
        ...(options.cwd === undefined || options.cwd === '' ? {} : { cwd: options.cwd }),
      }
      const created = await this.#run((api) => api.create(params))
      if (created === undefined) return false
      const client = this.#deps.getClient()
      if (client === undefined) return false
      await this.#open(created.session.id, client)
      if (text !== undefined && text !== '' && this.#docState.get() === 'live') {
        await this.#run((api) => api.send({ sessionId: created.session.id, text }))
      }
      return true
    } finally {
      this.#busy.set(false)
    }
  }

  #paneIdParam(): MethodParams<'agent.create'>['paneId'] {
    return this.paneId as MethodParams<'agent.create'>['paneId']
  }

  /** Envía un mensaje; `true` si el daemon lo aceptó. */
  async send(text: string): Promise<boolean> {
    const id = this.#sid.get()
    const clean = text.trim()
    if (id === undefined || clean === '' || this.#busy.get() || !this.canSend) return false
    this.#busy.set(true)
    try {
      const r = await this.#run((api) =>
        api.send({ sessionId: AgentSessionIdSchema.parse(id), text: clean }),
      )
      return r !== undefined
    } finally {
      this.#busy.set(false)
    }
  }

  async interrupt(): Promise<void> {
    const id = this.#sid.get()
    if (id === undefined) return
    await this.#run((api) => api.interrupt({ sessionId: AgentSessionIdSchema.parse(id) }))
  }

  async respondPermission(blockId: string, optionId: string): Promise<boolean> {
    const id = this.#sid.get()
    if (id === undefined) return false
    const r = await this.#run((api) =>
      api.respond({
        type: 'permission',
        sessionId: AgentSessionIdSchema.parse(id),
        blockId: BlockId.parse(blockId),
        optionId,
      }),
    )
    return r !== undefined
  }

  async respondQuestion(blockId: string, answers: QuestionAnswer[]): Promise<boolean> {
    const id = this.#sid.get()
    if (id === undefined) return false
    const r = await this.#run((api) =>
      api.respond({
        type: 'question',
        sessionId: AgentSessionIdSchema.parse(id),
        blockId: BlockId.parse(blockId),
        answers,
      }),
    )
    return r !== undefined
  }

  dispose(): void {
    this.#disposed = true
    this.#opening++
    this.#closeDoc()
    this.#docState.set('none')
  }
}
