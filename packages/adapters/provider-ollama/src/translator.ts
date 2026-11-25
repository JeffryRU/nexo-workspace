import {
  type ProviderEvent,
  type StopReason,
  sanitizeBodyText,
  type TurnUsage,
} from '@nexo/contracts'
import { z } from 'zod'
import { line, splitDelta, TextCarry } from './text.ts'

/**
 * Traducción pura de las líneas NDJSON de `/api/chat` (con `stream: true`) a `ProviderEvent`. Sin E/S: una
 * máquina de estados que recibe una línea ya separada y devuelve eventos. Lo que no es JSON, no es un objeto o
 * no trae lo esperado se ignora y se cuenta (`invalid`); con demasiadas líneas rotas la respuesta se da por mala.
 *
 * Cada turno acaba con exactamente un `turn-end` (`done`, un `error` de Ollama, o `end()` si el transporte
 * falló, se interrumpió o el flujo se cortó sin `done`).
 */

const Message = z.looseObject({
  content: z.unknown().optional(),
  thinking: z.unknown().optional(),
})
const Chunk = z.looseObject({
  message: Message.optional(),
  done: z.unknown().optional(),
  done_reason: z.unknown().optional(),
  error: z.unknown().optional(),
  prompt_eval_count: z.unknown().optional(),
  eval_count: z.unknown().optional(),
  total_duration: z.unknown().optional(),
})

export const MAX_INVALID_LINES = 100

export type TurnProblem = { code: string; message: string; retryable?: boolean }

const asCount = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined

function stopReasonOf(doneReason: unknown): StopReason {
  switch (doneReason) {
    case undefined:
    case 'stop':
      return 'end-turn'
    case 'length':
      return 'max-tokens'
    default:
      return 'other'
  }
}

export class OllamaTranslator {
  readonly #nextRef: () => string
  readonly #maxContentBytes: number
  #open: { kind: 'text' | 'reasoning'; ref: string; carry: TextCarry } | undefined
  #finished = false
  #stopReason: StopReason | undefined
  #invalid = 0
  #content: string[] = []
  #contentChars = 0

  constructor(options: { nextRef: () => string; maxContentBytes?: number }) {
    this.#nextRef = options.nextRef
    this.#maxContentBytes = options.maxContentBytes ?? 1024 * 1024
  }

  get finished(): boolean {
    return this.#finished
  }
  get stopReason(): StopReason | undefined {
    return this.#stopReason
  }
  get invalid(): number {
    return this.#invalid
  }
  /** Texto de la respuesta (sin el razonamiento), para el historial; acotado por `maxContentBytes`. */
  get content(): string {
    return this.#content.join('')
  }

  feed(raw: string): ProviderEvent[] {
    if (this.#finished) return []
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return this.#bad()
    }
    const parsed = Chunk.safeParse(json)
    if (!parsed.success) return this.#bad()
    const c = parsed.data
    const events: ProviderEvent[] = []

    if (c.error !== undefined && c.error !== null) {
      const message = typeof c.error === 'string' ? c.error : 'error desconocido de Ollama'
      return this.#finish('error', events, classifyServerError(message))
    }
    const thinking = c.message?.thinking
    if (typeof thinking === 'string' && thinking !== '') this.#text('reasoning', thinking, events)
    const content = c.message?.content
    if (typeof content === 'string' && content !== '') this.#text('text', content, events)

    if (c.done === true) {
      const usage: TurnUsage = {}
      const input = asCount(c.prompt_eval_count)
      const output = asCount(c.eval_count)
      const ns = asCount(c.total_duration)
      if (input !== undefined) usage.inputTokens = input
      if (output !== undefined) usage.outputTokens = output
      if (ns !== undefined) usage.durationMs = Math.round(ns / 1e6)
      usage.numTurns = 1
      return this.#finish(stopReasonOf(c.done_reason), events, undefined, usage)
    }
    return events
  }

  /** Cierra el turno por una causa externa (interrupción, fallo de red, flujo cortado). Idempotente. */
  end(stopReason: StopReason, problem?: TurnProblem): ProviderEvent[] {
    if (this.#finished) return []
    return this.#finish(stopReason, [], problem)
  }

  #bad(): ProviderEvent[] {
    this.#invalid++
    if (this.#invalid <= MAX_INVALID_LINES) return []
    return this.#finish('error', [], {
      code: 'INVALID_RESPONSE',
      message:
        'Ollama envió demasiadas líneas que no son una respuesta válida; se descartó el turno.',
    })
  }

  #text(kind: 'text' | 'reasoning', raw: string, events: ProviderEvent[]): void {
    if (this.#open?.kind !== kind) {
      this.#closeBlock(events)
      const ref = this.#nextRef()
      this.#open = { kind, ref, carry: new TextCarry() }
      events.push({ type: 'block-start', ref, block: { type: kind, text: '', complete: false } })
    }
    const open = this.#open
    this.#delta(open.ref, kind, sanitizeBodyText(open.carry.push(raw)), events)
  }

  #delta(ref: string, kind: 'text' | 'reasoning', clean: string, events: ProviderEvent[]): void {
    for (const part of splitDelta(clean)) {
      events.push({ type: 'block-delta', ref, field: 'text', text: part })
    }
    if (kind === 'text' && clean !== '' && this.#contentChars <= this.#maxContentBytes) {
      this.#content.push(clean)
      this.#contentChars += clean.length
    }
  }

  #closeBlock(events: ProviderEvent[]): void {
    const open = this.#open
    if (open === undefined) return
    this.#open = undefined
    this.#delta(open.ref, open.kind, sanitizeBodyText(open.carry.flush()), events)
    events.push({ type: 'block-end', ref: open.ref })
  }

  #finish(
    stopReason: StopReason,
    events: ProviderEvent[],
    problem?: TurnProblem,
    usage?: TurnUsage,
  ): ProviderEvent[] {
    this.#closeBlock(events)
    this.#finished = true
    this.#stopReason = stopReason
    if (problem !== undefined) {
      events.push({
        type: 'error',
        error: {
          code: problem.code,
          message: line(problem.message, 2000, 'Error de Ollama'),
          fatal: false,
          ...(problem.retryable === undefined ? {} : { retryable: problem.retryable }),
        },
      })
    }
    events.push({ type: 'turn-end', stopReason, ...(usage === undefined ? {} : { usage }) })
    return events
  }
}

/** Errores que Ollama informa en el propio flujo (`{"error": "..."}`). */
export function classifyServerError(message: string): TurnProblem {
  const clean = line(message, 500, 'error desconocido')
  if (/not found/i.test(clean)) {
    return {
      code: 'MODEL_NOT_FOUND',
      message: `Ollama no encontró el modelo: ${clean}. Instálalo con «ollama pull <modelo>».`,
    }
  }
  if (/does not support (thinking|think)/i.test(clean)) {
    return {
      code: 'THINK_UNSUPPORTED',
      message: `El modelo no admite razonamiento: ${clean}. Elige «no-think» o deja el esfuerzo por omisión.`,
    }
  }
  return { code: 'OLLAMA_ERROR', message: `Ollama informó un error: ${clean}`, retryable: true }
}
