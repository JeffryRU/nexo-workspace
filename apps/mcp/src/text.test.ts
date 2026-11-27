import { utf8ByteLength } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  AnsiStripper,
  clampBytes,
  cleanBody,
  fitOutput,
  lastLines,
  oneLine,
  redact,
  tailUtf8,
  wellFormed,
} from './text.ts'

const LS = String.fromCharCode(0x2028)
const RLO = String.fromCharCode(0x202e)
const LONE = String.fromCharCode(0xd800)

describe('AnsiStripper y cleanBody', () => {
  it('quita colores, OSC y controles', () => {
    expect(cleanBody('\x1b[31mrojo\x1b[0m y \x1b]0;titulo\x07fin')).toBe('rojo y fin')
    expect(cleanBody('a\x00b\x07c\x7fd')).toBe('abcd')
  })

  it('resuelve el retorno de carro: gana el último segmento', () => {
    expect(cleanBody('10%\r50%\r100%\nlisto')).toBe('100%\nlisto')
    expect(cleanBody('a\r\nb')).toBe('a\nb')
  })

  it('una secuencia partida entre dos trozos se descarta completa', () => {
    const s = new AnsiStripper()
    expect(s.feed('uno\x1b[3') + s.feed('1mdos')).toBe('unodos')
  })

  it('quita bidireccionales y arregla sustitutos sueltos', () => {
    expect(cleanBody(`a${RLO}b`)).toBe('ab')
    expect(cleanBody(`x${LONE}y`)).toBe('x\ufffdy')
    expect(wellFormed('ok')).toBe('ok')
  })

  it('una cadena OSC sin cierre no se come todo el texto para siempre', () => {
    const out = cleanBody(`\x1b]0;${'a'.repeat(10_000)}resto`)
    expect(out).toContain('resto')
  })
})

describe('oneLine', () => {
  it('pasa controles y separadores a espacio y acota', () => {
    expect(oneLine(`a\nb${LS}c\x1b[1md`)).toBe('a b cd')
    expect(oneLine('x'.repeat(300), 10)).toBe(`${'x'.repeat(10)}…`)
    expect(oneLine('  hola  ')).toBe('hola')
  })
})

describe('recortes', () => {
  it('lastLines conserva las últimas líneas', () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc\n')
    expect(lastLines('a\nb\nc', 1)).toBe('c')
    expect(lastLines('', 3)).toBe('')
  })

  it('clampBytes por la cabeza o por la cola sin partir caracteres', () => {
    const text = 'añb😀c'
    expect(clampBytes(text, 100)).toEqual({ text, truncated: false })
    expect(clampBytes(text, 3).text).toBe('añ')
    expect(clampBytes(text, 5, 'tail').text).toBe('😀c')
    expect(tailUtf8('abc', 10)).toBe('abc')
  })

  it('fitOutput añade el aviso y respeta el tope', () => {
    const out = fitOutput('x'.repeat(1000), 100)
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(100)
    expect(out.endsWith('[salida recortada]')).toBe(true)
    expect(fitOutput('corto', 100)).toBe('corto')
    expect(utf8ByteLength(fitOutput('x'.repeat(100), 5))).toBeLessThanOrEqual(20)
  })
})

describe('redact', () => {
  it('oculta tokens del daemon, Bearer, claves y parámetros', () => {
    expect(redact('Sec-WebSocket-Protocol: nexo.v1, nexo.token.AbC_123-xyz')).not.toContain(
      'AbC_123',
    )
    expect(redact('Authorization: Bearer abc.def-ghi')).not.toContain('abc.def')
    expect(redact('clave sk-abcdefgh12345')).not.toContain('abcdefgh12345')
    expect(redact('http://x/?t=secreto&a=1')).toBe('http://x/?t=[redactado]&a=1')
    expect(redact('nada que ocultar')).toBe('nada que ocultar')
  })
})

describe('propiedades', () => {
  const hasControl = (text: string, allowed: readonly number[]): boolean =>
    [...text].some((ch) => {
      const c = ch.codePointAt(0) ?? 0
      const control = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029
      return control && !allowed.includes(c)
    })

  it('cleanBody nunca deja ESC ni controles (salvo \\n y \\t) y es UTF-8 válido', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), (raw) => {
        const out = cleanBody(raw)
        expect(hasControl(out, [0x0a, 0x09])).toBe(false)
        expect(out.includes('\r')).toBe(false)
        expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out)
      }),
      { numRuns: 300 },
    )
  })

  it('cleanBody con secuencias ANSI mezcladas nunca deja un ESC', () => {
    const piece = fc.oneof(
      fc.string({ maxLength: 20 }),
      fc.constantFrom(
        '\x1b[31m',
        '\x1b[0m',
        '\x1b]0;t\x07',
        '\x1b',
        '\x9b',
        '\r',
        '\n',
        '\x1bP',
        '\x1b\\',
      ),
    )
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (pieces) => {
        expect(cleanBody(pieces.join('')).includes('\x1b')).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  it('clampBytes y tailUtf8 respetan el tope y son prefijo o sufijo', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 80 }),
        fc.integer({ min: 0, max: 120 }),
        (text, max) => {
          const head = clampBytes(text, max)
          expect(utf8ByteLength(head.text)).toBeLessThanOrEqual(max)
          expect(text.startsWith(head.text)).toBe(true)
          const tail = clampBytes(text, max, 'tail')
          expect(utf8ByteLength(tail.text)).toBeLessThanOrEqual(max)
          expect(text.endsWith(tail.text)).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('fitOutput nunca pasa del tope (con tope razonable)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), fc.integer({ min: 40, max: 400 }), (text, max) => {
        expect(utf8ByteLength(fitOutput(text, max))).toBeLessThanOrEqual(max)
      }),
      { numRuns: 300 },
    )
  })

  it('oneLine nunca deja saltos ni controles', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (raw) => {
        const out = oneLine(raw, 50)
        expect(hasControl(out, [])).toBe(false)
        expect([...out].length).toBeLessThanOrEqual(51)
      }),
      { numRuns: 300 },
    )
  })
})
