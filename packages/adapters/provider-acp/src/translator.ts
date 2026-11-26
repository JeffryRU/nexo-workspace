import {
  type BlockDraft,
  LIMITS,
  type PermissionMode,
  type ProviderEvent,
  type StopReason,
  sanitizeBodyText,
  type TurnUsage,
} from '@nexo/contracts'
import type { z } from 'zod'
import { unifiedDiff } from './diff.ts'
import { relativeTo } from './paths.ts'
import {
  ContentChunk,
  InfoUpdate,
  ModeUpdate,
  Plan,
  PlanUpdate,
  planEntries,
  readToolContent,
  SessionNotification,
  ToolCallFields,
} from './protocol.ts'
import { line, splitDelta, TextCarry, truncateUtf8 } from './text.ts'

/**
 * Traducción pura de las notificaciones `session/update` de ACP a `ProviderEvent`. Sin E/S: una máquina de
 * estados por sesión; el turno se abre con `beginTurn()` y acaba con exactamente un `turn-end` (por la
 * respuesta de `session/prompt` o por `end()` si la sesión lo corta). Lo que no se reconoce o no cumple el
 * esquema se ignora y se cuenta (`ignored`). Esquema: `protocol.ts`.
 */

export type TurnProblem = { code: string; message: string; fatal?: boolean; retryable?: boolean }

type ActionDraft = Extract<BlockDraft, { type: 'action' }>
type ActionStatus = ActionDraft['status']

type TextState = {
  type: 'text' | 'reasoning'
  ref: string
  started: boolean
  carry: TextCarry
  messageId: string | undefined
}
type CallState = {
  ref: string
  fields: ToolCallFields
  draft: ActionDraft
  serialized: string
  closed: boolean
}

/** Llamadas a herramienta distintas que se siguen por turno (el resto se ignora). */
export const MAX_CALLS_PER_TURN = 1024
const MAX_PLANS = 8

const MAX_BODY = LIMITS.maxBlockTextBytes

export function stopReasonOf(reason: string | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end-turn'
    case 'max_tokens':
      return 'max-tokens'
    case 'max_turn_requests':
      return 'max-turns'
    case 'refusal':
      return 'refusal'
    case 'cancelled':
      return 'interrupted'
    default:
      return 'other'
  }
}

const KIND: Record<string, ActionDraft['kind']> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  fetch: 'search',
  execute: 'exec',
}

function statusOf(status: string | null | undefined): ActionStatus {
  switch (status) {
    case 'in_progress':
      return 'running'
    case 'completed':
      return 'ok'
    case 'failed':
      return 'error'
    default:
      return 'pending'
  }
}

const isTerminal = (status: string | null | undefined) =>
  status === 'completed' || status === 'failed'

function body(text: string, max: number): { text: string; truncated: boolean } {
  return truncateUtf8(sanitizeBodyText(text), max)
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return undefined
  }
}

function exitCodeOf(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const v = o.exitCode ?? o.exit_code
  return typeof v === 'number' && Number.isSafeInteger(Math.trunc(v)) ? Math.trunc(v) : undefined
}

/** Texto que se muestra de un fragmento de contenido ACP (imágenes y audio no se muestran). */
function chunkText(content: ContentChunk['content']): string {
  switch (content.type) {
    case 'text':
      return content.text ?? ''
    case 'resource_link':
      return content.uri === undefined ? '' : `[${content.name ?? content.uri}](${content.uri})`
    case 'image':
      return '*[imagen]*'
    case 'audio':
      return '*[audio]*'
    default:
      return ''
  }
}

/** Bloque `action` de una llamada a herramienta ACP con los campos acumulados hasta ahora. */
export function actionDraft(fields: ToolCallFields, cwd?: string): ActionDraft {
  const read = readToolContent(fields)
  const { texts } = read
  // Rutas relativas a la carpeta de la sesión cuando están dentro de ella (ver paths.ts).
  const diffs = read.diffs.map((d) => ({ ...d, path: relativeTo(cwd, d.path) }))
  const paths = read.paths.map((p) => relativeTo(cwd, p))
  const kind: ActionDraft['kind'] = diffs.length > 0 ? 'edit' : (KIND[fields.kind ?? ''] ?? 'other')
  let status = statusOf(fields.status)
  const tool = line(fields.name ?? fields.kind ?? 'tool', 128, 'tool')
  const title = line(fields.title ?? '', LIMITS.maxTitleLength, line(tool, LIMITS.maxTitleLength))
  const path = line(diffs[0]?.path ?? paths[0] ?? '', LIMITS.maxPathLength)
  const input = stringify(fields.rawInput)
  const inputBody = input === undefined ? undefined : body(input, LIMITS.maxBlockInputBytes)
  const outText = texts.join('\n') || stringify(fields.rawOutput) || ''
  const out = body(outText, MAX_BODY)
  let truncated = out.truncated

  let diff: ActionDraft['diff']
  if (diffs.length > 0) {
    const patch = body(
      diffs
        .map((d) => unifiedDiff(d.path, d.oldText, d.newText))
        .filter((p) => p !== '')
        .join('\n'),
      MAX_BODY,
    )
    truncated ||= patch.truncated
    const diffPath = line(diffs[0]?.path ?? '', LIMITS.maxPathLength)
    if (patch.text !== '' && diffPath !== '') diff = { path: diffPath, patch: patch.text }
  }
  const exitCode =
    kind === 'exec' && status !== 'pending' ? exitCodeOf(fields.rawOutput) : undefined
  if (status === 'ok' && exitCode !== undefined && exitCode !== 0) status = 'error'
  return {
    type: 'action',
    kind,
    status,
    tool,
    title,
    callId: line(fields.toolCallId, 128, 'call'),
    ...(path === '' ? {} : { path }),
    ...(inputBody === undefined || inputBody.text === '' ? {} : { input: inputBody.text }),
    ...(out.text === '' ? {} : { output: out.text }),
    ...(diff === undefined ? {} : { diff }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(truncated || inputBody?.truncated === true ? { truncated: true } : {}),
  }
}

export class AcpTranslator {
  readonly #nextRef: () => string
  readonly #mapMode: (id: string) => PermissionMode | undefined
  readonly #cwd: string | undefined
  #text: TextState | undefined
  #calls = new Map<string, CallState>()
  #plans = new Map<string, { ref: string; serialized: string }>()
  #finished = true
  #interrupted = false
  #ignored = 0

  constructor(options: {
    nextRef: () => string
    /** Modo de sesión del agente → modo normalizado (para `current_mode_update`). */
    mapMode?: (id: string) => PermissionMode | undefined
    /** Carpeta de la sesión: las rutas de las acciones dentro de ella se muestran relativas. */
    cwd?: string | undefined
  }) {
    this.#cwd = options.cwd
    this.#nextRef = options.nextRef
    this.#mapMode = options.mapMode ?? (() => undefined)
  }

  /** `true` si no hay turno en curso (o ya emitió su `turn-end`). */
  get finished(): boolean {
    return this.#finished
  }
  /** Actualizaciones descartadas por no cumplir el esquema o no ser útiles (diagnóstico). */
  get ignored(): number {
    return this.#ignored
  }

  beginTurn(): void {
    this.#text = undefined
    this.#calls = new Map()
    this.#plans = new Map()
    this.#finished = false
    this.#interrupted = false
  }

  /** El usuario pidió interrumpir: el turno acaba como `interrupted` aunque el agente diga otra cosa. */
  markInterrupted(): void {
    this.#interrupted = true
  }

  /** Procesa `params` de una notificación `session/update` (ya filtrada por sesión). */
  notification(params: unknown): ProviderEvent[] {
    const n = SessionNotification.safeParse(params)
    if (!n.success) {
      this.#ignored++
      return []
    }
    const update = n.data.update
    // Cambios de modo y de título pueden llegar fuera de un turno.
    switch (update.sessionUpdate) {
      case 'current_mode_update':
        return this.#modeUpdate(update)
      case 'session_info_update':
        return this.#infoUpdate(update)
    }
    if (this.#finished) {
      this.#ignored++
      return []
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.#chunk('text', update)
      case 'agent_thought_chunk':
        return this.#chunk('reasoning', update)
      case 'tool_call':
      case 'tool_call_update':
        return this.#toolCall(update)
      case 'plan':
        return this.#plan(update)
      case 'plan_update':
        return this.#planUpdate(update)
      default:
        // user_message_chunk, available_commands_update, usage_update, config_option_update, notice,
        // compaction_*, subagent_*, session_message*, plan_removed... no tienen bloque propio.
        this.#ignored++
        return []
    }
  }

  /** Cierra el turno (respuesta de `session/prompt` o corte externo). Idempotente. */
  end(
    stopReason: StopReason,
    options: { usage?: TurnUsage; problem?: TurnProblem } = {},
  ): ProviderEvent[] {
    if (this.#finished) return []
    const events = this.#closeAll()
    this.#finished = true
    if (options.problem !== undefined) events.push(this.#errorEvent(options.problem))
    const usage = options.usage
    events.push({
      type: 'turn-end',
      stopReason: this.#interrupted && stopReason !== 'error' ? 'interrupted' : stopReason,
      ...(usage === undefined || Object.keys(usage).length === 0 ? {} : { usage }),
    })
    return events
  }

  #parse<S extends z.ZodType>(schema: S, v: unknown): z.infer<S> | undefined {
    const r = schema.safeParse(v)
    if (r.success) return r.data
    this.#ignored++
    return undefined
  }

  // ---- sesión ----

  #modeUpdate(update: unknown): ProviderEvent[] {
    const m = this.#parse(ModeUpdate, update)
    const mode = m === undefined ? undefined : this.#mapMode(m.currentModeId)
    return mode === undefined ? [] : [{ type: 'session-info', permissionMode: mode }]
  }

  #infoUpdate(update: unknown): ProviderEvent[] {
    const i = this.#parse(InfoUpdate, update)
    const title = line(i?.title ?? '', LIMITS.maxTitleLength)
    return title === '' ? [] : [{ type: 'session-info', title }]
  }

  // ---- texto ----

  #chunk(type: 'text' | 'reasoning', update: unknown): ProviderEvent[] {
    const c = this.#parse(ContentChunk, update)
    if (c === undefined) return []
    const events: ProviderEvent[] = []
    const messageId = c.messageId ?? undefined
    let state = this.#text
    if (
      state !== undefined &&
      (state.type !== type ||
        (messageId !== undefined && state.messageId !== undefined && messageId !== state.messageId))
    ) {
      events.push(...this.#closeText())
      state = undefined
    }
    if (state === undefined) {
      state = {
        type,
        ref: this.#nextRef(),
        started: false,
        carry: new TextCarry(),
        messageId,
      }
      this.#text = state
    }
    const clean = sanitizeBodyText(state.carry.push(chunkText(c.content)))
    if (clean === '') return events
    if (!state.started) {
      state.started = true
      events.push({
        type: 'block-start',
        ref: state.ref,
        block: { type: state.type, text: '', complete: false },
      })
    }
    for (const part of splitDelta(clean)) {
      events.push({ type: 'block-delta', ref: state.ref, field: 'text', text: part })
    }
    return events
  }

  #closeText(): ProviderEvent[] {
    const state = this.#text
    this.#text = undefined
    if (state === undefined) return []
    const events: ProviderEvent[] = []
    const rest = sanitizeBodyText(state.carry.flush())
    if (rest !== '') {
      if (!state.started) {
        state.started = true
        events.push({
          type: 'block-start',
          ref: state.ref,
          block: { type: state.type, text: '', complete: false },
        })
      }
      events.push({ type: 'block-delta', ref: state.ref, field: 'text', text: rest })
    }
    if (state.started) events.push({ type: 'block-end', ref: state.ref })
    return events
  }

  // ---- llamadas a herramienta ----

  #toolCall(update: unknown): ProviderEvent[] {
    const fields = this.#parse(ToolCallFields, update)
    if (fields === undefined) return []
    const events: ProviderEvent[] = []
    const known = this.#calls.get(fields.toolCallId)
    if (known === undefined) {
      if (this.#calls.size >= MAX_CALLS_PER_TURN) {
        this.#ignored++
        return []
      }
      // Un `tool_call_update` sin su `tool_call` se trata como el alta de la llamada.
      events.push(...this.#closeText())
      const draft = actionDraft(fields, this.#cwd)
      const call: CallState = {
        ref: this.#nextRef(),
        fields,
        draft,
        serialized: JSON.stringify(draft),
        closed: false,
      }
      this.#calls.set(fields.toolCallId, call)
      events.push({ type: 'block-start', ref: call.ref, block: draft })
      if (isTerminal(fields.status)) this.#finishCall(call, events)
      return events
    }
    if (known.closed) {
      // Una actualización tardía de una llamada ya cerrada no puede reabrir su bloque.
      this.#ignored++
      return []
    }
    const merged: ToolCallFields = {
      ...known.fields,
      ...(fields.title == null ? {} : { title: fields.title }),
      ...(fields.name == null ? {} : { name: fields.name }),
      ...(fields.kind == null ? {} : { kind: fields.kind }),
      ...(fields.status == null ? {} : { status: fields.status }),
      ...(fields.content == null ? {} : { content: fields.content }),
      ...(fields.locations == null ? {} : { locations: fields.locations }),
      ...(fields.rawInput === undefined ? {} : { rawInput: fields.rawInput }),
      ...(fields.rawOutput === undefined ? {} : { rawOutput: fields.rawOutput }),
    }
    known.fields = merged
    const draft = actionDraft(merged, this.#cwd)
    const serialized = JSON.stringify(draft)
    if (serialized !== known.serialized) {
      known.draft = draft
      known.serialized = serialized
      if (!isTerminal(merged.status))
        events.push({ type: 'block-update', ref: known.ref, block: draft })
    }
    if (isTerminal(merged.status)) this.#finishCall(known, events)
    return events
  }

  #finishCall(call: CallState, events: ProviderEvent[]): void {
    call.closed = true
    events.push({ type: 'block-end', ref: call.ref, block: call.draft })
  }

  // ---- plan ----

  #plan(update: unknown): ProviderEvent[] {
    const p = this.#parse(Plan, update)
    if (p === undefined) return []
    return this.#emitPlan('plan', {
      type: 'plan',
      entries: this.#entries(p.entries),
    })
  }

  #planUpdate(update: unknown): ProviderEvent[] {
    const p = this.#parse(PlanUpdate, update)
    if (p === undefined) return []
    const key = p.plan.planId ?? 'plan'
    if (p.plan.type === 'markdown') {
      const md = body(p.plan.content ?? '', MAX_BODY)
      return this.#emitPlan(key, {
        type: 'plan',
        entries: [],
        ...(md.text === '' ? {} : { markdown: md.text }),
      })
    }
    return this.#emitPlan(key, { type: 'plan', entries: this.#entries(p.plan.entries ?? []) })
  }

  #entries(raw: unknown[]): { text: string; status: 'pending' | 'in-progress' | 'completed' }[] {
    const out: { text: string; status: 'pending' | 'in-progress' | 'completed' }[] = []
    for (const e of planEntries(raw)) {
      const text = line(e.content, 512)
      if (text === '' || out.length >= LIMITS.maxPlanEntries) continue
      out.push({
        text,
        status:
          e.status === 'completed'
            ? 'completed'
            : e.status === 'in_progress'
              ? 'in-progress'
              : 'pending',
      })
    }
    return out
  }

  #emitPlan(key: string, draft: BlockDraft): ProviderEvent[] {
    const serialized = JSON.stringify(draft)
    const known = this.#plans.get(key)
    if (known === undefined) {
      if (this.#plans.size >= MAX_PLANS) {
        this.#ignored++
        return []
      }
      const events = this.#closeText()
      const ref = this.#nextRef()
      this.#plans.set(key, { ref, serialized })
      events.push({ type: 'block-start', ref, block: draft })
      return events
    }
    if (known.serialized === serialized) return []
    known.serialized = serialized
    return [{ type: 'block-update', ref: known.ref, block: draft }]
  }

  // ---- cierre ----

  #closeAll(): ProviderEvent[] {
    const events = this.#closeText()
    for (const call of this.#calls.values()) {
      if (call.closed) continue
      // El turno acabó sin que el agente cerrara la acción (interrupción, fallo): queda como error.
      call.closed = true
      events.push({
        type: 'block-end',
        ref: call.ref,
        block: { ...call.draft, status: 'error' },
      })
    }
    for (const plan of this.#plans.values()) events.push({ type: 'block-end', ref: plan.ref })
    this.#plans = new Map()
    return events
  }

  #errorEvent(problem: TurnProblem): ProviderEvent {
    return {
      type: 'error',
      error: {
        code: problem.code,
        message: line(problem.message, 2000, 'Error del agente'),
        fatal: problem.fatal ?? false,
        ...(problem.retryable === undefined ? {} : { retryable: problem.retryable }),
      },
    }
  }
}
