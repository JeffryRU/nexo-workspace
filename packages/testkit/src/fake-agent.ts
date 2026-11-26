import {
  type BlockDraft,
  type PermissionOption,
  type ProviderCapabilities,
  type ProviderEvent,
  type Question,
  validateAnswers,
} from '@nexo/contracts'
import {
  type AgentOpenOptions,
  AgentProviderError,
  type AgentProviderPort,
  type AgentProviderSession,
  type AgentResponse,
  type ClockPort,
  type Unsubscribe,
} from '@nexo/core'
import { schedule } from './timers.ts'

/** Un paso de un guion. Cada paso corre tras `delayMs` (0 por omisión) sobre el reloj del falso. */
export type FakeStep =
  /** Emite un evento válido. Tras `permission-request`/`question-request` el guion espera `respond`. */
  | { type: 'emit'; event: ProviderEvent; delayMs?: number }
  /** Emite cualquier cosa sin validar (JSON roto, tipos equivocados, claves hostiles). */
  | { type: 'raw'; value: unknown; delayMs?: number }
  /** El proveedor se cuelga: no vuelve a emitir hasta `interrupt` o `close`. */
  | { type: 'hang'; delayMs?: number }
  /** El proceso muere: emite `exit` y la sesión queda cerrada. */
  | { type: 'die'; exitCode?: number | null; signal?: string | null; delayMs?: number }

export type FakeTurn = { index: number; text: string }
export type FakeAgentScript = (turn: FakeTurn) => FakeStep[]

const emit = (event: ProviderEvent, delayMs?: number): FakeStep =>
  delayMs === undefined ? { type: 'emit', event } : { type: 'emit', event, delayMs }

const textDraft = (text: string, complete: boolean): BlockDraft => ({
  type: 'text',
  text,
  complete,
})

/** Pasos para un turno de texto con deltas. */
export function textTurn(parts: readonly string[], ref = 'text-1'): FakeStep[] {
  return [
    emit({ type: 'block-start', ref, block: textDraft('', false) }),
    ...parts.map((text) => emit({ type: 'block-delta', ref, field: 'text', text })),
    emit({ type: 'block-end', ref, block: textDraft(parts.join(''), true) }),
  ]
}

export const DEFAULT_PERMISSION_OPTIONS: PermissionOption[] = [
  { id: 'allow', label: 'Permitir', kind: 'allow-once' },
  { id: 'deny', label: 'Rechazar', kind: 'reject-once' },
]

/** Guion por omisión según el texto: `long` se queda esperando, `permission` pide permiso, el resto responde. */
export const defaultScript: FakeAgentScript = ({ text }) => {
  if (text === 'long') {
    return [
      emit({ type: 'block-start', ref: 'text-1', block: textDraft('', false) }),
      emit({ type: 'block-delta', ref: 'text-1', field: 'text', text: 'pensando' }),
      { type: 'hang' },
    ]
  }
  if (text === 'permission') {
    return [
      emit({
        type: 'block-start',
        ref: 'call-1',
        block: { type: 'action', kind: 'exec', status: 'running', tool: 'Bash', title: 'ls' },
      }),
      emit({
        type: 'permission-request',
        requestId: 'req-1',
        tool: 'Bash',
        title: 'Ejecutar ls',
        options: DEFAULT_PERMISSION_OPTIONS,
      }),
      emit({
        type: 'block-end',
        ref: 'call-1',
        block: {
          type: 'action',
          kind: 'exec',
          status: 'ok',
          tool: 'Bash',
          title: 'ls',
          output: 'a.txt\n',
          exitCode: 0,
        },
      }),
    ]
  }
  return textTurn(['Hola ', 'mundo'])
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  models: [{ id: 'fake-1', label: 'Fake 1', efforts: ['low', 'high'] }, { id: 'fake-2' }],
  defaultModel: 'fake-1',
  efforts: ['low', 'high'],
  permissionModes: ['ask', 'accept-edits', 'plan', 'bypass'],
  resume: true,
  warmup: true,
  streaming: true,
}

export type FakeAgentProviderOptions = {
  displayName?: string
  capabilities?: ProviderCapabilities
  script?: FakeAgentScript
  /** Reloj de los retardos; por omisión, temporizadores reales. Con `FakeClock` el tiempo lo gobierna la prueba. */
  clock?: ClockPort
}

const realClock: ClockPort = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    let live = true
    schedule(() => {
      if (live) callback()
    }, ms)
    return () => {
      live = false
    }
  },
}

type PendingRequest =
  | { kind: 'permission'; options: readonly PermissionOption[] }
  | { kind: 'question'; questions: readonly Question[] }

/** Sesión falsa: sigue el guion del turno y respeta el contrato de `AgentProviderSession`. */
export class FakeAgentSession implements AgentProviderSession {
  readonly providerSessionId: string
  /** Todo lo emitido (incluida la basura), en orden. */
  readonly emitted: unknown[] = []
  readonly sent: string[] = []
  readonly responses: AgentResponse[] = []
  readonly #listeners = new Set<(event: ProviderEvent) => void>()
  readonly #pending = new Map<string, PendingRequest>()
  readonly #clock: ClockPort
  readonly #script: () => FakeAgentScript
  #turns = 0
  #active = false
  #closed = false
  #epoch = 0
  #cancel: Unsubscribe | null = null
  #queue: FakeStep[] = []
  #exitEmitted = false

  constructor(providerSessionId: string, clock: ClockPort, script: () => FakeAgentScript) {
    this.providerSessionId = providerSessionId
    this.#clock = clock
    this.#script = script
  }

  get closed(): boolean {
    return this.#closed
  }
  get active(): boolean {
    return this.#active
  }

  onEvent(listener: (event: ProviderEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #publish(value: unknown): void {
    this.emitted.push(value)
    for (const listener of [...this.#listeners]) listener(value as ProviderEvent)
  }

  async send(text: string): Promise<void> {
    if (this.#closed) throw new AgentProviderError('CLOSED', 'la sesión está cerrada')
    if (text.length === 0) throw new AgentProviderError('INVALID_OPTIONS', 'mensaje vacío')
    if (this.#active) throw new AgentProviderError('BUSY', 'ya hay un turno en curso')
    this.sent.push(text)
    this.#active = true
    this.#queue = [...this.#script()({ index: ++this.#turns, text })]
    this.#next(this.#epoch)
  }

  #next(epoch: number): void {
    if (epoch !== this.#epoch || this.#closed || !this.#active) return
    const step = this.#queue.shift()
    if (step === undefined) {
      this.#endTurn('end-turn')
      return
    }
    const delay = step.delayMs ?? 0
    this.#cancel = this.#clock.setTimeout(() => {
      this.#cancel = null
      if (epoch !== this.#epoch || this.#closed || !this.#active) return
      this.#run(step, epoch)
    }, delay)
  }

  #run(step: FakeStep, epoch: number): void {
    if (step.type === 'hang') return
    if (step.type === 'die') {
      this.#die(step.exitCode ?? 1, step.signal ?? null)
      return
    }
    if (step.type === 'raw') {
      this.#publish(step.value)
      this.#next(epoch)
      return
    }
    const event = step.event
    if (event.type === 'turn-end') {
      this.#publish(event)
      this.#active = false
      this.#queue = []
      return
    }
    if (event.type === 'permission-request') {
      this.#pending.set(event.requestId, { kind: 'permission', options: event.options })
      this.#publish(event)
      return
    }
    if (event.type === 'question-request') {
      this.#pending.set(event.requestId, { kind: 'question', questions: event.questions })
      this.#publish(event)
      return
    }
    if (event.type === 'request-cancelled') this.#pending.delete(event.requestId)
    this.#publish(event)
    this.#next(epoch)
  }

  #endTurn(stopReason: 'end-turn' | 'interrupted'): void {
    this.#active = false
    this.#queue = []
    this.#publish({ type: 'turn-end', stopReason, usage: { inputTokens: 1, outputTokens: 1 } })
  }

  #die(exitCode: number | null, signal: string | null): void {
    this.#epoch++
    this.#cancel?.()
    this.#active = false
    this.#closed = true
    this.#pending.clear()
    this.#emitExit(exitCode, signal)
  }

  #emitExit(exitCode: number | null, signal: string | null): void {
    if (this.#exitEmitted) return
    this.#exitEmitted = true
    this.#publish({ type: 'exit', exitCode, signal })
  }

  async interrupt(): Promise<void> {
    if (this.#closed || !this.#active) return
    this.#epoch++
    this.#cancel?.()
    this.#cancel = null
    for (const requestId of [...this.#pending.keys()]) {
      this.#pending.delete(requestId)
      this.#publish({ type: 'request-cancelled', requestId })
    }
    this.#endTurn('interrupted')
  }

  async respond(response: AgentResponse): Promise<void> {
    if (this.#closed) throw new AgentProviderError('CLOSED', 'la sesión está cerrada')
    const request = this.#pending.get(response.requestId)
    if (request === undefined || request.kind !== response.type) {
      throw new AgentProviderError(
        'UNKNOWN_REQUEST',
        `solicitud desconocida: ${response.requestId}`,
      )
    }
    if (response.type === 'permission' && request.kind === 'permission') {
      if (!request.options.some((o) => o.id === response.optionId)) {
        throw new AgentProviderError('INVALID_OPTIONS', 'opción desconocida')
      }
    } else if (response.type === 'question' && request.kind === 'question') {
      const problem = validateAnswers(request.questions, response.answers)
      if (problem !== null) throw new AgentProviderError('INVALID_OPTIONS', problem)
    }
    this.#pending.delete(response.requestId)
    this.responses.push(response)
    this.#next(this.#epoch)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#epoch++
    this.#cancel?.()
    this.#cancel = null
    this.#active = false
    this.#closed = true
    this.#pending.clear()
    this.#emitExit(0, null)
  }

  /** Para pruebas: mata el proceso como si hubiera caído. */
  crash(exitCode: number | null = 1, signal: string | null = null): void {
    if (!this.#closed) this.#die(exitCode, signal)
  }
}

/** Proveedor falso guionizable. Cumple la suite de conformidad de `AgentProviderPort`. */
export class FakeAgentProvider implements AgentProviderPort {
  available = true
  script: FakeAgentScript
  caps: ProviderCapabilities
  readonly displayName: string
  readonly sessions: FakeAgentSession[] = []
  readonly warmed: string[] = []
  readonly #clock: ClockPort
  readonly #known = new Set<string>()
  #n = 0

  constructor(
    readonly id = 'fake',
    options: FakeAgentProviderOptions = {},
  ) {
    this.displayName = options.displayName ?? 'Proveedor falso'
    this.caps = options.capabilities ?? DEFAULT_CAPABILITIES
    this.script = options.script ?? defaultScript
    this.#clock = options.clock ?? realClock
  }

  async isAvailable(): Promise<boolean> {
    return this.available
  }

  /** Motivo que se informa mientras `available` es `false` (`undefined`: sin motivo). */
  reason: string | undefined

  unavailableReason(): string | undefined {
    if (this.reason === 'lanza') throw new Error('boom')
    return this.available ? undefined : this.reason
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.caps
  }

  async warmUp(options: Pick<AgentOpenOptions, 'cwd'>): Promise<void> {
    if (!this.caps.warmup) return
    if (!this.available) throw new AgentProviderError('UNAVAILABLE', 'proveedor no disponible')
    this.warmed.push(options.cwd)
  }

  async open(options: AgentOpenOptions): Promise<FakeAgentSession> {
    if (!this.available) throw new AgentProviderError('UNAVAILABLE', 'proveedor no disponible')
    const caps = this.caps
    if (typeof options.cwd !== 'string' || options.cwd.length === 0) {
      throw new AgentProviderError('INVALID_OPTIONS', 'cwd vacío')
    }
    if (
      options.model !== undefined &&
      caps.models.length > 0 &&
      !caps.models.some((m) => m.id === options.model)
    ) {
      throw new AgentProviderError('INVALID_OPTIONS', `modelo no declarado: ${options.model}`)
    }
    if (options.effort !== undefined && !caps.efforts.includes(options.effort)) {
      throw new AgentProviderError('INVALID_OPTIONS', `esfuerzo no declarado: ${options.effort}`)
    }
    if (
      options.permissionMode !== undefined &&
      !caps.permissionModes.includes(options.permissionMode)
    ) {
      throw new AgentProviderError('INVALID_OPTIONS', 'modo de permisos no declarado')
    }
    let providerSessionId: string
    if (options.resume !== undefined) {
      if (!caps.resume || !this.#known.has(options.resume)) {
        throw new AgentProviderError('INVALID_OPTIONS', 'no se puede reanudar esa sesión')
      }
      providerSessionId = options.resume
    } else {
      providerSessionId = `${this.id}-session-${++this.#n}`
      this.#known.add(providerSessionId)
    }
    const session = new FakeAgentSession(providerSessionId, this.#clock, () => this.script)
    this.sessions.push(session)
    return session
  }
}
