import type { Block, BlockRange } from '@nexo/contracts'
import { escapeMemoryText } from './memory-inject.ts'
import { estimateTokens } from './memory-tokens.ts'

/** Topes de lo que entra al Observador de cada bloque (en caracteres, antes de escapar). */
export type SelectLimits = {
  /** Mensajes del usuario y respuestas del agente. */
  maxTextChars: number
  /** Razonamiento: se resume a su comienzo. */
  maxReasoningChars: number
  /** Salida de una acción: se conservan el principio y el final. */
  maxOutputChars: number
  /** Entrada de una acción (comando, ruta). */
  maxInputChars: number
  /** Tokens de toda la transcripción de un lote. */
  maxBatchTokens: number
}

export const DEFAULT_SELECT_LIMITS: SelectLimits = {
  maxTextChars: 4_000,
  maxReasoningChars: 400,
  maxOutputChars: 600,
  maxInputChars: 300,
  maxBatchTokens: 24_000,
}

export type ObserverLine = { index: number; text: string; tokens: number }

export type ObserverInput = {
  /** Rango de bloques que cubre el lote (todos los vistos, también los que no aportan texto). */
  range: BlockRange
  lines: ObserverLine[]
  /** Transcripción ya escapada, una línea por bloque, lista para ir dentro de un bloque delimitado. */
  transcript: string
  tokens: number
}

/** Un bloque aún en curso no se observa: su texto puede cambiar. */
function isOpen(b: Block): boolean {
  switch (b.type) {
    case 'text':
    case 'reasoning':
      return !b.complete
    case 'action':
      return b.status === 'pending' || b.status === 'running'
    case 'permission':
      return b.state === 'pending'
    case 'question':
      return b.state === 'pending'
    default:
      return false
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const points = Array.from(flat)
  if (points.length <= max) return flat
  return `${points.slice(0, max).join('')}…`
}

function clipMiddle(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const points = Array.from(flat)
  if (points.length <= max) return flat
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  return `${points.slice(0, head).join('')} […] ${points.slice(points.length - tail).join('')}`
}

/** Texto de un bloque para el Observador, o `null` si no aporta (uso, permisos, preguntas, planes). */
export function blockToLine(b: Block, limits: SelectLimits): string | null {
  switch (b.type) {
    case 'user':
      return `usuario: ${clip(b.text, limits.maxTextChars)}`
    case 'text': {
      const t = clip(b.text, limits.maxTextChars)
      return t === '' ? null : `agente: ${t}`
    }
    case 'reasoning': {
      const t = clip(b.text, limits.maxReasoningChars)
      return t === '' ? null : `razonamiento: ${t}`
    }
    case 'action': {
      const parts = [`acción ${b.tool} (${b.kind}, ${b.status}): ${clip(b.title, 200)}`]
      if (b.path !== undefined) parts.push(`ruta ${clip(b.path, 200)}`)
      if (b.input !== undefined) parts.push(`entrada ${clip(b.input, limits.maxInputChars)}`)
      if (b.exitCode !== undefined && b.exitCode !== null) parts.push(`código ${b.exitCode}`)
      if (b.output !== undefined && b.output.trim() !== '') {
        parts.push(`salida ${clipMiddle(b.output, limits.maxOutputChars)}`)
      }
      return parts.join('; ')
    }
    case 'error':
      return `error ${clip(b.code, 64)}: ${clip(b.message, 300)}`
    default:
      return null
  }
}

/**
 * Elige qué bloques nuevos (con `index > observedThrough`) entran al Observador. Recorre por orden de `index`
 * y se detiene en el primer bloque abierto (para que el rango sea contiguo y estable) o al llenarse el lote
 * (`maxBatchTokens`; siempre entra al menos un bloque). Entran usuario, agente, razonamiento resumido, acciones
 * con la salida recortada y errores; nunca `usage`, permisos, preguntas ni planes. Cada línea se escapa con
 * `escapeMemoryText`. Devuelve `null` si no hay ningún bloque cerrado nuevo.
 */
export function selectForObserver(
  blocks: readonly Block[],
  observedThrough: number,
  limits: SelectLimits = DEFAULT_SELECT_LIMITS,
): ObserverInput | null {
  const sorted = blocks.filter((b) => b.index > observedThrough).sort((a, b) => a.index - b.index)
  const lines: ObserverLine[] = []
  let tokens = 0
  let from = -1
  let to = -1
  let previous = observedThrough
  for (const b of sorted) {
    if (b.index === previous) continue // duplicado
    if (isOpen(b)) break
    const raw = blockToLine(b, limits)
    const text = raw === null ? null : escapeMemoryText(raw)
    const cost = text === null ? 0 : estimateTokens(text) + 4
    if (tokens + cost > limits.maxBatchTokens && to !== -1) break
    if (from === -1) from = b.index
    to = b.index
    previous = b.index
    if (text !== null) {
      lines.push({ index: b.index, text, tokens: cost })
      tokens += cost
    }
  }
  if (lines.length === 0 || from === -1) return null
  return {
    range: { from, to },
    lines,
    transcript: lines.map((l) => `[#${l.index}] ${l.text}`).join('\n'),
    tokens,
  }
}

/** Tokens nuevos de una sesión que aún no se observaron (mismo criterio que `selectForObserver`, sin tope). */
export function pendingObserverTokens(blocks: readonly Block[], observedThrough: number): number {
  const all = selectForObserver(blocks, observedThrough, {
    ...DEFAULT_SELECT_LIMITS,
    maxBatchTokens: Number.MAX_SAFE_INTEGER,
  })
  return all?.tokens ?? 0
}

/** Tokens estimados del texto que un agente tendría que releer de los bloques con `index > after` (sin recortar). */
export function blocksContextTokens(blocks: readonly Block[], after: number): number {
  let total = 0
  for (const b of blocks) {
    if (b.index <= after) continue
    switch (b.type) {
      case 'user':
      case 'text':
      case 'reasoning':
        total += estimateTokens(b.text) + 4
        break
      case 'action':
        total +=
          estimateTokens(b.title) +
          estimateTokens(b.input ?? '') +
          estimateTokens(b.output ?? '') +
          8
        break
      case 'error':
        total += estimateTokens(b.message) + 4
        break
      default:
        break
    }
  }
  return total
}

/**
 * Últimos turnos tal cual: mensajes del usuario y respuestas completas del agente (de más antiguo a más
 * reciente) que caben en `maxTokens`. El texto va sin escapar: `buildMemoryBlock` lo escapa al armar el bloque.
 */
export function recentTurnsFromBlocks(
  blocks: readonly Block[],
  maxTokens: number,
): { role: 'usuario' | 'agente'; text: string }[] {
  const sorted = [...blocks].sort((a, b) => a.index - b.index)
  const out: { role: 'usuario' | 'agente'; text: string }[] = []
  let used = 0
  for (let i = sorted.length - 1; i >= 0; i--) {
    const b = sorted[i] as Block
    let turn: { role: 'usuario' | 'agente'; text: string } | undefined
    if (b.type === 'user') turn = { role: 'usuario', text: b.text }
    else if (b.type === 'text' && b.complete && b.text.trim() !== '') {
      turn = { role: 'agente', text: b.text }
    }
    if (turn === undefined) continue
    const cost = estimateTokens(turn.text) + 4
    if (used + cost > maxTokens && out.length > 0) break
    out.unshift(turn)
    used += cost
  }
  return out
}
