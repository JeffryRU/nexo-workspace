import { LIMITS, sanitizeBodyText, utf8ByteLength } from '@nexo/contracts'

/** Texto de una línea: control y espacios repetidos pasan a un espacio; recorta sin partir pares. */
export function line(value: string, maxChars: number, fallback = ''): string {
  let out = ''
  let pendingSpace = false
  for (const ch of sanitizeBodyText(value)) {
    const c = ch.codePointAt(0) ?? 0
    const isControl = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029
    if (isControl || ch === ' ') {
      pendingSpace = out.length > 0
      continue
    }
    if (pendingSpace) out += ' '
    pendingSpace = false
    out += ch
  }
  if (out.length > maxChars) {
    let cut = maxChars
    const code = out.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut--
    out = out.slice(0, cut)
  }
  return out === '' ? fallback : out
}

/** Parte `text` (ya limpio) en trozos de a lo sumo `maxBytes` UTF-8 sin partir un carácter. */
export function splitDelta(text: string, maxBytes: number = LIMITS.maxDeltaBytes): string[] {
  if (text === '') return []
  if (text.length <= maxBytes / 3 || utf8ByteLength(text) <= maxBytes) return [text]
  const chunks: string[] = []
  let start = 0
  let bytes = 0
  let index = 0
  for (const ch of text) {
    const n = utf8ByteLength(ch)
    if (bytes + n > maxBytes) {
      chunks.push(text.slice(start, index))
      start = index
      bytes = 0
    }
    bytes += n
    index += ch.length
  }
  chunks.push(text.slice(start))
  return chunks
}

/**
 * Acumula texto que llega en trozos arbitrarios (un trozo puede acabar entre las dos mitades de un par
 * sustituto) y entrega solo texto sin sustitutos partidos.
 */
export class TextCarry {
  #carry = ''

  push(chunk: string): string {
    let s = this.#carry + chunk
    this.#carry = ''
    const last = s.charCodeAt(s.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      this.#carry = s.slice(-1)
      s = s.slice(0, -1)
    }
    return s
  }

  /** Lo que quedó retenido al cerrar el bloque (un sustituto alto suelto). */
  flush(): string {
    const rest = this.#carry
    this.#carry = ''
    return rest
  }
}

/** Recorta `text` a `maxBytes` UTF-8 sin partir un carácter; `truncated` indica si se perdió algo. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (text.length <= maxBytes / 3 || utf8ByteLength(text) <= maxBytes) {
    return { text, truncated: false }
  }
  let bytes = 0
  let index = 0
  for (const ch of text) {
    bytes += utf8ByteLength(ch)
    if (bytes > maxBytes) break
    index += ch.length
  }
  return { text: text.slice(0, index), truncated: true }
}
