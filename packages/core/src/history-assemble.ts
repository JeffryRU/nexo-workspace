import {
  type BlockDraft,
  LIMITS,
  type ProviderEvent,
  sanitizeBodyText,
  truncateUtf8,
} from '@nexo/contracts'
import type { HistoryTranscriptBlock } from './ports/history.ts'

/**
 * Arma los bloques de una transcripción a partir de los `ProviderEvent` que ya produce el traductor de cada
 * adaptador (el mismo que usa una sesión en vivo): así una sesión leída del historial y la misma sesión en
 * vivo se ven igual. Pura y acotada: un evento con `ref` desconocida se ignora y se cuenta, y un bloque que
 * no cumple el esquema se descarta al final (`BlockDraft`), nunca rompe la lectura.
 */
export class HistoryAssembler {
  readonly #maxBlocks: number
  readonly #entries: { turn: number; ref: string | undefined; block: BlockDraft }[] = []
  readonly #open = new Map<string, number>()
  #turn = 0
  #ignored = 0
  #truncated = false

  constructor(options: { maxBlocks: number }) {
    this.#maxBlocks = Math.max(0, options.maxBlocks)
  }

  /** Eventos ignorados (ref desconocida, evento que no es de bloque). */
  get ignored(): number {
    return this.#ignored
  }

  /** `true` si se cortó por el tope de bloques o se recortó el texto de alguno. */
  get truncated(): boolean {
    return this.#truncated
  }

  get size(): number {
    return this.#entries.length
  }

  get full(): boolean {
    return this.#entries.length >= this.#maxBlocks
  }

  /** Abre un turno nuevo (cada mensaje del usuario). Los turnos empiezan en 1. */
  startTurn(): void {
    this.#turn++
  }

  /** Añade un bloque ya completo (p. ej. el mensaje del usuario). */
  add(block: BlockDraft): void {
    if (this.#entries.length >= this.#maxBlocks) {
      this.#truncated = true
      return
    }
    this.#entries.push({ turn: Math.max(1, this.#turn), ref: undefined, block })
  }

  push(event: ProviderEvent): void {
    switch (event.type) {
      case 'block-start': {
        if (this.#open.has(event.ref)) return void this.#ignored++
        if (this.#entries.length >= this.#maxBlocks) {
          this.#truncated = true
          return
        }
        this.#open.set(event.ref, this.#entries.length)
        this.#entries.push({ turn: Math.max(1, this.#turn), ref: event.ref, block: event.block })
        return
      }
      case 'block-delta': {
        const entry = this.#entry(event.ref)
        if (entry === undefined) return
        const b = entry.block as Record<string, unknown>
        const field = event.field
        if (typeof b[field] !== 'string' && b[field] !== undefined) return void this.#ignored++
        const cur = (b[field] as string | undefined) ?? ''
        const next = sanitizeBodyText(cur + event.text)
        const cut = truncateUtf8(next, LIMITS.maxBlockTextBytes)
        if (cut.length !== next.length) {
          this.#truncated = true
          b.truncated = true
        }
        b[field] = cut
        return
      }
      case 'block-update': {
        const idx = this.#open.get(event.ref)
        const entry = idx === undefined ? undefined : this.#entries[idx]
        if (entry === undefined) return void this.#ignored++
        entry.block = event.block
        return
      }
      case 'block-end': {
        const idx = this.#open.get(event.ref)
        const entry = idx === undefined ? undefined : this.#entries[idx]
        if (entry === undefined) return void this.#ignored++
        if (event.block !== undefined) entry.block = event.block
        this.#open.delete(event.ref)
        return
      }
      default:
        // session-info, usage, turn-end, permisos... no son parte de la transcripción.
        return
    }
  }

  /** Los bloques armados; los que dejaron de ser válidos se descartan. */
  blocks(validate: (b: BlockDraft) => boolean = () => true): HistoryTranscriptBlock[] {
    const out: HistoryTranscriptBlock[] = []
    for (const e of this.#entries) {
      if (validate(e.block)) out.push({ turn: e.turn, block: e.block })
      else this.#ignored++
    }
    return out
  }

  #entry(ref: string): { block: BlockDraft } | undefined {
    const idx = this.#open.get(ref)
    const entry = idx === undefined ? undefined : this.#entries[idx]
    if (entry === undefined) this.#ignored++
    return entry
  }
}
