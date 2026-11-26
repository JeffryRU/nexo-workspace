import { type PermissionMode, type ProviderEvent, Token } from '@nexo/contracts'
import {
  AgentProviderError,
  type AgentProviderSession,
  type AgentResponse,
  type Unsubscribe,
} from '@nexo/core'
import {
  ErrorCodes,
  type IncomingNotification,
  type IncomingRequest,
  RpcError,
} from '@nexo/jsonrpc'
import { type ApprovalPlan, planApproval } from './approvals.ts'
import type { CodexClient, LogEntry } from './client.ts'
import type { ExitInfo } from './process.ts'
import { TurnResult } from './protocol.ts'
import { CodexTranslator } from './translator.ts'

export type SessionLimits = {
  /** Sin ninguna notificación de Codex durante este tiempo (y sin aprobaciones pendientes) el turno falla. */
  idleTimeoutMs: number
  /** Tras `turn/interrupt`, cuánto se espera el `turn/completed` antes de cerrar el turno por nuestra cuenta. */
  interruptGraceMs: number
  /** Plazo de `turn/start` y `turn/interrupt`. */
  requestTimeoutMs: number
}

export const DEFAULT_LIMITS: SessionLimits = {
  idleTimeoutMs: 600_000,
  interruptGraceMs: 3000,
  requestTimeoutMs: 30_000,
}

type Turn = {
  interrupting: boolean
  interruptSent: boolean
  idle: ReturnType<typeof setTimeout> | undefined
  settled: Promise<void>
  settle: () => void
}

type Pending = { rpcId: string | number; plan: ApprovalPlan; resolve: (result: unknown) => void }

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })

function idsOf(params: unknown): { threadId?: string; turnId?: string } {
  if (typeof params !== 'object' || params === null) return {}
  const p = params as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } }
  const turnId = typeof p.turnId === 'string' ? p.turnId : p.turn?.id
  return {
    ...(typeof p.threadId === 'string' ? { threadId: p.threadId } : {}),
    ...(typeof turnId === 'string' ? { turnId } : {}),
  }
}

/**
 * Una conversación viva con `codex app-server`: un proceso, un hilo (`threadId` = `providerSessionId`), un
 * turno a la vez. Traduce notificaciones con `CodexTranslator` y responde a las solicitudes de aprobación
 * del servidor cuando el usuario elige (`respond`).
 *
 * Garantías: un `turn-end` por `send` (por `turn/completed`, o sintético si Codex no responde a la
 * interrupción o se agota el plazo); si el proceso muere llegan un bloque `error` fatal y `exit`, sin
 * `turn-end`; las aprobaciones que llegan tras interrumpir (o sin turno) se cancelan sin mostrarse.
 */
export class CodexSession implements AgentProviderSession {
  readonly providerSessionId: string
  readonly #client: CodexClient
  readonly #model: string | undefined
  readonly #effort: string | undefined
  readonly #permissionMode: PermissionMode
  readonly #limits: SessionLimits
  readonly #log: (entry: LogEntry) => void
  readonly #translator: CodexTranslator
  readonly #listeners = new Set<(event: ProviderEvent) => void>()
  readonly #pending = new Map<string, Pending>()
  /** Turnos ya terminados: sus notificaciones tardías no se atribuyen al turno siguiente. */
  readonly #ended: string[] = []
  #refs = 0
  #requests = 0
  #announced = false
  #closed = false
  #exited = false
  #active: Turn | undefined
  #closing: Promise<void> | undefined

  constructor(options: {
    client: CodexClient
    threadId: string
    model?: string | undefined
    effort?: string | undefined
    permissionMode: PermissionMode
    limits: SessionLimits
    log: (entry: LogEntry) => void
  }) {
    this.providerSessionId = options.threadId
    this.#client = options.client
    this.#model = options.model
    this.#effort = options.effort
    this.#permissionMode = options.permissionMode
    this.#limits = options.limits
    this.#log = options.log
    this.#translator = new CodexTranslator({ nextRef: () => `item-${++this.#refs}` })
    options.client.setHandlers({
      onNotification: (n) => this.#onNotification(n),
      onRequest: (r) => this.#onRequest(r),
    })
    options.client.onExit((info) => this.#onExit(info))
  }

  onEvent(listener: (event: ProviderEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async send(text: string): Promise<void> {
    if (this.#closed) throw new AgentProviderError('CLOSED', 'la sesión está cerrada')
    if (text.length === 0) throw new AgentProviderError('INVALID_OPTIONS', 'mensaje vacío')
    if (this.#active !== undefined) throw new AgentProviderError('BUSY', 'ya hay un turno en curso')
    if (!this.#announced) {
      this.#announced = true
      this.#emit({
        type: 'session-info',
        providerSessionId: this.providerSessionId,
        ...(this.#model !== undefined && Token.safeParse(this.#model).success
          ? { model: this.#model }
          : {}),
        ...(this.#effort === undefined ? {} : { effort: this.#effort }),
        permissionMode: this.#permissionMode,
      })
    }
    let settle: () => void = () => {}
    const turn: Turn = {
      interrupting: false,
      interruptSent: false,
      idle: undefined,
      settled: new Promise<void>((r) => {
        settle = r
      }),
      settle: () => settle(),
    }
    this.#active = turn
    this.#translator.beginTurn()
    this.#touch(turn)
    try {
      const res = await this.#client.call(
        'turn/start',
        {
          threadId: this.providerSessionId,
          input: [{ type: 'text', text, text_elements: [] }],
          ...(this.#model === undefined ? {} : { model: this.#model }),
          ...(this.#effort === undefined ? {} : { effort: this.#effort }),
        },
        TurnResult,
        this.#limits.requestTimeoutMs,
      )
      if (this.#active === turn) {
        this.#translator.setTurnId(res.turn.id)
        if (turn.interrupting) this.#sendInterrupt(turn)
      }
    } catch (error) {
      if (this.#active === turn) {
        this.#translator.end('error')
        this.#finishTurn(turn)
      }
      if (this.#closed) throw new AgentProviderError('CLOSED', 'la sesión está cerrada')
      throw new AgentProviderError(
        'UNAVAILABLE',
        `Codex rechazó el turno: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.#active
    if (turn === undefined || this.#closed) return
    if (!turn.interrupting) {
      turn.interrupting = true
      this.#translator.markInterrupted()
      this.#cancelApprovals(true)
      this.#sendInterrupt(turn)
    }
    await Promise.race([turn.settled, delay(this.#limits.interruptGraceMs)])
    if (this.#active === turn) this.#emitAll(turn, this.#translator.end('interrupted'))
  }

  respond(response: AgentResponse): Promise<void> {
    if (response.type !== 'permission') {
      return Promise.reject(new AgentProviderError('UNKNOWN_REQUEST', 'Codex no hace preguntas'))
    }
    const pending = this.#pending.get(response.requestId)
    if (pending === undefined) {
      return Promise.reject(
        new AgentProviderError('UNKNOWN_REQUEST', `no hay una solicitud ${response.requestId}`),
      )
    }
    if (!Object.hasOwn(pending.plan.responses, response.optionId)) {
      return Promise.reject(
        new AgentProviderError('INVALID_OPTIONS', `opción desconocida: ${response.optionId}`),
      )
    }
    this.#pending.delete(response.requestId)
    pending.resolve(pending.plan.responses[response.optionId])
    if (this.#active !== undefined) this.#touch(this.#active)
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    this.#closed = true
    this.#cancelApprovals(false)
    const turn = this.#active
    if (turn !== undefined) this.#finishTurn(turn)
    this.#client.close()
    const info = await Promise.race([this.#client.exited, delay(3500).then(() => undefined)])
    this.#emitExit(info ?? { exitCode: null, signal: 'SIGKILL' })
  }

  // ---- entrada de Codex ----

  #onNotification(n: IncomingNotification): void {
    if (this.#closed) return
    const ids = idsOf(n.params)
    if (ids.threadId !== undefined && ids.threadId !== this.providerSessionId) return
    if (n.method === 'serverRequest/resolved') {
      this.#onResolved(n.params)
      return
    }
    if (ids.turnId !== undefined && this.#ended.includes(ids.turnId)) return
    const turn = this.#active
    if (turn === undefined) return
    this.#touch(turn)
    const events = this.#translator.notification(n.method, n.params)
    if (turn.interrupting && this.#translator.turnId !== undefined) this.#sendInterrupt(turn)
    this.#emitAll(turn, events)
  }

  #onRequest(request: IncomingRequest): unknown {
    const plan = planApproval(request.method, request.params)
    if (plan === undefined) {
      this.#log({ level: 'debug', message: `solicitud no soportada de codex: ${request.method}` })
      throw new RpcError(ErrorCodes.methodNotFound, `método no soportado: ${request.method}`)
    }
    const { threadId } = idsOf(request.params)
    const turn = this.#active
    if (
      this.#closed ||
      turn === undefined ||
      turn.interrupting ||
      this.#translator.finished ||
      (threadId !== undefined && threadId !== this.providerSessionId)
    ) {
      // Llega tras interrumpir (o fuera de turno): no se le muestra al usuario, se cancela.
      return plan.cancel
    }
    const requestId = `req-${++this.#requests}`
    return new Promise<unknown>((resolve) => {
      this.#pending.set(requestId, { rpcId: request.id, plan, resolve })
      this.#touch(turn)
      this.#emit({
        type: 'permission-request',
        requestId,
        tool: plan.tool,
        title: plan.title,
        ...(plan.detail === undefined ? {} : { detail: plan.detail }),
        options: plan.options,
      })
    })
  }

  #onResolved(params: unknown): void {
    const rpcId = CodexTranslator.resolvedRequest(params)
    if (rpcId === undefined) return
    for (const [requestId, p] of this.#pending) {
      if (p.rpcId !== rpcId) continue
      this.#pending.delete(requestId)
      this.#emit({ type: 'request-cancelled', requestId })
      p.resolve(p.plan.cancel)
    }
  }

  #onExit(info: ExitInfo): void {
    if (this.#exited) return
    if (!this.#closed) {
      this.#closed = true
      const tail = this.#client.stderrTail()
      const how =
        info.error === undefined
          ? `terminó de forma inesperada (código ${info.exitCode ?? 'ninguno'}${info.signal === null ? '' : `, señal ${info.signal}`})`
          : `no se pudo lanzar: ${info.error.message}`
      this.#deliver({
        type: 'error',
        error: {
          code: 'CODEX_EXITED',
          message:
            `«codex app-server» ${how}.${tail === '' ? '' : ` Últimas líneas de stderr: ${tail.slice(-600)}`}`.replace(
              /\s+/g,
              ' ',
            ),
          fatal: true,
        },
      })
    }
    this.#cancelApprovals(false)
    const turn = this.#active
    if (turn !== undefined) this.#finishTurn(turn)
    this.#emitExit(info)
  }

  // ---- salida ----

  #emitExit(info: ExitInfo): void {
    if (this.#exited) return
    this.#exited = true
    this.#deliver({
      type: 'exit',
      exitCode: info.exitCode,
      signal: info.signal === null ? null : info.signal.slice(0, 32),
    })
  }

  #emit(event: ProviderEvent): void {
    if (this.#closed) return
    this.#deliver(event)
  }

  #deliver(event: ProviderEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#log({ level: 'warn', message: `un oyente falló: ${String(error)}` })
      }
    }
  }

  #emitAll(turn: Turn, events: ProviderEvent[]): void {
    for (const event of events) {
      if (event.type === 'turn-end') this.#finishTurn(turn)
      this.#emit(event)
    }
  }

  /** Libera la sesión para el siguiente `send` y recuerda el turno como terminado. */
  #finishTurn(turn: Turn): void {
    if (turn.idle !== undefined) clearTimeout(turn.idle)
    turn.idle = undefined
    if (this.#active === turn) {
      this.#active = undefined
      const id = this.#translator.turnId
      if (id !== undefined) {
        this.#ended.push(id)
        if (this.#ended.length > 16) this.#ended.shift()
      }
    }
    turn.settle()
  }

  #sendInterrupt(turn: Turn): void {
    const turnId = this.#translator.turnId
    if (turn.interruptSent || turnId === undefined) return
    turn.interruptSent = true
    this.#client
      .request(
        'turn/interrupt',
        { threadId: this.providerSessionId, turnId },
        this.#limits.requestTimeoutMs,
      )
      .catch((error: unknown) => {
        this.#log({ level: 'debug', message: `turn/interrupt falló: ${String(error)}` })
      })
  }

  #cancelApprovals(announce: boolean): void {
    for (const [requestId, p] of [...this.#pending]) {
      this.#pending.delete(requestId)
      if (announce) this.#emit({ type: 'request-cancelled', requestId })
      p.resolve(p.plan.cancel)
    }
  }

  /** Reinicia el plazo de inactividad; mientras haya aprobaciones pendientes el usuario es quien tarda. */
  #touch(turn: Turn): void {
    if (turn.idle !== undefined) clearTimeout(turn.idle)
    turn.idle = undefined
    if (this.#pending.size > 0) return
    turn.idle = setTimeout(() => this.#onIdle(turn), this.#limits.idleTimeoutMs)
    turn.idle.unref()
  }

  #onIdle(turn: Turn): void {
    if (this.#active !== turn || this.#closed) return
    this.#log({ level: 'warn', message: 'turno de codex sin actividad: se da por fallido' })
    turn.interrupting = true
    this.#sendInterrupt(turn)
    this.#emitAll(
      turn,
      this.#translator.end('error', {
        code: 'TIMEOUT',
        message: `Codex no dio señales durante ${Math.round(this.#limits.idleTimeoutMs / 1000)} s; se cortó el turno.`,
        retryable: true,
      }),
    )
  }
}
