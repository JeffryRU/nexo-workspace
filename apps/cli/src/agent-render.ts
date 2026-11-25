import type { Block, BlockId } from '@nexo/contracts'
import { sanitize, sanitizeMultiline } from './text.ts'

const MAX_OUTPUT_LINES = 12

type Seen = { printed: number; state: string }

/**
 * Pinta el documento de un agente de forma legible y sin repetir: se alimenta con cada versión de un bloque
 * (un `agent.block`, un delta ya aplicado o una página de `agent.snapshot`) y devuelve solo lo nuevo. Así
 * una resincronización tras reconectar no duplica lo que ya se mostró.
 */
export class AgentPrinter {
  readonly #seen = new Map<BlockId, Seen>()
  /** Bloque de texto cuya línea sigue abierta (se cierra con un salto antes de pintar otra cosa). */
  #open: BlockId | undefined

  /** Texto nuevo de `block` (vacío si no hay nada que mostrar). */
  feed(block: Block): string {
    const prev = this.#seen.get(block.id)
    const body = this.#body(block, prev)
    if (body === undefined) return ''
    const closing = this.#open !== undefined && this.#open !== block.id ? '\n' : ''
    if (closing !== '') this.#open = undefined
    return closing + body
  }

  /** Cierra la línea abierta, si la hay. */
  flush(): string {
    if (this.#open === undefined) return ''
    this.#open = undefined
    return '\n'
  }

  #body(block: Block, prev: Seen | undefined): string | undefined {
    switch (block.type) {
      case 'user':
        return this.#once(block, prev, `> ${sanitizeMultiline(block.text)}\n`)
      case 'text':
      case 'reasoning':
        return this.#stream(block, prev)
      case 'action':
        return this.#action(block, prev)
      case 'permission': {
        const state = block.state
        if (prev?.state === state) return undefined
        this.#seen.set(block.id, { printed: 0, state })
        if (state === 'pending') {
          const options = block.options.map((o, i) => `  ${i + 1}) ${sanitize(o.label, 80)}`)
          const detail = block.detail === undefined ? [] : [`  ${sanitize(block.detail, 200)}`]
          return [
            `? Permiso: ${sanitize(block.title, 200)} [${sanitize(block.tool, 64)}]`,
            ...detail,
            ...options,
            '',
          ].join('\n')
        }
        const chosen = block.options.find((o) => o.id === block.selectedOptionId)
        return `  permiso ${PERMISSION_STATE[state]}${chosen === undefined ? '' : `: ${sanitize(chosen.label, 80)}`}\n`
      }
      case 'question': {
        const state = block.state
        if (prev?.state === state) return undefined
        this.#seen.set(block.id, { printed: 0, state })
        if (state === 'pending') {
          const lines: string[] = []
          for (const q of block.questions) {
            lines.push(`? ${sanitize(q.question, 400)}${q.multiSelect ? ' (varias)' : ''}`)
            for (const [i, o] of q.options.entries()) {
              lines.push(`  ${i + 1}) ${sanitize(o.label, 80)}`)
            }
            if (q.allowText) lines.push('  (también admite texto libre)')
          }
          return `${lines.join('\n')}\n`
        }
        return state === 'answered' ? '  pregunta respondida\n' : '  pregunta cancelada\n'
      }
      case 'plan': {
        const text = block.entries.map((e) => `  [${PLAN_MARK[e.status]}] ${sanitize(e.text, 200)}`)
        const state = text.join('\n')
        if (prev?.state === state) return undefined
        this.#seen.set(block.id, { printed: 0, state })
        return `Plan:\n${text.join('\n')}\n`
      }
      case 'error':
        return this.#once(
          block,
          prev,
          `! ${block.fatal ? 'error fatal' : 'error'} (${sanitize(block.code, 64)}): ${sanitizeMultiline(block.message, 2000)}\n`,
        )
      case 'usage': {
        const u = block.usage
        const tokens =
          u.inputTokens === undefined && u.outputTokens === undefined
            ? ''
            : ` (${u.inputTokens ?? 0} entrada, ${u.outputTokens ?? 0} salida)`
        const cost = u.costUsd === undefined ? '' : ` ~$${u.costUsd.toFixed(4)}`
        return this.#once(block, prev, `· fin del turno: ${block.stopReason}${tokens}${cost}\n`)
      }
    }
  }

  #once(block: Block, prev: Seen | undefined, text: string): string | undefined {
    if (prev !== undefined) return undefined
    this.#seen.set(block.id, { printed: 0, state: '' })
    return text
  }

  #stream(
    block: Block & { type: 'text' | 'reasoning' },
    prev: Seen | undefined,
  ): string | undefined {
    const text = sanitizeMultiline(block.text)
    const printed = prev?.printed ?? 0
    const header = prev === undefined && block.type === 'reasoning' ? '~ ' : ''
    // Si el texto cambió por debajo de lo ya mostrado (reemplazo), no se vuelve a pintar.
    const rest = text.length > printed ? text.slice(printed) : ''
    const done = block.complete ? 'complete' : 'open'
    if (prev !== undefined && rest === '' && prev.state === done) return undefined
    this.#seen.set(block.id, { printed: Math.max(printed, text.length), state: done })
    let out = header + rest
    if (block.complete) {
      if (this.#open === block.id) this.#open = undefined
      if (out !== '' || prev?.state === 'open') out += text.endsWith('\n') ? '' : '\n'
    } else if (out !== '') this.#open = block.id
    return out === '' ? undefined : out
  }

  #action(block: Block & { type: 'action' }, prev: Seen | undefined): string | undefined {
    const state = block.status
    if (prev?.state === state) return undefined
    this.#seen.set(block.id, { printed: 0, state })
    const head = `[${sanitize(block.tool, 64)}] ${sanitize(block.title, 200)}`
    if (prev === undefined && (state === 'pending' || state === 'running')) return `${head}\n`
    if (state === 'ok' || state === 'error') {
      const lines: string[] = prev === undefined ? [head] : []
      lines.push(
        `  -> ${state === 'ok' ? 'ok' : 'error'}${block.exitCode === undefined || block.exitCode === null ? '' : ` (código ${block.exitCode})`}`,
      )
      if (block.output !== undefined && block.output !== '') {
        const out = sanitizeMultiline(block.output, 4000).replace(/\n$/, '').split('\n')
        for (const l of out.slice(0, MAX_OUTPUT_LINES)) lines.push(`  | ${l}`)
        if (out.length > MAX_OUTPUT_LINES)
          lines.push(`  | … (${out.length - MAX_OUTPUT_LINES} líneas más)`)
      }
      return `${lines.join('\n')}\n`
    }
    return undefined
  }
}

const PERMISSION_STATE = {
  pending: 'pendiente',
  accepted: 'aceptado',
  rejected: 'rechazado',
  cancelled: 'cancelado',
} as const

const PLAN_MARK = { pending: ' ', 'in-progress': '~', completed: 'x' } as const
