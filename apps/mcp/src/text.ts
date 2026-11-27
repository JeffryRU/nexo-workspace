/** Texto seguro para el modelo: sin secuencias de escape, sin controles y con tamaño acotado. */
import { truncateUtf8, utf8ByteLength } from '@nexo/contracts'

const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/gu
const MAX_STRING_SEQUENCE = 8192

type State = 'text' | 'esc' | 'escInter' | 'csi' | 'str' | 'strEsc'

/**
 * Quita secuencias ANSI (CSI, OSC, DCS y similares, ESC simples) y controles C0/C1 salvo \n, \r y \t.
 * Con estado: una secuencia partida entre dos trozos se descarta completa.
 */
export class AnsiStripper {
  #state: State = 'text'
  #strLength = 0

  feed(chunk: string): string {
    let out = ''
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i] as string
      const c = chunk.charCodeAt(i)
      switch (this.#state) {
        case 'text':
          if (c === 0x1b) this.#state = 'esc'
          else if (c === 0x9b) this.#state = 'csi'
          else if (c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) {
            this.#enterString()
          } else if (c === 0x0a || c === 0x0d || c === 0x09) out += ch
          else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
            // control suelto: se descarta
          } else out += ch
          break
        case 'esc':
          if (c === 0x5b) this.#state = 'csi'
          else if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) {
            this.#enterString()
          } else if (c >= 0x20 && c <= 0x2f) this.#state = 'escInter'
          else if (c === 0x1b) this.#state = 'esc'
          else this.#state = 'text'
          break
        case 'escInter':
          if (c >= 0x20 && c <= 0x2f) break
          this.#state = c === 0x1b ? 'esc' : 'text'
          break
        case 'csi':
          if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) break
          this.#state = c === 0x1b ? 'esc' : 'text'
          break
        case 'str':
          if (c === 0x07 || c === 0x9c) this.#state = 'text'
          else if (c === 0x1b) this.#state = 'strEsc'
          else if (++this.#strLength > MAX_STRING_SEQUENCE) this.#state = 'text'
          break
        case 'strEsc':
          if (c === 0x5c) this.#state = 'text'
          else {
            this.#state = 'esc'
            i--
          }
          break
      }
    }
    return out
  }

  #enterString(): void {
    this.#state = 'str'
    this.#strLength = 0
  }
}

/** Sustituye sustitutos UTF-16 sueltos por U+FFFD (el texto que sale siempre es UTF-8 válido). */
export function wellFormed(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\ufffd',
  )
}

/**
 * Cuerpo de varias líneas (salida de terminal, texto de un bloque): sin ANSI ni controles ni NUL, con
 * `\r` resuelto (gana el último segmento de la línea) y sin caracteres bidireccionales.
 */
export function cleanBody(text: string): string {
  const plain = new AnsiStripper().feed(text).replace(BIDI, '')
  return wellFormed(
    plain
      .split('\n')
      .map((line) => {
        const parts = line.split('\r').filter((p) => p !== '')
        return parts.length === 0 ? '' : (parts[parts.length - 1] as string)
      })
      .join('\n'),
  )
}

/** Una línea: controles, separadores de línea y bidireccionales pasan a espacio; acotada en caracteres. */
export function oneLine(value: string, maxChars = 200): string {
  const text = new AnsiStripper()
    .feed(value)
    .replace(BIDI, ' ')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: justamente quita controles
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .trim()
  const clean = wellFormed(text)
  const chars = [...clean]
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : clean
}

/** Últimas `n` líneas; un salto final no cuenta como línea vacía. */
export function lastLines(text: string, n: number): string {
  if (text === '') return ''
  const lines = text.split('\n')
  const endsWithNewline = lines[lines.length - 1] === ''
  if (endsWithNewline) lines.pop()
  return `${lines.slice(-Math.max(1, n)).join('\n')}${endsWithNewline ? '\n' : ''}`
}

/** Conserva el final de `text` hasta `maxBytes` UTF-8 sin partir un carácter. */
export function tailUtf8(text: string, maxBytes: number): string {
  if (text.length <= maxBytes && utf8ByteLength(text) <= maxBytes) return text
  let bytes = 0
  let start = text.length
  const chars = [...text]
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] as string
    const n = utf8ByteLength(ch)
    if (bytes + n > maxBytes) break
    bytes += n
    start -= ch.length
  }
  return text.slice(start)
}

export type Clamped = { text: string; truncated: boolean }

/** Recorta por el final (`head`: se queda el principio) o por el principio (`tail`: se queda el final). */
export function clampBytes(
  text: string,
  maxBytes: number,
  keep: 'head' | 'tail' = 'head',
): Clamped {
  if (utf8ByteLength(text) <= maxBytes) return { text, truncated: false }
  return {
    text: keep === 'head' ? truncateUtf8(text, maxBytes) : tailUtf8(text, maxBytes),
    truncated: true,
  }
}

/** Texto final de una herramienta: recortado al presupuesto con un aviso (que también cabe en él). */
export function fitOutput(text: string, maxBytes: number): string {
  const note = '\n[salida recortada]'
  if (utf8ByteLength(text) <= maxBytes) return text
  const room = Math.max(0, maxBytes - utf8ByteLength(note))
  return `${truncateUtf8(text, room)}${note}`
}

const SECRET_PATTERNS: RegExp[] = [
  /nexo\.token\.[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /([?&](?:t|token|key|api_key)=)[^&\s]+/gi,
]

/** Redactor mínimo para lo que va a stderr (el MCP no maneja credenciales, pero un mensaje podría citar una). */
export function redact(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_m: string, p1: unknown) =>
      typeof p1 === 'string' ? `${p1}[redactado]` : '[redactado]',
    )
  }
  return out
}
