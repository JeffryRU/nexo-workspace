import {
  LIMITS,
  type PermissionMode,
  type ProviderEvent,
  ProviderSessionToken,
  type StopReason,
  sanitizeBodyText,
  Token,
  type TurnUsage,
} from '@nexo/contracts'
import {
  AgyEvent,
  type AgyResult,
  type AgyStepUpdate,
  type AgyToolInfo,
  type AgyUsage,
} from './protocol.ts'
import { line, splitDelta, TextCarry, truncateUtf8 } from './text.ts'
import { describeTool, type ToolDescription } from './tools.ts'

/**
 * Traducción pura de los eventos de `agy --output-format stream-json` (`init`, `step_update`, `result`) a
 * `ProviderEvent`. Sin E/S: una máquina de estados por turno (un proceso `agy` = un turno). El turno acaba con
 * exactamente un `turn-end` (por `result` o por `end()` si la sesión lo corta). Lo que no se reconoce se ignora
 * y se cuenta (`ignored`). Formato: `protocol.ts`; qué está verificado: `docs/ARCHITECTURE.md`.
 */

export type TurnProblem = { code: string; message: string; fatal?: boolean; retryable?: boolean }

type TextState = { ref: string; started: boolean; carry: TextCarry; acc: string }
type ToolState = {
  ref: string
  started: boolean
  tool: string
  parameters: unknown
}

const KEEP_CHARS = LIMITS.maxBlockTextBytes

const count = (v: number | undefined): number | undefined =>
  typeof v === 'number' && v >= 0 && Number.isSafeInteger(Math.round(v)) ? Math.round(v) : undefined

/** Uso de un turno a partir del objeto `usage` de `agy` (solo los campos presentes y válidos). */
export function usageOf(
  usage: AgyUsage | undefined,
  durationSeconds?: number,
  turns?: number,
): TurnUsage {
  const out: TurnUsage = {}
  const input = count(usage?.input_tokens)
  const output = count(usage?.output_tokens)
  const cache = count(usage?.cache_read_tokens)
  const thinking = count(usage?.thinking_tokens)
  if (input !== undefined) out.inputTokens = input
  if (output !== undefined) out.outputTokens = output
  if (cache !== undefined) out.cacheReadTokens = cache
  if (thinking !== undefined) out.reasoningTokens = thinking
  const ms = durationSeconds === undefined ? undefined : count(durationSeconds * 1000)
  if (ms !== undefined) out.durationMs = ms
  const n = count(turns)
  if (n !== undefined) out.numTurns = n
  return out
}

/** Mensaje de un `error` de `agy` (cadena, `{message}` o `{type, message}`), o `undefined`. */
export function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error === '' ? undefined : error
  if (typeof error === 'object' && error !== null) {
    const e = error as { message?: unknown; type?: unknown }
    const message = typeof e.message === 'string' ? e.message : undefined
    const type = typeof e.type === 'string' ? e.type : undefined
    if (message !== undefined && message !== '')
      return type === undefined ? message : `${type}: ${message}`
    if (type !== undefined) return type
  }
  return undefined
}

const AUTH =
  /unauthenticated|unauthori[sz]ed|\b401\b|not (?:logged|signed) in|sign[- ]?in|log[- ]?in|credential|oauth|token (?:expired|invalid)/i
const QUOTA = /quota|exhausted|resource_exhausted|\b429\b|rate.?limit|prepaid|insufficient/i
const CAPACITY = /\b503\b|capacity|overloaded|unavailable/i

/** Código y mensaje en español a partir del texto de un error de `agy`. */
export function classifyError(raw: string | undefined): TurnProblem {
  const detail = line(raw ?? '', 1500, 'error desconocido')
  if (AUTH.test(detail)) {
    return {
      code: 'AUTH_REQUIRED',
      fatal: true,
      message: `Antigravity no tiene la sesión iniciada o caducó. Ejecuta «agy» en una terminal e inicia sesión; Nexo no inicia sesión por ti. (${detail})`,
    }
  }
  if (QUOTA.test(detail)) {
    return {
      code: 'USAGE_LIMIT',
      message: `Se alcanzó el límite de uso de Antigravity: ${detail}`,
    }
  }
  if (CAPACITY.test(detail)) {
    return {
      code: 'AGY_UNAVAILABLE',
      retryable: true,
      message: `Antigravity no está disponible ahora: ${detail}`,
    }
  }
  return { code: 'AGY_ERROR', message: `Antigravity informó un error: ${detail}` }
}

function stopReasonOf(result: AgyResult): { stop: StopReason; problem?: TurnProblem } {
  const status = (result.status ?? '').toUpperCase()
  const finished = result.finished_reason
  if (finished === 'interrupted' || status === 'INTERRUPTED' || status === 'CANCELED') {
    return { stop: 'interrupted' }
  }
  if (finished === 'print_timeout') {
    return {
      stop: 'other',
      problem: {
        code: 'PRINT_TIMEOUT',
        message:
          'Antigravity cortó el turno por su plazo (--print-timeout); la respuesta es parcial.',
      },
    }
  }
  if (status === 'ERROR' || finished === 'error') {
    return { stop: 'error', problem: classifyError(errorMessage(result.error)) }
  }
  if (status === 'SUCCESS') return { stop: 'end-turn' }
  return { stop: 'other' }
}

/** Modo de permisos que informa `init.permission_mode` → modo normalizado (los desconocidos, ninguno). */
export function permissionModeOf(mode: string | undefined): PermissionMode | undefined {
  if (mode === 'request-review') return 'ask'
  if (mode === 'always-proceed') return 'bypass'
  if (mode === 'accept-edits') return 'accept-edits'
  if (mode === 'plan') return 'plan'
  return undefined
}

function outputText(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output)
  } catch {
    return undefined
  }
}

export class AgyTranslator {
  readonly #nextRef: () => string
  readonly #cwd: string
  #texts = new Map<number, TextState>()
  #tools = new Map<number, ToolState>()
  #conversationId: string | undefined
  #announced: string | undefined
  #finished = true
  #stopReason: StopReason | undefined
  #emittedText = false
  #ignored = 0
  #model: string | undefined
  #mode: PermissionMode | undefined

  constructor(options: { nextRef: () => string; cwd: string }) {
    this.#nextRef = options.nextRef
    this.#cwd = options.cwd
  }

  get finished(): boolean {
    return this.#finished
  }
  get stopReason(): StopReason | undefined {
    return this.#stopReason
  }
  get ignored(): number {
    return this.#ignored
  }
  /** Id de la conversación de `agy` (ficha para reanudar), en cuanto lo ha informado. */
  get conversationId(): string | undefined {
    return this.#conversationId
  }

  beginTurn(): void {
    this.#texts = new Map()
    this.#tools = new Map()
    this.#finished = false
    this.#stopReason = undefined
    this.#emittedText = false
    this.#announced = undefined
    this.#model = undefined
    this.#mode = undefined
  }

  /** Procesa un objeto JSON ya decodificado de una línea de stdout. */
  feed(value: unknown): ProviderEvent[] {
    if (this.#finished) return []
    const parsed = AgyEvent.safeParse(value)
    if (!parsed.success) {
      this.#ignored++
      return []
    }
    const e = parsed.data
    switch (e.event) {
      case 'init':
        return this.#init(e)
      case 'step_update':
        return e.step_update === undefined ? this.#ignore() : this.#step(e.step_update)
      case 'result':
        return e.result === undefined ? this.#ignore() : this.#result(e.result)
      default:
        return this.#ignore()
    }
  }

  /** Cierra el turno por una causa externa (interrupción, plazo, proceso muerto). Idempotente. */
  end(stopReason: StopReason, problem?: TurnProblem): ProviderEvent[] {
    if (this.#finished) return []
    const events = this.#closeAll(true)
    if (problem !== undefined) events.push(this.#errorEvent(problem))
    return this.#finish(stopReason, events, undefined)
  }

  #ignore(): ProviderEvent[] {
    this.#ignored++
    return []
  }

  #errorEvent(problem: TurnProblem): ProviderEvent {
    return {
      type: 'error',
      error: {
        code: problem.code,
        message: line(problem.message, 2000, 'Error de Antigravity'),
        fatal: problem.fatal ?? false,
        ...(problem.retryable === undefined ? {} : { retryable: problem.retryable }),
      },
    }
  }

  #learnId(id: string | undefined): void {
    if (id === undefined || !ProviderSessionToken.safeParse(id).success) return
    if (this.#conversationId === undefined) this.#conversationId = id
  }

  #init(e: AgyEvent): ProviderEvent[] {
    this.#learnId(e.conversation_id)
    const init = e.init
    const model =
      init?.model !== undefined && Token.safeParse(init.model).success ? init.model : undefined
    const mode = permissionModeOf(init?.permission_mode)
    const id = this.#conversationId
    const info: ProviderEvent = {
      type: 'session-info',
      ...(id === undefined ? {} : { providerSessionId: id }),
      ...(model === undefined ? {} : { model }),
      ...(mode === undefined ? {} : { permissionMode: mode }),
    }
    this.#announced = id
    this.#model = model
    this.#mode = mode
    return id === undefined && model === undefined && mode === undefined ? [] : [info]
  }

  // ---- pasos ----

  #step(s: AgyStepUpdate): ProviderEvent[] {
    const events: ProviderEvent[] = []
    // Un `step_update` suelto puede ser el primero en traer el id de la conversación.
    this.#learnId(s.conversation_id)
    if (this.#conversationId !== undefined && this.#announced !== this.#conversationId) {
      this.#announced = this.#conversationId
      events.push({ type: 'session-info', providerSessionId: this.#conversationId })
    }
    const index = s.step_index
    if (index === undefined) {
      this.#ignored++
      return events
    }
    const done = (s.state ?? '').toUpperCase() === 'DONE'
    switch (s.step_type) {
      case 'agent_response':
        return [...events, ...this.#agentResponse(index, s, done)]
      case 'tool':
        return [...events, ...this.#tool(index, s, done)]
      case 'user_input':
      case 'checkpoint':
        return events
      default:
        this.#ignored++
        return events
    }
  }

  #emitText(state: TextState, raw: string, events: ProviderEvent[]): void {
    const clean = sanitizeBodyText(state.carry.push(raw))
    if (clean === '') return
    if (!state.started) {
      state.started = true
      events.push({
        type: 'block-start',
        ref: state.ref,
        block: { type: 'text', text: '', complete: false },
      })
    }
    for (const part of splitDelta(clean)) {
      events.push({ type: 'block-delta', ref: state.ref, field: 'text', text: part })
    }
    this.#emittedText = true
    if (state.acc.length < KEEP_CHARS) state.acc += clean
  }

  #closeText(index: number, state: TextState): ProviderEvent[] {
    this.#texts.delete(index)
    const events: ProviderEvent[] = []
    const rest = sanitizeBodyText(state.carry.flush())
    if (rest !== '') {
      if (!state.started) {
        state.started = true
        events.push({
          type: 'block-start',
          ref: state.ref,
          block: { type: 'text', text: '', complete: false },
        })
      }
      events.push({ type: 'block-delta', ref: state.ref, field: 'text', text: rest })
    }
    if (state.started) events.push({ type: 'block-end', ref: state.ref })
    return events
  }

  /**
   * El texto llega en `text_delta`. En `ACTIVE` es siempre un trozo nuevo. En `DONE` la documentación no dice
   * si trae el último trozo o el texto completo: si empieza por lo ya recibido (y es más largo) se añade solo
   * el resto; si es idéntico y largo (≥ 16) se descarta como repetición; en otro caso es un trozo más.
   */
  #agentResponse(index: number, s: AgyStepUpdate, done: boolean): ProviderEvent[] {
    let state = this.#texts.get(index)
    if (state === undefined) {
      state = { ref: this.#nextRef(), started: false, carry: new TextCarry(), acc: '' }
      this.#texts.set(index, state)
    }
    const events: ProviderEvent[] = []
    const delta = s.text_delta
    if (delta !== undefined && delta !== '') {
      if (!done || state.acc === '') this.#emitText(state, delta, events)
      else if (delta.length > state.acc.length && delta.startsWith(state.acc)) {
        this.#emitText(state, delta.slice(state.acc.length), events)
      } else if (!(delta === state.acc && delta.length >= 16)) this.#emitText(state, delta, events)
    }
    if (done) events.push(...this.#closeText(index, state))
    return events
  }

  #tool(index: number, s: AgyStepUpdate, done: boolean): ProviderEvent[] {
    const info: AgyToolInfo | undefined = s.tool_info
    const sub = s.subagent_info?.subagents
    let state = this.#tools.get(index)
    const events: ProviderEvent[] = []
    const tool = line(
      info?.name ?? s.tool_name ?? (sub === undefined ? 'tool' : 'subagent'),
      128,
      'tool',
    )
    if (state === undefined) {
      state = { ref: this.#nextRef(), started: false, tool, parameters: info?.parameters }
      this.#tools.set(index, state)
    } else if (info?.parameters !== undefined) {
      state.parameters = info.parameters
    }
    const draft = this.#actionDraft(state, info, sub, done, s.duration_seconds)
    if (!state.started) {
      state.started = true
      events.push({
        type: 'block-start',
        ref: state.ref,
        block: done ? { ...draft, status: 'running' } : draft,
      })
    } else if (!done) {
      events.push({ type: 'block-update', ref: state.ref, block: draft })
    }
    if (done) {
      this.#tools.delete(index)
      events.push({ type: 'block-end', ref: state.ref, block: draft })
    }
    return events
  }

  #actionDraft(
    state: ToolState,
    info: AgyToolInfo | undefined,
    sub: { type_name?: string | undefined; role?: string | undefined }[] | undefined,
    done: boolean,
    durationSeconds: number | undefined,
  ) {
    const desc: ToolDescription =
      sub === undefined
        ? describeTool(state.tool, state.parameters, this.#cwd)
        : {
            kind: 'other',
            title: line(
              `Subagente ${sub.map((x) => [x.type_name, x.role].filter(Boolean).join(' ')).join(', ')}`,
              LIMITS.maxTitleLength,
              'Subagente',
            ),
          }
    const failed = info?.error !== undefined && info.error !== null
    const rawOutput = failed
      ? (errorMessage(info?.error) ?? outputText(info?.output))
      : outputText(info?.output)
    const output =
      done && rawOutput !== undefined
        ? truncateUtf8(sanitizeBodyText(rawOutput), LIMITS.maxBlockTextBytes)
        : undefined
    const ms = durationSeconds === undefined ? undefined : count(durationSeconds * 1000)
    return {
      type: 'action' as const,
      kind: desc.kind,
      status: done ? (failed ? ('error' as const) : ('ok' as const)) : ('running' as const),
      tool: state.tool,
      title: desc.title,
      ...(desc.path === undefined ? {} : { path: desc.path }),
      ...(desc.input === undefined ? {} : { input: desc.input }),
      ...(desc.kind === 'edit' && desc.diff !== undefined ? { diff: desc.diff } : {}),
      ...(output === undefined || output.text === ''
        ? {}
        : { output: output.text, ...(output.truncated ? { truncated: true } : {}) }),
      ...(ms === undefined ? {} : { durationMs: ms }),
    }
  }

  /** Cierra lo abierto. `aborted`: las acciones sin cerrar quedan como error. */
  #closeAll(aborted: boolean): ProviderEvent[] {
    const events: ProviderEvent[] = []
    for (const [index, state] of [...this.#texts]) events.push(...this.#closeText(index, state))
    for (const [index, state] of [...this.#tools]) {
      this.#tools.delete(index)
      const draft = this.#actionDraft(state, undefined, undefined, false, undefined)
      const final = { ...draft, status: aborted ? ('error' as const) : ('ok' as const) }
      if (!state.started) {
        state.started = true
        events.push({ type: 'block-start', ref: state.ref, block: { ...draft, status: 'running' } })
      }
      events.push({ type: 'block-end', ref: state.ref, block: final })
    }
    return events
  }

  // ---- resultado ----

  #result(r: AgyResult): ProviderEvent[] {
    const events: ProviderEvent[] = []
    this.#learnId(r.conversation_id)
    if (this.#conversationId !== undefined && this.#announced !== this.#conversationId) {
      this.#announced = this.#conversationId
      events.push({
        type: 'session-info',
        providerSessionId: this.#conversationId,
        ...(this.#model === undefined ? {} : { model: this.#model }),
        ...(this.#mode === undefined ? {} : { permissionMode: this.#mode }),
      })
    }
    events.push(...this.#closeAll(false))
    const { stop, problem } = stopReasonOf(r)
    // Sin texto en el flujo, la respuesta final del resultado es lo único que hay que mostrar.
    if (!this.#emittedText && typeof r.response === 'string' && r.response.trim() !== '') {
      const state: TextState = {
        ref: this.#nextRef(),
        started: false,
        carry: new TextCarry(),
        acc: '',
      }
      this.#emitText(state, r.response, events)
      if (state.started) events.push({ type: 'block-end', ref: state.ref })
    }
    if (problem !== undefined) events.push(this.#errorEvent(problem))
    return this.#finish(stop, events, usageOf(r.usage, r.duration_seconds, r.num_turns))
  }

  #finish(
    stop: StopReason,
    events: ProviderEvent[],
    usage: TurnUsage | undefined,
  ): ProviderEvent[] {
    this.#finished = true
    this.#stopReason = stop
    events.push({
      type: 'turn-end',
      stopReason: stop,
      ...(usage === undefined || Object.keys(usage).length === 0 ? {} : { usage }),
    })
    return events
  }
}
