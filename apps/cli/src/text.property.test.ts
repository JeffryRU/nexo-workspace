import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isWellFormed } from './test-helpers.ts'
import { AnsiStripper, chunkText, StreamCleaner, sanitize } from './text.ts'

/** Texto con muchos escapes, unicode raro y pares sustitutos. */
const nastyText = fc
  .array(
    fc.oneof(
      fc.string({ unit: 'binary', maxLength: 6 }),
      fc.constantFrom(
        '\u001b[',
        '\u001b]',
        '\u0007',
        '\u001b\\',
        '\u009b',
        '\u009d',
        '🚀',
        '\r\n',
        '\r',
        '€',
      ),
      fc.string({ maxLength: 4 }),
    ),
    { maxLength: 60 },
  )
  .map((parts) => parts.join(''))

describe('propiedades de texto', () => {
  it('sanitize nunca deja caracteres de control', () => {
    fc.assert(
      fc.property(nastyText, (s) => {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: justamente lo que se comprueba
        expect(sanitize(s, 10_000)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
      }),
    )
  })

  it('el limpiador de ANSI nunca emite ESC ni controles C1, sea cual sea el troceado', () => {
    fc.assert(
      fc.property(nastyText, fc.array(fc.nat(20), { maxLength: 8 }), (s, cuts) => {
        const stripper = new AnsiStripper()
        let out = ''
        let at = 0
        for (const cut of cuts) {
          out += stripper.feed(s.slice(at, at + cut))
          at += cut
        }
        out += stripper.feed(s.slice(at))
        // biome-ignore lint/suspicious/noControlCharactersInRegex: justamente lo que se comprueba
        expect(out).not.toMatch(/[\u001b\u007f-\u009f]/)
        // y da lo mismo que procesarlo de una vez
        expect(out).toBe(new AnsiStripper().feed(s))
      }),
    )
  })

  it('StreamCleaner no emite \\r', () => {
    fc.assert(
      fc.property(nastyText, (s) => {
        expect(new StreamCleaner().feed(s)).not.toContain('\r')
      }),
    )
  })

  it('chunkText conserva el texto y respeta el máximo de bytes', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 300 }),
        fc.integer({ min: 4, max: 64 }),
        (s, max) => {
          const chunks = chunkText(s, max)
          expect(chunks.join('')).toBe(s)
          for (const c of chunks) {
            expect(Buffer.byteLength(c)).toBeLessThanOrEqual(max)
            expect(isWellFormed(c)).toBe(true)
          }
        },
      ),
    )
  })
})
