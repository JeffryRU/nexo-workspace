import {
  LIMITS,
  type ProviderEvent,
  type StopReason,
  sanitizeBodyText,
  type TurnUsage,
} from '@nexo/contracts'
import type { z } from 'zod'
import { type ActionDraft, actionDraft, parseChanges } from './items.ts'
import {
  AgentMessageItem,
  type Breakdown,
  ErrorNotification,
  ItemNotification,
  PatchUpdated,
  ReasoningItem,
  ResolvedNotification,
  SummaryDelta,
  TextDelta,
  TokenUsageNotification,
  TurnNotification,
} from './protocol.ts'
import { line, splitDelta, TextCarry } from './text.ts'

/**
 * Traducción pura de las notificaciones de `codex app-server` (items, deltas, uso, fin de turno) a
 * `ProviderEvent`. Sin E/S: una máquina de estados por sesión; el turno se abre con `beginTurn()` y acaba
 * con exactamente un `turn-end` (por `turn/completed` o por `end()` si la sesión lo corta). Lo que no se
 * reconoce o no cumple el esquema se ignora y se cuenta (`ignored`). Esquema: `protocol.ts`.
 */

export type TurnProblem = { code: string; message: string; fatal?: boolean; retryable?: boolean }

type TextState = {
  kind: 'text' | 'reasoning'
  ref: string
  started: boolean
  carry: TextCarry
  acc: string
  summaryIndex: number
}
type ActionState = {
  kind: 'action'
  ref: string
  started: boolean
  draft: ActionDraft
  output: string
  carry: TextCarry
  raw: Record<string, unknown>
}
type ItemState = TextState | ActionState

/** Tope de lo que se retiene de un item para compararlo con su versión final. */
const KEEP_CHARS = LIMITS.maxBlockTextBytes

const count = (v: number | undefined): number =>
  typeof v === 'number' && v > 0 && Number.isSafeInteger(Math.round(v)) ? Math.round(v) : 0

function stopReasonOf(status: string | undefined): StopReason {
  switch (status) {
    case 'completed':
      return 'end-turn'
    case 'interrupted':
      return 'interrupted'
    case 'failed':
      return 'error'
    default:
      return 'other'
  }
}

/** Código y mensaje en español a partir de `codexErrorInfo` (cadena u objeto de una clave). */
export function classifyError(message: string, info: unknown): TurnProblem {
  const key =
    typeof info === 'string'
      ? info
      : typeof info === 'object' && info !== null
        ? (Object.keys(info)[0] ?? '')
        : ''
  const detail = line(message, 1500, 'error desconocido')
  switch (key) {
    case 'unauthorized':
      return {
        code: 'AUTH_REQUIRED',
        fatal: true,
        message:
          'Codex no tiene la sesión iniciada o caducó. Ejecuta «codex login» en una terminal y vuelve a abrir el agente.',
      }
    case 'usageLimitExceeded':
    case 'sessionBudgetExceeded':
      return { code: 'USAGE_LIMIT', message: `Se alcanzó el límite de uso de Codex: ${detail}` }
    case 'rateLimitExceeded':
      return { code: 'RATE_LIMIT', retryable: true, message: `Codex limitó el ritmo: ${detail}` }
    case 'contextWindowExceeded':
      return {
        code: 'CONTEXT_WINDOW',
        message: `La conversación superó la ventana de contexto del modelo: ${detail}`,
      }
    case 'serverOverloaded':
    case 'internalServerError':
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
      return { code: 'CODEX_UNAVAILABLE', retryable: true, message: `Codex falló: ${detail}` }
    default:
      return { code: 'CODEX_ERROR', message: `Codex informó un error: ${detail}` }
  }
}

export class CodexTranslator {
  readonly #nextRef: () => string
  #items = new Map<string, ItemState>()
  #turnId: string | undefined
  #finished = true
  #stopReason: StopReason | undefined
  #interrupted = false
  #errorShown = false
  #ignored = 0
  #lastTotal: Breakdown | undefined
  #baseline: Breakdown | undefined
  #turnUsage: TurnUsage | undefined

  constructor(options: { nextRef: () => string }) {
    this.#nextRef = options.nextRef
  }

  /** `true` si no hay turno en curso (o ya emitió su `turn-end`). */
  get finished(): boolean {
    return this.#finished
  }
  get stopReason(): StopReason | undefined {
    return this.#stopReason
  }
  /** Notificaciones o items descartados por no cumplir el esquema (diagnóstico). */
  get ignored(): number {
    return this.#ignored
  }
  get turnId(): string | undefined {
    return this.#turnId
  }

  beginTurn(): void {
    this.#items = new Map()
    this.#turnId = undefined
    this.#finished = false
    this.#stopReason = undefined
    this.#interrupted = false
    this.#errorShown = false
    this.#turnUsage = undefined
    this.#baseline = this.#lastTotal
  }

  setTurnId(id: string): void {
    if (this.#turnId === undefined) this.#turnId = id
  }

  /** El usuario pidió interrumpir: el turno acaba como `interrupted` aunque Codex lo marque completado. */
  markInterrupted(): void {
    this.#interrupted = true
  }

  /** Procesa una notificación del servidor ya filtrada por hilo. Devuelve los eventos resultantes. */
  notification(method: string, params: unknown): ProviderEvent[] {
    if (this.#finished) return []
    switch (method) {
      case 'turn/started': {
        const p = TurnNotification.safeParse(params)
        if (p.success) this.setTurnId(p.data.turn.id)
        return []
      }
      case 'turn/completed':
        return this.#completed(params)
      case 'item/started':
        return this.#itemStarted(params)
      case 'item/completed':
        return this.#itemCompleted(params)
      case 'item/agentMessage/delta': {
        const p = this.#parse(TextDelta, params)
        return p === undefined ? [] : this.#textDelta(p.itemId, 'text', p.delta)
      }
      case 'item/reasoning/summaryTextDelta': {
        const p = this.#parse(SummaryDelta, params)
        return p === undefined ? [] : this.#summaryDelta(p.itemId, p.summaryIndex, p.delta)
      }
      case 'item/commandExecution/outputDelta': {
        const p = this.#parse(TextDelta, params)
        return p === undefined ? [] : this.#outputDelta(p.itemId, p.delta)
      }
      case 'item/fileChange/patchUpdated':
        return this.#patchUpdated(params)
      case 'thread/tokenUsage/updated':
        return this.#tokenUsage(params)
      case 'error':
        return this.#errorNotification(params)
      default:
        return []
    }
  }

  /** Cierra el turno por una causa externa (interrupción sin respuesta, plazo, fallo). Idempotente. */
  end(stopReason: StopReason, problem?: TurnProblem): ProviderEvent[] {
    if (this.#finished) return []
    const events = this.#closeAll()
    if (problem !== undefined) events.push(this.#errorEvent(problem))
    return this.#finish(stopReason, events, undefined)
  }

  /** `serverRequest/resolved`: devuelve el id de la solicitud resuelta, si la notificación es válida. */
  static resolvedRequest(params: unknown): string | number | undefined {
    const p = ResolvedNotification.safeParse(params)
    return p.success ? p.data.requestId : undefined
  }

  #parse<S extends z.ZodType>(schema: S, v: unknown): z.infer<S> | undefined {
    const r = schema.safeParse(v)
    if (r.success) return r.data
    this.#ignored++
    return undefined
  }

  // ---- items ----

  #itemStarted(params: unknown): ProviderEvent[] {
    const p = this.#parse(ItemNotification, params)
    if (p === undefined) return []
    if (this.#staleTurn(p.turnId)) return []
    return this.#open(p.item as Record<string, unknown>, false)
  }

  #itemCompleted(params: unknown): ProviderEvent[] {
    const p = this.#parse(ItemNotification, params)
    if (p === undefined) return []
    if (this.#staleTurn(p.turnId)) return []
    const raw = p.item as Record<string, unknown>
    const events: ProviderEvent[] = []
    let state = this.#items.get(p.item.id)
    if (state === undefined) {
      events.push(...this.#open(raw, true))
      state = this.#items.get(p.item.id)
      if (state === undefined) return events
    }
    if (state.kind === 'action') {
      state.raw = raw
      return [...events, ...this.#closeAction(p.item.id, state, 'completed')]
    }
    const full = this.#finalText(state.kind, raw)
    if (full !== undefined) events.push(...this.#reconcile(state, full))
    return [...events, ...this.#closeText(p.item.id, state)]
  }

  #staleTurn(turnId: string): boolean {
    if (this.#turnId === undefined) {
      this.#turnId = turnId
      return false
    }
    return turnId !== this.#turnId
  }

  /** Alta de un item. `completed` indica que llega ya terminado (sin `item/started` previo). */
  #open(raw: Record<string, unknown>, completed: boolean): ProviderEvent[] {
    const id = raw.id as string
    if (this.#items.has(id)) return []
    switch (raw.type) {
      case 'agentMessage':
      case 'reasoning': {
        const kind = raw.type === 'agentMessage' ? 'text' : 'reasoning'
        const state: TextState = {
          kind,
          ref: this.#nextRef(),
          started: false,
          carry: new TextCarry(),
          acc: '',
          summaryIndex: -1,
        }
        this.#items.set(id, state)
        return []
      }
      case 'plan':
      case 'userMessage':
      case 'hookPrompt':
        return []
      default: {
        const draft = actionDraft(raw, { finished: false })
        if (draft === undefined) {
          this.#ignored++
          return []
        }
        const state: ActionState = {
          kind: 'action',
          ref: this.#nextRef(),
          started: !completed,
          draft,
          output: '',
          carry: new TextCarry(),
          raw,
        }
        this.#items.set(id, state)
        return completed ? [] : [{ type: 'block-start', ref: state.ref, block: draft }]
      }
    }
  }

  #finalText(kind: 'text' | 'reasoning', raw: Record<string, unknown>): string | undefined {
    if (kind === 'text') {
      const p = AgentMessageItem.safeParse(raw)
      return p.success ? p.data.text : undefined
    }
    const p = ReasoningItem.safeParse(raw)
    if (!p.success) return undefined
    const parts = p.data.summary?.length ? p.data.summary : (p.data.content ?? [])
    return parts.join('\n\n')
  }

  #startText(state: TextState, events: ProviderEvent[]): void {
    if (state.started) return
    state.started = true
    events.push({
      type: 'block-start',
      ref: state.ref,
      block: { type: state.kind, text: '', complete: false },
    })
  }

  #emitText(state: TextState, raw: string, events: ProviderEvent[]): void {
    const clean = sanitizeBodyText(state.carry.push(raw))
    if (clean === '') return
    this.#startText(state, events)
    for (const part of splitDelta(clean)) {
      events.push({ type: 'block-delta', ref: state.ref, field: 'text', text: part })
    }
    if (state.acc.length < KEEP_CHARS) state.acc += clean
  }

  #textDelta(itemId: string, kind: 'text' | 'reasoning', delta: string): ProviderEvent[] {
    const state = this.#items.get(itemId)
    if (state === undefined || state.kind !== kind) return []
    const events: ProviderEvent[] = []
    this.#emitText(state, delta, events)
    return events
  }

  #summaryDelta(itemId: string, index: number, delta: string): ProviderEvent[] {
    const state = this.#items.get(itemId)
    if (state === undefined || state.kind !== 'reasoning') return []
    const events: ProviderEvent[] = []
    // Cada parte del resumen es un párrafo aparte.
    const separator = index !== state.summaryIndex && state.acc !== '' ? '\n\n' : ''
    state.summaryIndex = index
    this.#emitText(state, separator + delta, events)
    return events
  }

  /** Si el item final trae más texto que los deltas recibidos (o no hubo deltas), añade lo que falta. */
  #reconcile(state: TextState, full: string): ProviderEvent[] {
    const events: ProviderEvent[] = []
    const clean = sanitizeBodyText(full)
    if (state.acc === '') {
      if (clean !== '') this.#emitText(state, clean, events)
    } else if (clean.length > state.acc.length && clean.startsWith(state.acc)) {
      this.#emitText(state, clean.slice(state.acc.length), events)
    }
    return events
  }

  #closeText(id: string, state: TextState): ProviderEvent[] {
    this.#items.delete(id)
    const events: ProviderEvent[] = []
    const rest = sanitizeBodyText(state.carry.flush())
    if (rest !== '') {
      this.#startText(state, events)
      events.push({ type: 'block-delta', ref: state.ref, field: 'text', text: rest })
    }
    if (state.started) events.push({ type: 'block-end', ref: state.ref })
    return events
  }

  #outputDelta(itemId: string, delta: string): ProviderEvent[] {
    const state = this.#items.get(itemId)
    if (state === undefined || state.kind !== 'action' || state.draft.kind !== 'exec') return []
    const clean = sanitizeBodyText(state.carry.push(delta))
    if (clean === '') return []
    if (state.output.length < KEEP_CHARS) state.output += clean
    return splitDelta(clean).map(
      (text): ProviderEvent => ({ type: 'block-delta', ref: state.ref, field: 'output', text }),
    )
  }

  #patchUpdated(params: unknown): ProviderEvent[] {
    const p = this.#parse(PatchUpdated, params)
    if (p === undefined) return []
    const state = this.#items.get(p.itemId)
    if (state === undefined || state.kind !== 'action' || state.draft.kind !== 'edit') return []
    state.raw = { ...state.raw, changes: parseChanges(p.changes) }
    const draft = actionDraft(state.raw, { finished: false })
    if (draft === undefined) return []
    state.draft = draft
    return [{ type: 'block-update', ref: state.ref, block: draft }]
  }

  #closeAction(id: string, state: ActionState, how: 'completed' | 'aborted'): ProviderEvent[] {
    this.#items.delete(id)
    const events: ProviderEvent[] = []
    let draft: ActionDraft
    if (how === 'completed') {
      draft = actionDraft(state.raw, { finished: true, accumulated: state.output }) ?? state.draft
    } else {
      // El turno acabó sin que Codex cerrara la acción (interrupción, fallo): queda como error.
      draft = { ...state.draft, status: 'error' }
    }
    if (!state.started) {
      state.started = true
      events.push({ type: 'block-start', ref: state.ref, block: { ...draft, status: 'running' } })
    }
    events.push({ type: 'block-end', ref: state.ref, block: draft })
    return events
  }

  #closeAll(): ProviderEvent[] {
    const events: ProviderEvent[] = []
    for (const [id, state] of [...this.#items]) {
      events.push(
        ...(state.kind === 'action'
          ? this.#closeAction(id, state, 'aborted')
          : this.#closeText(id, state)),
      )
    }
    return events
  }

  // ---- uso, errores, fin de turno ----

  #tokenUsage(params: unknown): ProviderEvent[] {
    const p = this.#parse(TokenUsageNotification, params)
    if (p === undefined || this.#staleTurn(p.turnId)) return []
    const { total, last } = p.tokenUsage
    this.#lastTotal = total
    // Sin referencia previa (primer turno de un hilo reanudado), el uso anterior a esta llamada se descuenta.
    this.#baseline ??= {
      inputTokens: Math.max(0, count(total.inputTokens) - count(last.inputTokens)),
      cachedInputTokens: Math.max(
        0,
        count(total.cachedInputTokens) - count(last.cachedInputTokens),
      ),
      cacheWriteInputTokens: Math.max(
        0,
        count(total.cacheWriteInputTokens) - count(last.cacheWriteInputTokens),
      ),
      outputTokens: Math.max(0, count(total.outputTokens) - count(last.outputTokens)),
      reasoningOutputTokens: Math.max(
        0,
        count(total.reasoningOutputTokens) - count(last.reasoningOutputTokens),
      ),
    }
    const base = this.#baseline
    const diff = (a: number | undefined, b: number | undefined) => Math.max(0, count(a) - count(b))
    const usage: TurnUsage = {
      inputTokens: diff(total.inputTokens, base.inputTokens),
      outputTokens: diff(total.outputTokens, base.outputTokens),
      cacheReadTokens: diff(total.cachedInputTokens, base.cachedInputTokens),
      cacheWriteTokens: diff(total.cacheWriteInputTokens, base.cacheWriteInputTokens),
      reasoningTokens: diff(total.reasoningOutputTokens, base.reasoningOutputTokens),
    }
    this.#turnUsage = usage
    return [{ type: 'usage', usage }]
  }

  #errorEvent(problem: TurnProblem): ProviderEvent {
    return {
      type: 'error',
      error: {
        code: problem.code,
        message: line(problem.message, 2000, 'Error de Codex'),
        fatal: problem.fatal ?? false,
        ...(problem.retryable === undefined ? {} : { retryable: problem.retryable }),
      },
    }
  }

  #errorNotification(params: unknown): ProviderEvent[] {
    const p = this.#parse(ErrorNotification, params)
    if (p === undefined) return []
    if (p.turnId !== undefined && this.#staleTurn(p.turnId)) return []
    // Con reintento, Codex vuelve a intentarlo solo: no es un error para el usuario.
    if (p.willRetry === true) return []
    this.#errorShown = true
    return [this.#errorEvent(classifyError(p.error.message, p.error.codexErrorInfo))]
  }

  #completed(params: unknown): ProviderEvent[] {
    const p = this.#parse(TurnNotification, params)
    if (p === undefined) return []
    if (this.#turnId !== undefined && p.turn.id !== this.#turnId) return []
    const events = this.#closeAll()
    let stop = stopReasonOf(p.turn.status)
    if (stop === 'error' && !this.#errorShown && p.turn.error) {
      events.push(
        this.#errorEvent(classifyError(p.turn.error.message, p.turn.error.codexErrorInfo)),
      )
    }
    if (this.#interrupted && stop !== 'error') stop = 'interrupted'
    const duration = p.turn.durationMs
    return this.#finish(
      stop,
      events,
      typeof duration === 'number' && Number.isSafeInteger(Math.round(duration))
        ? Math.round(duration)
        : undefined,
    )
  }

  #finish(
    stop: StopReason,
    events: ProviderEvent[],
    durationMs: number | undefined,
  ): ProviderEvent[] {
    this.#finished = true
    this.#stopReason = stop
    const usage: TurnUsage = { ...this.#turnUsage }
    if (durationMs !== undefined && durationMs >= 0) usage.durationMs = durationMs
    events.push({
      type: 'turn-end',
      stopReason: stop,
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
    })
    return events
  }
}
