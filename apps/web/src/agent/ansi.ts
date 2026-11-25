/**
 * Salida de herramientas (texto con secuencias ANSI) a tramos con estilo. Nunca interpreta nada como HTML:
 * solo reconoce SGR (negrita, tenue, cursiva, subrayado y los 16 colores) y descarta el resto de secuencias
 * (cursor, OSC con enlaces o título, DCS...) y los caracteres de control. El color sale como número, y la
 * interfaz lo traduce a una clase CSS: ningún valor de la entrada llega a un atributo `style`.
 */

export type AnsiStyle = {
  /** 0-15 (colores estándar y brillantes). */
  fg?: number
  bg?: number
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

export type AnsiSpan = { text: string } & AnsiStyle

// Una secuencia de cadena (OSC, DCS...) sin terminador no consume más de 4096 caracteres: el resto sigue
// siendo texto. Orden: cadenas, CSI (7 u 8 bits) y escapes de dos caracteres.
// (String.raw: los escapes `\x1b` los interpreta la expresión regular, no el lenguaje.)
// biome-ignore lint/complexity/useRegexLiterals: un literal dispararía noControlCharactersInRegex
const ESCAPES = new RegExp(
  String.raw`\x1b\][^\x07\x1b]{0,4096}(?:\x07|\x1b\\)|\x9d[^\x07\x9c]{0,4096}(?:\x07|\x9c)|\x1b[PX^_][^\x1b]{0,4096}\x1b\\|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]`,
  'g',
)
// biome-ignore lint/complexity/useRegexLiterals: ídem
const SGR = new RegExp(String.raw`^(?:\x1b\[|\x9b)([0-9;:]*)m$`)

/** Quita todo control salvo salto de línea y tabulador (el `\r` se trata antes); también DEL y C1. */
function stripControls(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    const control = c < 0x20 ? c !== 0x09 && c !== 0x0a : c >= 0x7f && c <= 0x9f
    if (!control) out += ch
  }
  return out
}

/** `\r\n` es un salto; un `\r` suelto reescribe la línea (barras de progreso): vale lo último escrito. */
function resolveCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const parts = line.split('\r')
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== '') return parts[i] as string
      return ''
    })
    .join('\n')
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)))
  let next: AnsiStyle = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i] as number
    if (!Number.isInteger(c)) continue
    if (c === 0) next = {}
    else if (c === 1) next.bold = true
    else if (c === 2) next.dim = true
    else if (c === 3) next.italic = true
    else if (c === 4) next.underline = true
    else if (c === 22) {
      delete next.bold
      delete next.dim
    } else if (c === 23) delete next.italic
    else if (c === 24) delete next.underline
    else if (c >= 30 && c <= 37) next.fg = c - 30
    else if (c >= 90 && c <= 97) next.fg = c - 90 + 8
    else if (c >= 40 && c <= 47) next.bg = c - 40
    else if (c >= 100 && c <= 107) next.bg = c - 100 + 8
    else if (c === 39) delete next.fg
    else if (c === 49) delete next.bg
    else if (c === 38 || c === 48) {
      // 38;5;n (256 colores) y 38;2;r;g;b (24 bits): se consumen los parámetros; solo n < 16 se conserva.
      const mode = codes[i + 1]
      if (mode === 5) {
        const n = codes[i + 2]
        if (n !== undefined && Number.isInteger(n) && n >= 0 && n < 16) {
          if (c === 38) next.fg = n
          else next.bg = n
        }
        i += 2
      } else if (mode === 2) i += 4
    }
  }
  return next
}

/** Tramos de texto con su estilo; tramos vacíos no aparecen. */
export function parseAnsi(input: string): AnsiSpan[] {
  const text = resolveCarriageReturns(input)
  const spans: AnsiSpan[] = []
  let style: AnsiStyle = {}
  let last = 0
  const push = (raw: string) => {
    const clean = stripControls(raw)
    if (clean !== '') spans.push({ text: clean, ...style })
  }
  ESCAPES.lastIndex = 0
  for (let m = ESCAPES.exec(text); m !== null; m = ESCAPES.exec(text)) {
    push(text.slice(last, m.index))
    last = m.index + m[0].length
    const seq = m[0]
    // Solo CSI terminada en `m` es SGR.
    const sgr = SGR.exec(seq)
    if (sgr !== null) style = applySgr(style, sgr[1] as string)
  }
  push(text.slice(last))
  return mergeSpans(spans)
}

function sameStyle(a: AnsiSpan, b: AnsiSpan): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  )
}

function mergeSpans(spans: AnsiSpan[]): AnsiSpan[] {
  const out: AnsiSpan[] = []
  for (const s of spans) {
    const prev = out[out.length - 1]
    if (prev !== undefined && sameStyle(prev, s)) prev.text += s.text
    else out.push({ ...s })
  }
  return out
}

/** El texto sin ninguna secuencia ni carácter de control (salvo saltos y tabuladores). */
export function stripAnsi(input: string): string {
  return parseAnsi(input)
    .map((s) => s.text)
    .join('')
}

/** Las últimas `maxLines` líneas; `hidden` es cuántas se quitaron. */
export function tailLines(text: string, maxLines: number): { text: string; hidden: number } {
  if (maxLines < 1) return { text: '', hidden: 0 }
  let count = 1
  for (let i = text.length - 1; i >= 0; i--) {
    if (text.charCodeAt(i) === 10 && ++count > maxLines) {
      return { text: text.slice(i + 1), hidden: countLines(text.slice(0, i + 1)) }
    }
  }
  return { text, hidden: 0 }
}

function countLines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** Clases CSS de un tramo (los colores salen de una lista cerrada). */
export function ansiClass(span: AnsiStyle): string {
  const out: string[] = []
  if (span.fg !== undefined) out.push(`ansi-fg-${span.fg}`)
  if (span.bg !== undefined) out.push(`ansi-bg-${span.bg}`)
  if (span.bold === true) out.push('ansi-bold')
  if (span.dim === true) out.push('ansi-dim')
  if (span.italic === true) out.push('ansi-italic')
  if (span.underline === true) out.push('ansi-underline')
  return out.join(' ')
}
