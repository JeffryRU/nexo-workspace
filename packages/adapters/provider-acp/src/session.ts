import { type PermissionMode, type ProviderEvent, Token, type TurnUsage } from '@nexo/contracts'
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
  RpcClosedError,
  RpcError,
} from '@nexo/jsonrpc'
import type { AcpClient, LogEntry } from './client.ts'
import {
  CANCELLED,
  type PermissionOutcome,
  type PermissionPlan,
  planPermission,
} from './permissions.ts'
import type { ExitInfo } from './process.ts'
import { AcpErrorCodes, PromptResult, SessionNotification } from './protocol.ts'
import { AcpTranslator, stopReasonOf, type TurnProblem } from './translator.ts'

export type SessionLimits = {
  /** Sin ninguna actualización del agente durante este tiempo (y sin permisos pendientes) el turno falla. */
  idleTimeoutMs: number
  /** Tras `session/cancel`, cuánto se espera la respuesta de `session/prompt` antes de cerrar el turno por nuestra cuenta. */
  interruptGraceMs: number
  /** Plazo de las solicitudes cortas (`session/set_mode`...). */
  requestTimeoutMs: number
  /** Plazo de `initialize`, `session/new` y `session/load` (un agente real tarda en arrancar). */
  startupTimeoutMs: number
}

export const DEFAULT_LIMITS: SessionLimits = {
  idleTimeoutMs: 600_000,
  interruptGraceMs: 3000,
  requestTimeoutMs: 30_000,
  startupTimeoutMs: 60_000,
}

type Turn = {
  interrupting: boolean
  idle: ReturnType<typeof setTimeout> | undefined
  settled: Promise<void>
  settle: () => void
  startedAt: number
}

type Pending = {
  rpcId: string | number
  plan: PermissionPlan
  resolve: (outcome: PermissionOutcome) => void
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })

const count = (v: number | null | undefined): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(Math.round(v)) && v >= 0 ? Math.round(v) : undefined

/** Uso del turno que informa el agente en la respuesta de `session/prompt` (esquema inestable). */
function usageOf(result: PromptResult, durationMs: number): TurnUsage {
  const u = result.usage
  const usage: TurnUsage = {}
  const set = <K extends keyof TurnUsage>(key: K, value: number | undefined) => {
    if (value !== undefined) usage[key] = value
  }
  if (u !== undefined && u !== null) {
    set('inputTokens', count(u.inputTokens))
    set('outputTokens', count(u.outputTokens))
    set('cacheReadTokens', count(u.cachedReadTokens))
    set('cacheWriteTokens', count(u.cachedWriteTokens))
    set('reasoningTokens', count(u.thoughtTokens))
  }
  set('durationMs', Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : undefined)
  return usage
}

/**
 * Una conversación viva con un agente ACP: un proceso, una sesión (`sessionId` = `providerSessionId`), un
 * turno a la vez. Traduce `session/update` con `AcpTranslator` y responde a `session/request_permission`
 * cuando el usuario elige (`respond`).
 *
 * Garantías: un `turn-end` por `send` (por la respuesta de `session/prompt`, o sintético si el agente no
 * responde a `session/cancel` o se agota el plazo); si el proceso muere llegan un bloque `error` fatal y
 * `exit`, sin `turn-end`; los permisos que llegan tras interrumpir (o sin turno) se cancelan sin mostrarse.
 * Las actualizaciones que el agente emite mientras carga una sesión (la reproducción del historial) llegan
 * antes de que exista esta clase y se descartan: Nexo no reproduce lo que ya conserva su propio documento.
 */
export class AcpSession implements AgentProviderSession {
  readonly providerSessionId: string
  readonly #client: AcpClient
  readonly #model: string | undefined
  readonly #permissionMode: PermissionMode
  readonly #limits: SessionLimits
  readonly #log: (entry: LogEntry) => void
  readonly #now: () => number
  readonly #label: string
  readonly #translator: AcpTranslator
  readonly #listeners = new Set<(event: ProviderEvent) => void>()
  readonly #pending = new Map<string, Pending>()
  #refs = 0
  #requests = 0
  #announced = false
  #memory: string | undefined
  #closed = false
  #exited = false
  #active: Turn | undefined
  #closing: Promise<void> | undefined

  constructor(options: {
    client: AcpClient
    sessionId: string
    model?: string | undefined
    permissionMode: PermissionMode
    /** Modo de sesión del agente → modo normalizado. */
    mapMode: (id: string) => PermissionMode | undefined
    limits: SessionLimits
    log: (entry: LogEntry) => void
    now?: () => number
    label: string
    /** Carpeta de la sesión (rutas relativas en las acciones). */
    cwd?: string | undefined
    /** Bloque de memoria: va como primer bloque de contenido del primer `session/prompt`. */
    memory?: string | undefined
  }) {
    this.providerSessionId = options.sessionId
    this.#client = options.client
    this.#model = options.model
    this.#permissionMode = options.permissionMode
    this.#limits = options.limits
    this.#log = options.log
    this.#now = options.now ?? Date.now
    this.#label = options.label
    this.#memory = options.memory
    this.#translator = new AcpTranslator({
      nextRef: () => `blk-${++this.#refs}`,
      mapMode: options.mapMode,
      cwd: options.cwd,
    })
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

  send(text: string): Promise<void> {
    if (this.#closed)
      return Promise.reject(new AgentProviderError('CLOSED', 'la sesión está cerrada'))
    if (text.length === 0) {
      return Promise.reject(new AgentProviderError('INVALID_OPTIONS', 'mensaje vacío'))
    }
    if (this.#active !== undefined) {
      return Promise.reject(new AgentProviderError('BUSY', 'ya hay un turno en curso'))
    }
    if (!this.#announced) {
      this.#announced = true
      this.#emit({
        type: 'session-info',
        providerSessionId: this.providerSessionId,
        ...(this.#model !== undefined && Token.safeParse(this.#model).success
          ? { model: this.#model }
          : {}),
        permissionMode: this.#permissionMode,
      })
    }
    let settle: () => void = () => {}
    const turn: Turn = {
      interrupting: false,
      idle: undefined,
      settled: new Promise<void>((r) => {
        settle = r
      }),
      settle: () => settle(),
      startedAt: this.#now(),
    }
    this.#active = turn
    this.#translator.beginTurn()
    this.#touch(turn)
    // `session/prompt` no tiene acuse: su respuesta es el fin del turno, y puede tardar lo que tarde el agente.
    this.#client
      .call(
        'session/prompt',
        { sessionId: this.providerSessionId, prompt: this.#promptFor(text) },
        PromptResult,
        0,
      )
      .then(
        (result) => this.#onPromptResult(turn, result),
        (error: unknown) => this.#onPromptError(turn, error),
      )
    return Promise.resolve()
  }

  /** Contenido del `session/prompt`: la memoria solo precede al primer mensaje. */
  #promptFor(text: string): { type: 'text'; text: string }[] {
    const memory = this.#memory
    this.#memory = undefined
    return memory === undefined
      ? [{ type: 'text', text }]
      : [
          { type: 'text', text: memory },
          { type: 'text', text },
        ]
  }

  async interrupt(): Promise<void> {
    const turn = this.#active
    if (turn === undefined || this.#closed) return
    if (!turn.interrupting) {
      turn.interrupting = true
      this.#translator.markInterrupted()
      this.#cancelApprovals(true)
      // Notificación, no solicitud: el agente responde al `session/prompt` pendiente con `cancelled`.
      this.#client.notify('session/cancel', { sessionId: this.providerSessionId })
    }
    await Promise.race([turn.settled, delay(this.#limits.interruptGraceMs)])
    if (this.#active === turn) this.#emitAll(turn, this.#translator.end('interrupted'))
  }

  respond(response: AgentResponse): Promise<void> {
    if (response.type !== 'permission') {
      return Promise.reject(
        new AgentProviderError('UNKNOWN_REQUEST', `${this.#label} no hace preguntas`),
      )
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
    pending.resolve({
      outcome: { outcome: 'selected', optionId: pending.plan.responses[response.optionId] ?? '' },
    })
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

  // ---- entrada del agente ----

  #onNotification(n: IncomingNotification): void {
    if (this.#closed) return
    if (n.method === '$/cancel_request') {
      this.#onCancelRequest(n.params)
      return
    }
    if (n.method !== 'session/update') {
      this.#log({ level: 'debug', message: `notificación ignorada de ${this.#label}: ${n.method}` })
      return
    }
    const head = SessionNotification.safeParse(n.params)
    if (!head.success || head.data.sessionId !== this.providerSessionId) return
    const turn = this.#active
    if (turn === undefined) {
      // Fuera de turno solo importan los cambios de modo y de título.
      for (const event of this.#translator.notification(n.params)) this.#emit(event)
      return
    }
    this.#touch(turn)
    this.#emitAll(turn, this.#translator.notification(n.params))
  }

  #onRequest(request: IncomingRequest): unknown {
    if (request.method !== 'session/request_permission') {
      // Nexo no ofrece `fs` ni `terminal` (ni elicitation): el agente no debería pedirlos.
      this.#log({
        level: 'debug',
        message: `solicitud no soportada de ${this.#label}: ${request.method}`,
      })
      throw new RpcError(ErrorCodes.methodNotFound, `método no soportado: ${request.method}`)
    }
    const plan = planPermission(request.params)
    const sessionId = (request.params as { sessionId?: unknown } | null)?.sessionId
    const turn = this.#active
    if (
      plan === undefined ||
      this.#closed ||
      turn === undefined ||
      turn.interrupting ||
      this.#translator.finished ||
      (sessionId !== undefined && sessionId !== this.providerSessionId)
    ) {
      // Llega tras interrumpir (o fuera de turno, o sin opciones válidas): no se muestra, se cancela.
      return CANCELLED
    }
    const requestId = `req-${++this.#requests}`
    return new Promise<PermissionOutcome>((resolve) => {
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

  /** `$/cancel_request`: el agente retira una solicitud suya (p. ej. un permiso) que seguía pendiente. */
  #onCancelRequest(params: unknown): void {
    const id = (params as { requestId?: unknown } | null)?.requestId
    if (typeof id !== 'string' && typeof id !== 'number') return
    for (const [requestId, p] of this.#pending) {
      if (p.rpcId !== id) continue
      this.#pending.delete(requestId)
      this.#emit({ type: 'request-cancelled', requestId })
      p.resolve(CANCELLED)
    }
  }

  #onPromptResult(turn: Turn, raw: PromptResult): void {
    if (this.#active !== turn || this.#closed) return
    const usage = usageOf(raw, this.#now() - turn.startedAt)
    this.#emitAll(turn, this.#translator.end(stopReasonOf(raw.stopReason), { usage }))
  }

  #onPromptError(turn: Turn, error: unknown): void {
    // Con el proceso muerto o la sesión cerrada, `#onExit`/`#close` ya cerraron el turno.
    if (this.#active !== turn || this.#closed || error instanceof RpcClosedError) return
    let problem: TurnProblem
    let stop: 'error' | 'interrupted' = 'error'
    if (error instanceof RpcError && error.code === AcpErrorCodes.authRequired) {
      problem = {
        code: 'AUTH_REQUIRED',
        fatal: true,
        message: `${this.#label} pide autenticación. Inicia sesión en su CLI desde una terminal y vuelve a abrir el agente (Nexo no inicia sesión por ti).`,
      }
    } else if (error instanceof RpcError && error.code === AcpErrorCodes.requestCancelled) {
      stop = 'interrupted'
      problem = { code: 'ACP_CANCELLED', message: 'El agente canceló el turno.' }
    } else {
      problem = {
        code: 'ACP_ERROR',
        message: `${this.#label} rechazó el turno: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    this.#emitAll(turn, this.#translator.end(stop, stop === 'interrupted' ? {} : { problem }))
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
          code: 'ACP_EXITED',
          message:
            `${this.#label} ${how}.${tail === '' ? '' : ` Últimas líneas de stderr: ${tail.slice(-600)}`}`.replace(
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

  /** Libera la sesión para el siguiente `send`. */
  #finishTurn(turn: Turn): void {
    if (turn.idle !== undefined) clearTimeout(turn.idle)
    turn.idle = undefined
    if (this.#active === turn) this.#active = undefined
    turn.settle()
  }

  #cancelApprovals(announce: boolean): void {
    for (const [requestId, p] of [...this.#pending]) {
      this.#pending.delete(requestId)
      if (announce) this.#emit({ type: 'request-cancelled', requestId })
      p.resolve(CANCELLED)
    }
  }

  /** Reinicia el plazo de inactividad; mientras haya permisos pendientes el usuario es quien tarda. */
  #touch(turn: Turn): void {
    if (turn.idle !== undefined) clearTimeout(turn.idle)
    turn.idle = undefined
    if (this.#pending.size > 0) return
    turn.idle = setTimeout(() => this.#onIdle(turn), this.#limits.idleTimeoutMs)
    turn.idle.unref()
  }

  #onIdle(turn: Turn): void {
    if (this.#active !== turn || this.#closed) return
    this.#log({
      level: 'warn',
      message: `turno de ${this.#label} sin actividad: se da por fallido`,
    })
    turn.interrupting = true
    this.#client.notify('session/cancel', { sessionId: this.providerSessionId })
    this.#emitAll(
      turn,
      this.#translator.end('error', {
        problem: {
          code: 'TIMEOUT',
          message: `${this.#label} no dio señales durante ${Math.round(this.#limits.idleTimeoutMs / 1000)} s; se cortó el turno.`,
          retryable: true,
        },
      }),
    )
  }
}
