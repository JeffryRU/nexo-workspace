import { describe, expect, it } from 'vitest'
import { isWellFormed } from './test-helpers.ts'
import { AnsiStripper, chunkText, cleanOutput, lastLines, StreamCleaner, sanitize } from './text.ts'

const ESC = '\u001b'

describe('sanitize', () => {
  it('escapa ESC, controles, C1, separadores de línea y bidi', () => {
    expect(sanitize(`a${ESC}[31mb`)).toBe('a\\x1b[31mb')
    expect(sanitize('x\ny\r\tz\u0000')).toBe('x\\x0ay\\x0d\\x09z\\x00')
    expect(sanitize('\u009b31m')).toBe('\\x9b31m')
    expect(sanitize('a\u2028b\u2029')).toBe('a\\u2028b\\u2029')
    expect(sanitize('‮gnp.exe')).toBe('\\u202egnp.exe')
  })

  it('conserva el texto normal, unicode y emoji', () => {
    expect(sanitize('árbol ñandú 日本語 🚀 é')).toBe('árbol ñandú 日本語 🚀 é')
  })

  it('acota la longitud', () => {
    expect(sanitize('a'.repeat(300), 10)).toBe(`${'a'.repeat(10)}…`)
  })
})

describe('AnsiStripper', () => {
  const strip = (s: string) => new AnsiStripper().feed(s)

  it('quita CSI, OSC (BEL y ST), DCS y ESC simples', () => {
    expect(strip(`${ESC}[1;31mrojo${ESC}[0m`)).toBe('rojo')
    expect(strip(`${ESC}]0;título\u0007texto`)).toBe('texto')
    expect(strip(`${ESC}]8;;http://x${ESC}\\enlace${ESC}]8;;${ESC}\\`)).toBe('enlace')
    expect(strip(`${ESC}Pq#0;2;0;0;0${ESC}\\ok`)).toBe('ok')
    expect(strip(`${ESC}(Bok${ESC}=${ESC}>`)).toBe('ok')
    expect(strip('\u009b31mx\u009d0;t\u0007y')).toBe('xy')
  })

  it('quita controles sueltos pero conserva \\n, \\r y \\t', () => {
    expect(strip('a\u0007b\u0000c\u007fd\te\r\nf')).toBe('abcd\te\r\nf')
  })

  it('una secuencia partida entre trozos se descarta completa', () => {
    const s = new AnsiStripper()
    expect(s.feed(`ab${ESC}`) + s.feed('[3') + s.feed('1mcd')).toBe('abcd')
    const o = new AnsiStripper()
    expect(o.feed(`x${ESC}]0;ti`) + o.feed(`tulo${ESC}`) + o.feed('\\y')).toBe('xy')
  })

  it('un OSC sin terminar no se traga la salida para siempre', () => {
    const out = strip(`${ESC}]0;${'a'.repeat(10_000)}visible`)
    expect(out.length).toBeGreaterThan(0)
    expect(out.endsWith('visible')).toBe(true)
  })

  it('un ESC dentro de una secuencia reinicia el análisis', () => {
    expect(strip(`${ESC}[31${ESC}[0mok`)).toBe('ok')
    expect(strip(`${ESC}${ESC}[0mok`)).toBe('ok')
    expect(strip(`${ESC}(${ESC}[0mok`)).toBe('ok')
    expect(strip(`${ESC}]0;t${ESC}[0mok`)).toBe('ok')
    expect(strip(`${ESC}[31\u0001mok`)).toBe('mok')
  })
})

describe('cleanOutput, lastLines y StreamCleaner', () => {
  it('resuelve CRLF y \\r de progreso', () => {
    expect(cleanOutput('uno\r\ndos\r\n')).toBe('uno\ndos\n')
    expect(cleanOutput('10%\r50%\r100%\nfin')).toBe('100%\nfin')
    expect(cleanOutput('\r\n\r\n')).toBe('\n\n')
  })

  it('lastLines respeta el salto final', () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc\n')
    expect(lastLines('a\nb\nc', 2)).toBe('b\nc')
    expect(lastLines('', 5)).toBe('')
    expect(lastLines('a\n', 10)).toBe('a\n')
  })

  it('StreamCleaner une un CRLF partido entre trozos', () => {
    const c = new StreamCleaner()
    expect(c.feed('uno\r') + c.feed('\ndos\r') + c.feed('tres')).toBe('uno\ndos\ntres')
  })
})

describe('chunkText', () => {
  it('trocea por bytes UTF-8 sin partir pares sustitutos', () => {
    const text = '🚀'.repeat(100)
    const chunks = chunkText(text, 10)
    expect(chunks.join('')).toBe(text)
    for (const c of chunks) {
      expect(Buffer.byteLength(c)).toBeLessThanOrEqual(10)
      expect(isWellFormed(c)).toBe(true)
    }
  })

  it('texto vacío no genera trozos y uno corto, uno', () => {
    expect(chunkText('', 10)).toEqual([])
    expect(chunkText('hola', 10)).toEqual(['hola'])
  })

  it('un límite menor que un carácter igualmente avanza', () => {
    expect(chunkText('€€', 2).join('')).toBe('€€')
  })
})
