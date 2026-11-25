/** Utilidades de texto: saneado de lo que se muestra, quitar ANSI y trocear escrituras. */

const BIDI = /[‪-‮⁦-⁩‎‏؜]/u

/**
 * Texto seguro para la terminal del usuario: sin ESC, controles C0/C1, separadores de línea ni
 * caracteres bidireccionales. Cada uno se reemplaza por su escape visible (\xNN / \uNNNN).
 */
export function sanitize(value: string, maxLength = 200): string {
  let out = ''
  let count = 0
  for (const ch of value) {
    if (count >= maxLength) return `${out}…`
    const c = ch.codePointAt(0) ?? 0
    const bad =
      c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || BIDI.test(ch)
    if (bad) {
      out +=
        c < 0x100
          ? `\\x${c.toString(16).padStart(2, '0')}`
          : `\\u${c.toString(16).padStart(4, '0')}`
    } else out += ch
    count++
  }
  return out
}

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

/** Quita ANSI de un texto completo y resuelve \r (el último segmento de la línea gana). */
export function cleanOutput(text: string): string {
  const plain = new AnsiStripper().feed(text)
  return plain
    .split('\n')
    .map((line) => {
      const parts = line.split('\r').filter((p) => p !== '')
      return parts.length === 0 ? '' : (parts[parts.length - 1] as string)
    })
    .join('\n')
}

/** Últimas `n` líneas; un salto final no cuenta como línea vacía. */
export function lastLines(text: string, n: number): string {
  if (text === '') return ''
  const lines = text.split('\n')
  const endsWithNewline = lines[lines.length - 1] === ''
  if (endsWithNewline) lines.pop()
  return `${lines.slice(-n).join('\n')}${endsWithNewline ? '\n' : ''}`
}

/** Limpiador para salida continua (--follow): ANSI fuera, CRLF y CR sueltos como salto de línea. */
export class StreamCleaner {
  readonly #stripper = new AnsiStripper()
  #pendingCr = false

  feed(chunk: string): string {
    let text = this.#stripper.feed(chunk)
    if (this.#pendingCr) {
      text = `\r${text}`
      this.#pendingCr = false
    }
    if (text.endsWith('\r')) {
      this.#pendingCr = true
      text = text.slice(0, -1)
    }
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }
}

/** Trocea en piezas de como máximo `maxBytes` bytes UTF-8 sin partir pares sustitutos. */
export function chunkText(text: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxBytes)
    let bytes = Buffer.byteLength(text.slice(start, end), 'utf8')
    while (bytes > maxBytes) {
      end -= Math.max(1, Math.ceil((bytes - maxBytes) / 4))
      bytes = Buffer.byteLength(text.slice(start, end), 'utf8')
    }
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    if (end <= start) end = start + 1
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}
