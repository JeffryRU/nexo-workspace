import { LIMITS } from '@nexo/contracts'

/**
 * Une pares sustitutos partidos entre trozos: si un trozo termina en un sustituto alto, lo retiene
 * hasta el siguiente. `flush` devuelve lo retenido (un sustituto suelto) al terminar el flujo.
 */
export class SurrogateJoiner {
  #held = ''

  push(data: string): string {
    let text = this.#held + data
    this.#held = ''
    if (text.length > 0) {
      const last = text.charCodeAt(text.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) {
        this.#held = text.slice(-1)
        text = text.slice(0, -1)
      }
    }
    return text
  }

  flush(): string {
    const held = this.#held
    this.#held = ''
    return held
  }
}

function isStrippable(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0x200e ||
    c === 0x200f ||
    c === 0x061c
  )
}

/**
 * Deja un texto apto para `DisplayText`: sin caracteres de control ni de dirección, recortado y de
 * como máximo `LIMITS.maxTitleLength` unidades sin partir un par sustituto. `null` si queda vacío.
 */
export function sanitizeTitle(raw: string): string | null {
  let out = ''
  for (let i = 0; i < raw.length && out.length < LIMITS.maxTitleLength * 2; i++) {
    if (!isStrippable(raw.charCodeAt(i))) out += raw[i]
  }
  out = out.trim()
  if (out.length > LIMITS.maxTitleLength) {
    let end = LIMITS.maxTitleLength
    const c = out.charCodeAt(end - 1)
    if (c >= 0xd800 && c <= 0xdbff) end--
    out = out.slice(0, end).trimEnd()
  }
  return out.length === 0 ? null : out
}

/** Máximo de unidades de una carga OSC que se acumulan; más allá se descarta hasta el terminador. */
export const MAX_OSC_PAYLOAD = 2048

type State = 'ground' | 'esc' | 'osc' | 'osc-esc'

/**
 * Extrae títulos de ventana (OSC 0 y OSC 2, terminados en BEL o ESC \) de un flujo de salida que
 * llega en trozos arbitrarios. Tolera secuencias incompletas, enormes o abortadas.
 */
export class OscTitleParser {
  #state: State = 'ground'
  #payload = ''
  #overflow = false

  feed(data: string): string[] {
    const titles: string[] = []
    let i = 0
    while (i < data.length) {
      if (this.#state === 'ground') {
        const at = data.indexOf('\x1b', i)
        if (at === -1) break
        this.#state = 'esc'
        i = at + 1
        continue
      }
      const ch = data[i] as string
      i++
      switch (this.#state) {
        case 'esc':
          if (ch === ']') this.#begin()
          else this.#state = ch === '\x1b' ? 'esc' : 'ground'
          break
        case 'osc':
          if (ch === '\x07') this.#finish(titles)
          else if (ch === '\x1b') this.#state = 'osc-esc'
          else if (ch === '\x18' || ch === '\x1a') this.#state = 'ground'
          else this.#append(ch)
          break
        case 'osc-esc':
          if (ch === '\\') this.#finish(titles)
          else if (ch === ']') this.#begin()
          else this.#state = ch === '\x1b' ? 'osc-esc' : 'ground'
          break
        default:
          break
      }
    }
    return titles
  }

  #begin(): void {
    this.#state = 'osc'
    this.#payload = ''
    this.#overflow = false
  }

  #append(ch: string): void {
    if (this.#overflow) return
    if (this.#payload.length >= MAX_OSC_PAYLOAD) {
      this.#overflow = true
      this.#payload = ''
      return
    }
    this.#payload += ch
  }

  #finish(titles: string[]): void {
    const payload = this.#payload
    const overflow = this.#overflow
    this.#state = 'ground'
    this.#payload = ''
    this.#overflow = false
    if (overflow) return
    const match = /^[02];/.exec(payload)
    if (match === null) return
    const title = sanitizeTitle(payload.slice(2))
    if (title !== null) titles.push(title)
  }
}
