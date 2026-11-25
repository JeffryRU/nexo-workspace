import {
  type BlockDraft,
  LIMITS,
  type PermissionMode,
  type PlanEntryStatus,
  type ProviderEvent,
  ProviderSessionToken,
  type StopReason,
  sanitizeBodyText,
  Token,
  type TurnUsage,
} from '@nexo/contracts'
import { authError, describeApiError, looksLikeAuthFailure } from './errors.ts'
import {
  AssistantMessage,
  AuthStatusMessage,
  BlockDelta,
  BlockStart,
  BlockStop,
  ContentBlock,
  MessageStart,
  ResultMessage,
  StreamEnvelope,
  SystemMessage,
  TodoWriteInput,
  ToolResultBlock,
  UserMessage,
} from './messages.ts'
import { body, line, splitDelta, TextCarry } from './text.ts'
import { describeTool, inferKind, parseExitCode } from './tools.ts'

type ActionDraft = Extract<BlockDraft, { type: 'action' }>

type OpenText = { ref: string; type: 'text' | 'reasoning'; carry: TextCarry }

type Call = {
  id: string
  name: string
  /** `action`: bloque de acción; `plan`: `TodoWrite`; `silent`: `AskUserQuestion` o sin cupo (sin bloque propio). */
  mode: 'action' | 'plan' | 'silent'
  ref?: string
  draft?: ActionDraft
  inputJson: string
  inputDone: boolean
  open: boolean
  startedAt: number
}

type Slot = { kind: 'text'; open: OpenText } | { kind: 'tool'; callId: string } | { kind: 'ignore' }

export type TranslatorStats = {
  /** Mensajes de tipos que el adaptador no usa (se ignoran a propósito). */
  ignored: number
  /** Mensajes de un tipo conocido con una forma inesperada, o fuera de orden. */
  invalid: number
  /** `tool_result` sin su `tool_use`. */
  orphanResults: number
}

export type TranslatorOptions = {
  now?: () => number
  /** Quita de todo texto de contenido los valores literales de credenciales. */
  scrub?: (text: string) => string
  /** Pasa por el redactor de secretos el texto de un error antes de mostrarlo. */
  redact?: (text: string) => string
}

/** Llamadas a herramienta por turno que se siguen individualmente; más allá no se muestran. */
const MAX_CALLS_PER_TURN = 512
/** Tope del JSON parcial acumulado de una entrada de herramienta. */
const MAX_INPUT_JSON = 1024 * 1024
const MAX_STREAMED_IDS = 64

const PERMISSION_MODES: Readonly<Record<string, PermissionMode>> = {
  default: 'ask',
  acceptEdits: 'accept-edits',
  plan: 'plan',
  bypassPermissions: 'bypass',
}

/** Modo de Claude (`default`...) al normalizado; los que no tienen equivalente (`auto`, `dontAsk`) dan `undefined`. */
export function fromClaudePermissionMode(mode: string): PermissionMode | undefined {
  return Object.hasOwn(PERMISSION_MODES, mode) ? PERMISSION_MODES[mode] : undefined
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nat = (v: number | undefined): number | undefined =>
  v !== undefined && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined

const PLAN_STATUS: Readonly<Record<string, PlanEntryStatus>> = {
  pending: 'pending',
  in_progress: 'in-progress',
  completed: 'completed',
}

/**
 * Traducción pura (sin E/S) de los mensajes del SDK (`SDKMessage`) a `ProviderEvent`. Es una máquina de
 * estados por sesión: recuerda los bloques abiertos, las llamadas a herramienta y el turno en curso.
 *
 * Garantías: todo evento sale válido según `ProviderEvent` (el texto pasa por `sanitizeBodyText` y los deltas
 * se parten sin romper pares sustitutos), cada `ref` es única, y `turn-end` sale exactamente una vez por
 * turno (al llegar el `result`, o por `abandonTurn`). Un mensaje desconocido, roto o de otro turno se ignora.
 */
export class ClaudeTranslator {
  readonly stats: TranslatorStats = { ignored: 0, invalid: 0, orphanResults: 0 }
  readonly #now: () => number
  readonly #scrub: (text: string) => string
  readonly #redact: (text: string) => string
  #counter = 0
  #turnActive = false
  #interrupted = false
  #errorEmitted = false
  /** Resultados que llegarán de turnos que se dieron por terminados sin ellos (`abandonTurn`). */
  #staleResults = 0
  #lastTotalCost = 0
  readonly #slots = new Map<number, Slot>()
  readonly #texts = new Map<string, OpenText>()
  readonly #calls = new Map<string, Call>()
  readonly #streamedIds: string[] = []
  #planRef: string | undefined

  constructor(options: TranslatorOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#scrub = options.scrub ?? ((t) => t)
    this.#redact = options.redact ?? ((t) => t)
  }

  get turnActive(): boolean {
    return this.#turnActive
  }

  beginTurn(): void {
    this.#turnActive = true
    this.#interrupted = false
    this.#errorEmitted = false
  }

  /** El usuario pidió interrumpir: el resultado del turno se traduce como `interrupted`. */
  markInterrupted(): void {
    if (this.#turnActive) this.#interrupted = true
  }

  /**
   * Da el turno por terminado sin que el SDK haya enviado su `result` (interrupción sin respuesta). El
   * `result` tardío, si llega, se descarta.
   */
  abandonTurn(stopReason: StopReason): ProviderEvent[] {
    if (!this.#turnActive) return []
    this.#staleResults++
    return this.#finish(stopReason, undefined, [])
  }

  /** El proceso murió con un turno abierto: cierra lo abierto, sin `turn-end` (llegará `exit`). */
  closeForDeath(): ProviderEvent[] {
    if (!this.#turnActive) return []
    const events = this.#closeOpen()
    this.#turnActive = false
    this.#reset()
    return events
  }

  translate(raw: unknown): ProviderEvent[] {
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.stats.ignored++
      return []
    }
    switch (raw.type) {
      case 'stream_event':
        return this.#streamEvent(raw)
      case 'assistant':
        return this.#assistant(raw)
      case 'user':
        return this.#user(raw)
      case 'result':
        return this.#result(raw)
      case 'system':
        return this.#system(raw)
      case 'auth_status':
        return this.#authStatus(raw)
      default:
        this.stats.ignored++
        return []
    }
  }

  // ---- mensajes ----

  #system(raw: Record<string, unknown>): ProviderEvent[] {
    const parsed = SystemMessage.safeParse(raw)
    if (!parsed.success) return this.#invalid()
    const m = parsed.data
    if (m.subtype !== 'init') {
      this.stats.ignored++
      return []
    }
    const session = ProviderSessionToken.safeParse(m.session_id)
    const model = Token.safeParse(m.model)
    const mode =
      m.permissionMode === undefined ? undefined : fromClaudePermissionMode(m.permissionMode)
    if (!session.success && !model.success && mode === undefined) return []
    return [
      {
        type: 'session-info',
        ...(session.success ? { providerSessionId: session.data } : {}),
        ...(model.success ? { model: model.data } : {}),
        ...(mode === undefined ? {} : { permissionMode: mode }),
      },
    ]
  }

  #authStatus(raw: Record<string, unknown>): ProviderEvent[] {
    const parsed = AuthStatusMessage.safeParse(raw)
    if (!parsed.success) return this.#invalid()
    if (parsed.data.error === undefined || !this.#turnActive) {
      this.stats.ignored++
      return []
    }
    return this.#errorOnce(authError())
  }

  #streamEvent(raw: Record<string, unknown>): ProviderEvent[] {
    const env = StreamEnvelope.safeParse(raw)
    if (!env.success) return this.#invalid()
    // Los eventos parciales de subagentes comparten índices con los del agente principal.
    if (!this.#turnActive || (env.data.parent_tool_use_id ?? null) !== null) {
      this.stats.ignored++
      return []
    }
    const event = env.data.event
    switch (event.type) {
      case 'message_start': {
        const m = MessageStart.safeParse(event)
        if (!m.success) return this.#invalid()
        const closed = this.#closeStream()
        const id = m.data.message?.id
        if (id !== undefined) {
          this.#streamedIds.push(id)
          if (this.#streamedIds.length > MAX_STREAMED_IDS) this.#streamedIds.shift()
        }
        return closed
      }
      case 'content_block_start': {
        const m = BlockStart.safeParse(event)
        return m.success ? this.#blockStart(m.data) : this.#invalid()
      }
      case 'content_block_delta': {
        const m = BlockDelta.safeParse(event)
        return m.success ? this.#blockDelta(m.data) : this.#invalid()
      }
      case 'content_block_stop': {
        const m = BlockStop.safeParse(event)
        return m.success ? this.#blockStop(m.data.index) : this.#invalid()
      }
      default:
        // message_delta, message_stop, ping...
        this.stats.ignored++
        return []
    }
  }

  #blockStart(m: ReturnType<typeof BlockStart.parse>): ProviderEvent[] {
    if (this.#slots.has(m.index)) return this.#invalid()
    const cb = m.content_block
    if (cb.type === 'text' || cb.type === 'thinking') {
      const open = this.#openText(cb.type === 'text' ? 'text' : 'reasoning')
      this.#slots.set(m.index, { kind: 'text', open })
      const initial = cb.type === 'text' ? cb.text : cb.thinking
      return [
        this.#textStart(open),
        ...(initial === undefined || initial === '' ? [] : this.#feed(open, initial)),
      ]
    }
    if (cb.type === 'tool_use' && cb.id !== undefined && cb.name !== undefined) {
      this.#slots.set(m.index, { kind: 'tool', callId: cb.id })
      return this.#startCall(cb.id, cb.name)
    }
    this.#slots.set(m.index, { kind: 'ignore' })
    this.stats.ignored++
    return []
  }

  #blockDelta(m: ReturnType<typeof BlockDelta.parse>): ProviderEvent[] {
    const slot = this.#slots.get(m.index)
    if (slot === undefined) return this.#invalid()
    const d = m.delta
    if (slot.kind === 'text') {
      const text =
        d.type === 'text_delta' ? d.text : d.type === 'thinking_delta' ? d.thinking : undefined
      return text === undefined ? [] : this.#feed(slot.open, text)
    }
    if (slot.kind === 'tool' && d.type === 'input_json_delta' && d.partial_json !== undefined) {
      const call = this.#calls.get(slot.callId)
      if (call !== undefined && !call.inputDone && call.inputJson.length < MAX_INPUT_JSON) {
        call.inputJson += d.partial_json
      }
    }
    return []
  }

  #blockStop(index: number): ProviderEvent[] {
    const slot = this.#slots.get(index)
    if (slot === undefined) return this.#invalid()
    this.#slots.delete(index)
    if (slot.kind === 'text') return this.#textEnd(slot.open)
    if (slot.kind === 'tool') {
      const call = this.#calls.get(slot.callId)
      if (call === undefined || call.inputDone) return []
      let input: unknown = {}
      if (call.inputJson.trim() !== '') {
        try {
          input = JSON.parse(call.inputJson)
        } catch {
          this.stats.invalid++
          input = {}
        }
      }
      return this.#completeCall(call, input)
    }
    return []
  }

  #assistant(raw: Record<string, unknown>): ProviderEvent[] {
    const parsed = AssistantMessage.safeParse(raw)
    if (!parsed.success) return this.#invalid()
    if (!this.#turnActive) {
      this.stats.ignored++
      return []
    }
    const m = parsed.data
    const sub = (m.parent_tool_use_id ?? null) !== null
    const events: ProviderEvent[] = []
    if (m.error !== undefined) events.push(...this.#errorOnce(describeApiError(m.error)))
    const streamed = m.message.id !== undefined && this.#streamedIds.includes(m.message.id)
    for (const rawBlock of m.message.content) {
      const b = ContentBlock.safeParse(rawBlock)
      if (!b.success) {
        this.stats.ignored++
        continue
      }
      const block = b.data
      if (block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
        const call = this.#calls.get(block.id)
        if (call === undefined) {
          events.push(...this.#startCall(block.id, block.name))
          const created = this.#calls.get(block.id)
          if (created !== undefined) events.push(...this.#completeCall(created, block.input ?? {}))
        } else if (!call.inputDone) {
          events.push(...this.#completeCall(call, block.input ?? {}))
        }
        continue
      }
      // Texto y razonamiento: con parciales ya salieron por deltas; los de subagentes y los sintéticos
      // de error (que repiten el error) no se muestran.
      if (sub || streamed || m.error !== undefined) continue
      const text =
        block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : undefined
      if (text === undefined || text === '') continue
      const open = this.#openText(block.type === 'text' ? 'text' : 'reasoning')
      events.push(this.#textStart(open), ...this.#feed(open, text), ...this.#textEnd(open))
    }
    return events
  }

  #user(raw: Record<string, unknown>): ProviderEvent[] {
    const parsed = UserMessage.safeParse(raw)
    if (!parsed.success) return this.#invalid()
    const content = parsed.data.message.content
    if (!this.#turnActive || !Array.isArray(content)) {
      this.stats.ignored++
      return []
    }
    const events: ProviderEvent[] = []
    for (const rawBlock of content) {
      if (!isRecord(rawBlock) || rawBlock.type !== 'tool_result') continue
      const r = ToolResultBlock.safeParse(rawBlock)
      if (!r.success) {
        this.stats.invalid++
        continue
      }
      events.push(...this.#toolResult(r.data))
    }
    return events
  }

  #toolResult(r: ReturnType<typeof ToolResultBlock.parse>): ProviderEvent[] {
    const call = this.#calls.get(r.tool_use_id)
    if (call === undefined || !call.open) {
      this.stats.orphanResults++
      return []
    }
    call.open = false
    if (call.mode !== 'action' || call.ref === undefined || call.draft === undefined) return []
    const text = this.#scrub(resultText(r.content))
    const out = body(text, LIMITS.maxBlockTextBytes)
    const isError = r.is_error === true
    const exit = call.draft.kind === 'exec' ? exitCodeOf(out.text, isError) : undefined
    const draft: ActionDraft = {
      ...call.draft,
      status: isError ? 'error' : 'ok',
      ...(out.text === '' ? {} : { output: out.text }),
      ...(exit === undefined ? {} : { exitCode: exit }),
      durationMs: Math.max(0, Math.trunc(this.#now() - call.startedAt)),
      ...(out.truncated ? { truncated: true } : {}),
    }
    call.draft = draft
    return [{ type: 'block-end', ref: call.ref, block: draft }]
  }

  #result(raw: Record<string, unknown>): ProviderEvent[] {
    const parsed = ResultMessage.safeParse(raw)
    if (!parsed.success) return this.#invalid()
    if (this.#staleResults > 0) {
      this.#staleResults--
      this.stats.ignored++
      return []
    }
    if (!this.#turnActive) {
      this.stats.invalid++
      return []
    }
    const r = parsed.data
    const errors: ProviderEvent[] = []
    let stop: StopReason
    if (this.#interrupted) stop = 'interrupted'
    else if (r.subtype === 'success')
      stop = r.is_error === true ? 'error' : mapStopReason(r.stop_reason)
    else if (r.subtype === 'error_max_turns') stop = 'max-turns'
    else if (r.subtype === 'error_during_execution') stop = 'error'
    else stop = 'other'

    if (!this.#interrupted && (r.is_error === true || r.subtype === 'error_during_execution')) {
      const detail = [r.result, ...(r.errors ?? [])]
        .filter((t) => t !== undefined && t !== '')
        .join('\n')
      if (looksLikeAuthFailure(detail)) errors.push(...this.#errorOnce(authError()))
      else if (!this.#errorEmitted) {
        errors.push(
          ...this.#errorOnce({
            code: 'TURN_ERROR',
            message:
              detail === '' ? 'Claude terminó el turno con un error.' : this.#errorText(detail),
            fatal: false,
            retryable: false,
          }),
        )
      }
    }
    return this.#finish(stop, this.#usage(r), errors)
  }

  // ---- llamadas a herramienta ----

  #startCall(id: string, name: string): ProviderEvent[] {
    if (this.#calls.has(id)) return []
    const mode: Call['mode'] =
      this.#calls.size >= MAX_CALLS_PER_TURN
        ? 'silent'
        : name === 'TodoWrite'
          ? 'plan'
          : name === 'AskUserQuestion'
            ? 'silent'
            : 'action'
    const call: Call = {
      id,
      name,
      mode,
      inputJson: '',
      inputDone: false,
      open: true,
      startedAt: this.#now(),
    }
    this.#calls.set(id, call)
    if (mode !== 'action') return []
    call.ref = this.#ref('a')
    call.draft = {
      type: 'action',
      kind: inferKind(name),
      status: 'pending',
      tool: line(name, 128, 'tool'),
      title: line(name, LIMITS.maxTitleLength, 'herramienta'),
      callId: line(id, 128, 'call'),
    }
    return [{ type: 'block-start', ref: call.ref, block: call.draft }]
  }

  #completeCall(call: Call, input: unknown): ProviderEvent[] {
    call.inputDone = true
    if (call.mode === 'plan') return this.#plan(input)
    if (call.mode !== 'action' || call.ref === undefined || call.draft === undefined) return []
    const d = describeTool(call.name, input)
    const diff =
      d.diff === undefined
        ? undefined
        : {
            path: d.diff.path,
            patch: body(this.#scrub(d.diff.patch), LIMITS.maxBlockTextBytes).text,
          }
    const draft: ActionDraft = {
      ...call.draft,
      status: 'running',
      title: d.title,
      ...(d.path === undefined ? {} : { path: d.path }),
      ...(d.input === undefined
        ? {}
        : { input: body(this.#scrub(d.input), LIMITS.maxBlockInputBytes).text }),
      ...(diff === undefined || call.draft.kind !== 'edit' ? {} : { diff }),
    }
    call.draft = draft
    return [{ type: 'block-update', ref: call.ref, block: draft }]
  }

  #plan(input: unknown): ProviderEvent[] {
    const parsed = TodoWriteInput.safeParse(input)
    if (!parsed.success) return this.#invalid()
    const entries = parsed.data.todos.slice(0, LIMITS.maxPlanEntries).flatMap((t) => {
      const text = line(this.#scrub(t.content), 512)
      const status = Object.hasOwn(PLAN_STATUS, t.status) ? PLAN_STATUS[t.status] : undefined
      return text === '' || status === undefined ? [] : [{ text, status }]
    })
    const draft: BlockDraft = { type: 'plan', entries }
    if (this.#planRef === undefined) {
      this.#planRef = this.#ref('p')
      return [{ type: 'block-start', ref: this.#planRef, block: draft }]
    }
    return [{ type: 'block-update', ref: this.#planRef, block: draft }]
  }

  // ---- texto ----

  #openText(type: 'text' | 'reasoning'): OpenText {
    const open: OpenText = {
      ref: this.#ref(type === 'text' ? 't' : 'r'),
      type,
      carry: new TextCarry(),
    }
    this.#texts.set(open.ref, open)
    return open
  }

  #textStart(open: OpenText): ProviderEvent {
    return {
      type: 'block-start',
      ref: open.ref,
      block: { type: open.type, text: '', complete: false },
    }
  }

  #feed(open: OpenText, raw: string): ProviderEvent[] {
    const clean = sanitizeBodyText(this.#scrub(open.carry.push(raw)))
    return splitDelta(clean).map((text) => ({
      type: 'block-delta' as const,
      ref: open.ref,
      field: 'text' as const,
      text,
    }))
  }

  #textEnd(open: OpenText): ProviderEvent[] {
    if (!this.#texts.delete(open.ref)) return []
    const rest = open.carry.flush()
    return [
      ...(rest === ''
        ? []
        : [{ type: 'block-delta' as const, ref: open.ref, field: 'text' as const, text: '�' }]),
      { type: 'block-end', ref: open.ref },
    ]
  }

  // ---- cierre ----

  #finish(
    stop: StopReason,
    usage: TurnUsage | undefined,
    errors: ProviderEvent[],
  ): ProviderEvent[] {
    const events = [...this.#closeOpen(), ...errors]
    events.push({ type: 'turn-end', stopReason: stop, ...(usage === undefined ? {} : { usage }) })
    this.#turnActive = false
    this.#interrupted = false
    this.#reset()
    return events
  }

  #closeStream(): ProviderEvent[] {
    const events: ProviderEvent[] = []
    for (const slot of this.#slots.values()) {
      if (slot.kind === 'text') events.push(...this.#textEnd(slot.open))
    }
    this.#slots.clear()
    return events
  }

  #closeOpen(): ProviderEvent[] {
    const events = this.#closeStream()
    for (const open of [...this.#texts.values()]) events.push(...this.#textEnd(open))
    for (const call of this.#calls.values()) {
      if (
        call.open &&
        call.mode === 'action' &&
        call.ref !== undefined &&
        call.draft !== undefined
      ) {
        events.push({ type: 'block-end', ref: call.ref, block: { ...call.draft, status: 'error' } })
      }
      call.open = false
    }
    if (this.#planRef !== undefined) events.push({ type: 'block-end', ref: this.#planRef })
    return events
  }

  #reset(): void {
    this.#slots.clear()
    this.#texts.clear()
    this.#calls.clear()
    this.#planRef = undefined
  }

  // ---- utilidades ----

  #usage(r: ReturnType<typeof ResultMessage.parse>): TurnUsage | undefined {
    const u = r.usage
    const total = r.total_cost_usd
    let cost: number | undefined
    if (total !== undefined && Number.isFinite(total) && total >= 0) {
      cost = total >= this.#lastTotalCost ? total - this.#lastTotalCost : total
      this.#lastTotalCost = total
      cost = Math.min(Math.round(cost * 1e8) / 1e8, 1e9)
    }
    const fields = {
      inputTokens: nat(u?.input_tokens),
      outputTokens: nat(u?.output_tokens),
      cacheReadTokens: nat(u?.cache_read_input_tokens),
      cacheWriteTokens: nat(u?.cache_creation_input_tokens),
      costUsd: cost,
      durationMs: nat(r.duration_ms),
      numTurns: nat(r.num_turns),
    }
    const usage: TurnUsage = {}
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (usage as Record<string, number>)[key] = value
    }
    return Object.keys(usage).length === 0 ? undefined : usage
  }

  #errorText(text: string): string {
    return body(this.#redact(text), 8 * 1024 - 8).text || 'Claude terminó el turno con un error.'
  }

  #errorOnce(error: {
    code: string
    message: string
    fatal: boolean
    retryable?: boolean | undefined
  }): ProviderEvent[] {
    if (this.#errorEmitted) return []
    this.#errorEmitted = true
    return [
      {
        type: 'error',
        error: {
          code: line(error.code, 64, 'ERROR'),
          message: error.message,
          fatal: error.fatal,
          ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
        },
      },
    ]
  }

  #invalid(): ProviderEvent[] {
    this.stats.invalid++
    return []
  }

  #ref(prefix: string): string {
    return `${prefix}${++this.#counter}`
  }
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case undefined:
    case null:
    case 'end_turn':
    case 'stop_sequence':
      return 'end-turn'
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

function exitCodeOf(output: string, isError: boolean): number | null | undefined {
  const parsed = parseExitCode(output)
  if (parsed !== undefined) return parsed
  return isError ? null : 0
}

/** Texto de un `tool_result.content`: cadena, o lista de bloques (`text`; las imágenes se anotan). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'image') parts.push('[imagen]')
  }
  return parts.join('\n')
}
