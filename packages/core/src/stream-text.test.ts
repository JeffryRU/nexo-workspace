import { DisplayText, LIMITS } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MAX_OSC_PAYLOAD, OscTitleParser, SurrogateJoiner, sanitizeTitle } from './stream-text.ts'

describe('SurrogateJoiner', () => {
  it('une un par sustituto partido entre trozos', () => {
    const j = new SurrogateJoiner()
    const emoji = '😀'
    expect(j.push(`a${emoji[0]}`)).toBe('a')
    expect(j.push(`${emoji[1]}b`)).toBe(`${emoji}b`)
    expect(j.flush()).toBe('')
  })

  it('un sustituto alto final se entrega en flush si no llega su pareja', () => {
    const j = new SurrogateJoiner()
    expect(j.push('\ud83d')).toBe('')
    expect(j.flush()).toBe('\ud83d')
    expect(j.flush()).toBe('')
  })

  it('propiedad: cualquier partición del texto se reensambla idéntica', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 50 }),
        fc.array(fc.nat(60), { maxLength: 8 }),
        (s, cuts) => {
          const j = new SurrogateJoiner()
          let out = ''
          let from = 0
          for (const c of cuts.sort((a, b) => a - b)) {
            const at = Math.min(c, s.length)
            if (at >= from) {
              out += j.push(s.slice(from, at))
              from = at
            }
          }
          out += j.push(s.slice(from)) + j.flush()
          expect(out).toBe(s)
        },
      ),
    )
  })
})

describe('sanitizeTitle', () => {
  it('quita controles, ESC, saltos y marcas bidireccionales', () => {
    expect(sanitizeTitle('a\x1b[31mb\x07\n\r\tc‮d e\x7f\x9bf')).toBe('a[31mbcdef')
  })

  it('devuelve null si queda vacío', () => {
    expect(sanitizeTitle('')).toBeNull()
    expect(sanitizeTitle('\x00\x01 \n')).toBeNull()
  })

  it('recorta a 256 sin partir un par sustituto', () => {
    const t = sanitizeTitle(`${'a'.repeat(255)}😀`)
    expect(t).toBe('a'.repeat(255))
    expect(sanitizeTitle('b'.repeat(1000))?.length).toBe(LIMITS.maxTitleLength)
  })

  it('propiedad: el resultado siempre es un DisplayText válido o null', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 600 }), (s) => {
        const t = sanitizeTitle(s)
        if (t !== null) expect(DisplayText.safeParse(t).success).toBe(true)
      }),
    )
  })
})

describe('OscTitleParser', () => {
  const parse = (...chunks: string[]) => {
    const p = new OscTitleParser()
    return chunks.flatMap((c) => p.feed(c))
  }

  it('extrae OSC 0 y OSC 2 con BEL o ESC \\', () => {
    expect(parse('\x1b]0;uno\x07')).toEqual(['uno'])
    expect(parse('\x1b]2;dos\x1b\\')).toEqual(['dos'])
    expect(parse('x\x1b]2;a\x07y\x1b]0;b\x07z')).toEqual(['a', 'b'])
  })

  it('ignora otros OSC (p. ej. 1 icono, 8 hipervínculos, 52 portapapeles)', () => {
    expect(parse('\x1b]1;icono\x07\x1b]8;;http://x\x07\x1b]52;c;QQ==\x07')).toEqual([])
  })

  it('funciona con la secuencia partida en cualquier punto', () => {
    const seq = 'hola\x1b]0;mi título\x07fin'
    for (let i = 1; i < seq.length; i++) {
      expect(parse(seq.slice(0, i), seq.slice(i))).toEqual(['mi título'])
    }
  })

  it('una secuencia incompleta no emite nada y se descarta si llega otra cosa', () => {
    expect(parse('\x1b]0;sin fin')).toEqual([])
    expect(parse('\x1b]0;abortada\x1bXresto \x1b]0;ok\x07')).toEqual(['ok'])
    expect(parse('\x1b]0;cancelada\x18\x1b]0;ok\x07')).toEqual(['ok'])
  })

  it('un nuevo OSC reinicia a uno incompleto', () => {
    expect(parse('\x1b]0;a\x1b]0;b\x07')).toEqual(['b'])
  })

  it('una carga enorme se descarta hasta el terminador y luego sigue funcionando', () => {
    const huge = `\x1b]0;${'a'.repeat(MAX_OSC_PAYLOAD + 10)}\x07`
    expect(parse(huge, '\x1b]0;después\x07')).toEqual(['después'])
  })

  it('sanea el título y descarta los vacíos', () => {
    expect(parse('\x1b]0;\x01\x02\x07')).toEqual([])
    expect(parse('\x1b]0;x\x1b[1my\x07')).toEqual([])
  })
})
