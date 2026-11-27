import type { BlockDraft } from '@nexo/contracts'
import { clampBytes, cleanBody, oneLine } from './text.ts'

/** Un bloque resumido para el modelo: texto limpio y acotado, nunca el diff ni la entrada cruda. */
export type SimpleBlock = {
  index: number
  type: BlockDraft['type']
  turn: number
  /** Estado propio del tipo (`pending`, `ok`, `error`...), si lo hay. */
  state?: string
  text: string
  truncated?: boolean
}

export type RenderOptions = {
  /** Incluir la salida de las acciones (puede contener lo que el agente leyó); apagado por omisión. */
  includeActionOutput?: boolean
  /** Tope de bytes por bloque. */
  perBlockBytes?: number
}

export const DEFAULT_PER_BLOCK_BYTES = 4 * 1024
const ACTION_OUTPUT_BYTES = 2 * 1024

function fit(text: string, max: number): { text: string; truncated: boolean } {
  return clampBytes(cleanBody(text), max)
}

/** Texto y estado de un bloque según su tipo. */
export function renderBlock(
  block: BlockDraft & { index: number; turn: number },
  options: RenderOptions = {},
): SimpleBlock {
  const max = options.perBlockBytes ?? DEFAULT_PER_BLOCK_BYTES
  const base = { index: block.index, type: block.type, turn: block.turn }
  switch (block.type) {
    case 'user':
    case 'text':
    case 'reasoning': {
      const r = fit(block.text, max)
      return {
        ...base,
        text: r.text,
        ...(r.truncated || ('truncated' in block && block.truncated === true)
          ? { truncated: true }
          : {}),
      }
    }
    case 'action': {
      const head = `${block.kind} ${block.tool}: ${oneLine(block.title, 200)}`
      const extra: string[] = []
      if (block.path !== undefined) extra.push(`ruta: ${oneLine(block.path, 300)}`)
      if (block.exitCode !== undefined && block.exitCode !== null) {
        extra.push(`código de salida: ${block.exitCode}`)
      }
      if (block.diff !== undefined) extra.push(`diff de ${oneLine(block.diff.path, 300)} (omitido)`)
      let truncated = false
      if (options.includeActionOutput === true && block.output !== undefined) {
        const r = fit(block.output, Math.min(max, ACTION_OUTPUT_BYTES))
        if (r.text !== '') extra.push(`salida:\n${r.text}`)
        truncated = r.truncated
      } else if (block.output !== undefined && block.output !== '') {
        extra.push('salida omitida (usa includeActionOutput)')
      }
      return {
        ...base,
        state: block.status,
        text: [head, ...extra].join('\n'),
        ...(truncated ? { truncated: true } : {}),
      }
    }
    case 'permission': {
      const options_ = block.options
        .map((o) => `${oneLine(o.id, 64)}=${oneLine(o.label, 80)} (${o.kind})`)
        .join(', ')
      const detail = block.detail === undefined ? '' : `\n${fit(block.detail, 1024).text}`
      return {
        ...base,
        state: block.state,
        text: `permiso ${block.tool}: ${oneLine(block.title, 200)}${detail}\nopciones: ${options_}`,
      }
    }
    case 'question': {
      const lines = block.questions.map((q) => {
        const opts = q.options.map((o) => oneLine(o.label, 80)).join(' | ')
        return `${fit(q.question, 1024).text}${opts === '' ? '' : ` [${opts}]`}`
      })
      return { ...base, state: block.state, text: lines.join('\n') }
    }
    case 'plan': {
      const lines = block.entries.slice(0, 50).map((e) => `[${e.status}] ${oneLine(e.text, 200)}`)
      return { ...base, text: lines.join('\n') }
    }
    case 'error': {
      const r = fit(block.message, 2048)
      return {
        ...base,
        state: block.fatal ? 'fatal' : 'error',
        text: `${oneLine(block.code, 64)}: ${r.text}`,
      }
    }
    case 'usage': {
      const u = block.usage
      const parts = [`fin: ${block.stopReason}`]
      if (u.inputTokens !== undefined) parts.push(`entrada ${u.inputTokens}`)
      if (u.outputTokens !== undefined) parts.push(`salida ${u.outputTokens}`)
      if (u.costUsd !== undefined) parts.push(`costo US$ ${u.costUsd}`)
      return { ...base, text: parts.join(', ') }
    }
  }
}

const LABEL: Record<BlockDraft['type'], string> = {
  user: 'usuario',
  text: 'agente',
  reasoning: 'razonamiento',
  action: 'acción',
  permission: 'permiso',
  question: 'pregunta',
  plan: 'plan',
  error: 'error',
  usage: 'uso',
}

/** Una línea de encabezado por bloque más su texto, para leer de corrido. */
export function blocksToText(blocks: readonly SimpleBlock[]): string {
  return blocks
    .map((b) => {
      const state = b.state === undefined ? '' : ` ${b.state}`
      return `#${b.index} ${LABEL[b.type]}${state} (turno ${b.turn})\n${b.text}${b.truncated === true ? '\n[recortado]' : ''}`
    })
    .join('\n\n')
}
