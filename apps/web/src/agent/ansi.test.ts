import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ansiClass, parseAnsi, stripAnsi, tailLines } from './ansi.ts'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe('parseAnsi', () => {
  it('texto sin secuencias: un solo tramo', () => {
    expect(parseAnsi('hola\nmundo\t!')).toEqual([{ text: 'hola\nmundo\t!' }])
    expect(parseAnsi('')).toEqual([])
  })

  it('colores estándar y brillantes, negrita y reinicio', () => {
    const spans = parseAnsi(`${ESC}[1;31mrojo${ESC}[0m normal ${ESC}[92mverde`)
    expect(spans).toEqual([
      { text: 'rojo', bold: true, fg: 1 },
      { text: ' normal ' },
      { text: 'verde', fg: 10 },
    ])
  })

  it('fondo, cursiva, subrayado, tenue y sus desactivaciones', () => {
    const spans = parseAnsi(`${ESC}[44;3;4;2mA${ESC}[23;24;22;49mB${ESC}[103mC${ESC}[39;49mD`)
    expect(spans[0]).toEqual({ text: 'A', bg: 4, italic: true, underline: true, dim: true })
    expect(spans[1]).toEqual({ text: 'B' })
    expect(spans[2]).toEqual({ text: 'C', bg: 11 })
    expect(spans[3]).toEqual({ text: 'D' })
  })

  it('256 colores: solo se conservan los 16 primeros; 24 bits se consumen sin efecto', () => {
    expect(parseAnsi(`${ESC}[38;5;9mA`)).toEqual([{ text: 'A', fg: 9 }])
    expect(parseAnsi(`${ESC}[38;5;200mA`)).toEqual([{ text: 'A' }])
    expect(parseAnsi(`${ESC}[48;5;3mA`)).toEqual([{ text: 'A', bg: 3 }])
    expect(parseAnsi(`${ESC}[38;2;255;0;0;1mA`)).toEqual([{ text: 'A', bold: true }])
  })

  it('descarta cursor, borrado, título y enlaces OSC 8 sin dejar rastro', () => {
    const input = `a${ESC}[2Jb${ESC}[10;5Hc${ESC}]0;titulo${BEL}d${ESC}]8;;http://x${ESC}\\enlace${ESC}]8;;${ESC}\\e`
    expect(stripAnsi(input)).toBe('abcdenlacee')
  })

  it('\\r\\n es un salto y \\r suelto reescribe la línea (barras de progreso)', () => {
    expect(stripAnsi('a\r\nb')).toBe('a\nb')
    expect(stripAnsi('10%\r50%\r100%\nlisto')).toBe('100%\nlisto')
    expect(stripAnsi('x\r')).toBe('x')
  })

  it('quita controles (NUL, BEL, DEL, C1) pero conserva tabulador y salto', () => {
    expect(stripAnsi(`a\u0000b${BEL}c\u007fd\u009fe\tf\ng`)).toBe('abcde\tf\ng')
  })

  it('une tramos contiguos con el mismo estilo', () => {
    expect(parseAnsi(`${ESC}[31ma${ESC}[31mb`)).toEqual([{ text: 'ab', fg: 1 }])
  })
})

describe('ansiClass', () => {
  it('solo emite clases de una lista cerrada', () => {
    expect(ansiClass({ fg: 1, bg: 2, bold: true, dim: true, italic: true, underline: true })).toBe(
      'ansi-fg-1 ansi-bg-2 ansi-bold ansi-dim ansi-italic ansi-underline',
    )
    expect(ansiClass({})).toBe('')
  })
})

describe('tailLines', () => {
  it('conserva las últimas líneas y cuenta las ocultas', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toEqual({ text: 'c\nd', hidden: 2 })
    expect(tailLines('a\nb', 5)).toEqual({ text: 'a\nb', hidden: 0 })
    expect(tailLines('a\nb\n', 2)).toEqual({ text: 'b\n', hidden: 1 })
    expect(tailLines('abc', 0)).toEqual({ text: '', hidden: 0 })
  })
})

describe('propiedades', () => {
  const hostile = fc.string({
    unit: fc.constantFrom(
      ESC,
      BEL,
      '[',
      ']',
      ';',
      '0',
      '1',
      '3',
      'm',
      'H',
      'a',
      '\r',
      '\n',
      '\\',
      '\u009b',
    ),
    maxLength: 80,
  })

  it('la salida nunca contiene ESC, BEL ni otros controles (salvo \\n y \\t)', () => {
    fc.assert(
      fc.property(fc.oneof(hostile, fc.string({ unit: 'binary', maxLength: 120 })), (s) => {
        const out = stripAnsi(s)
        for (const ch of out) {
          const c = ch.codePointAt(0) as number
          expect(c === 9 || c === 10 || (c >= 0x20 && c < 0x7f) || c > 0x9f).toBe(true)
        }
      }),
      { numRuns: 400 },
    )
  })

  it('un texto sin controles pasa idéntico', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme-ascii', maxLength: 100 }), (s) => {
        expect(stripAnsi(s)).toBe(s)
      }),
    )
  })

  it('los colores salen siempre en 0-15', () => {
    fc.assert(
      fc.property(hostile, (s) => {
        for (const span of parseAnsi(s)) {
          for (const c of [span.fg, span.bg]) {
            if (c !== undefined) expect(c >= 0 && c <= 15).toBe(true)
          }
        }
      }),
    )
  })
})
