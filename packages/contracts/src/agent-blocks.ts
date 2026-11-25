import type { AgentDelta, Block, Question, QuestionAnswer } from './agent.ts'
import { LIMITS } from './limits.ts'
import { truncateUtf8, utf8ByteLength } from './text.ts'

export type DeltaOutcome =
  /** Aplicado; `block` es el bloque nuevo (si el tope recortó el texto lleva `truncated: true`). */
  | { status: 'applied'; block: Block }
  /** Ya estaba aplicado (`seq` menor o igual): se ignora sin error. */
  | { status: 'duplicate' }
  /** Faltan deltas intermedios: el cliente debe pedir `agent.snapshot`. */
  | { status: 'gap' }
  /** No corresponde al bloque (otro id, campo que no tiene o bloque ya cerrado). */
  | { status: 'invalid'; reason: string }

function append(current: string, added: string, maxBytes: number) {
  const room = maxBytes - utf8ByteLength(current)
  if (room <= 0) return { text: current, truncated: true }
  if (utf8ByteLength(added) <= room) return { text: current + added, truncated: false }
  return { text: current + truncateUtf8(added, room), truncated: true }
}

/**
 * Aplica un delta a un bloque. Función pura que comparten el daemon y los clientes, para que ambos
 * lleguen al mismo texto. El texto nunca pasa del tope (se recorta sin partir caracteres y el bloque queda
 * `truncated`); un delta que ya no cabe sigue contando en `seq` para que no se vea como hueco.
 */
export function applyBlockDelta(block: Block, delta: AgentDelta): DeltaOutcome {
  if (block.id !== delta.blockId) return { status: 'invalid', reason: 'bloque distinto' }
  if (delta.seq <= block.seq) return { status: 'duplicate' }
  if (delta.seq !== block.seq + 1) return { status: 'gap' }

  if (delta.field === 'text' && (block.type === 'text' || block.type === 'reasoning')) {
    if (block.complete) return { status: 'invalid', reason: 'bloque cerrado' }
    const r = append(block.text, delta.text, LIMITS.maxBlockTextBytes)
    return {
      status: 'applied',
      block: {
        ...block,
        text: r.text,
        seq: delta.seq,
        ...(r.truncated || block.truncated ? { truncated: true } : {}),
      },
    }
  }
  if (delta.field === 'output' && block.type === 'action') {
    if (block.status === 'ok' || block.status === 'error') {
      return { status: 'invalid', reason: 'acción terminada' }
    }
    const r = append(block.output ?? '', delta.text, LIMITS.maxBlockTextBytes)
    return {
      status: 'applied',
      block: {
        ...block,
        output: r.text,
        seq: delta.seq,
        ...(r.truncated || block.truncated ? { truncated: true } : {}),
      },
    }
  }
  return { status: 'invalid', reason: 'el bloque no tiene ese campo' }
}

/**
 * Comprueba las respuestas a un bloque `question`: cada pregunta se contesta una vez, las etiquetas elegidas
 * existen, una pregunta de selección única admite una sola, y el texto libre solo si se permite.
 * Devuelve el primer problema o `null`.
 */
export function validateAnswers(
  questions: readonly Question[],
  answers: readonly QuestionAnswer[],
): string | null {
  const byId = new Map(questions.map((q) => [q.id, q]))
  const seen = new Set<string>()
  for (const a of answers) {
    const q = byId.get(a.questionId)
    if (q === undefined) return `pregunta desconocida: ${a.questionId}`
    if (seen.has(a.questionId)) return `pregunta respondida dos veces: ${a.questionId}`
    seen.add(a.questionId)
    const labels = new Set(q.options.map((o) => o.label))
    for (const s of a.selected) if (!labels.has(s)) return `opción desconocida en ${q.id}`
    if (new Set(a.selected).size !== a.selected.length) return `opción repetida en ${q.id}`
    if (!q.multiSelect && a.selected.length > 1) return `${q.id} admite una sola opción`
    if (a.text !== undefined && !q.allowText) return `${q.id} no admite texto libre`
    if (a.selected.length === 0 && a.text === undefined) return `${q.id} sin respuesta`
  }
  if (seen.size !== questions.length) return 'faltan preguntas por responder'
  return null
}
