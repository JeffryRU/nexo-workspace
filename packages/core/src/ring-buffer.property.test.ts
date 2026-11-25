import { utf8ByteLength } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { RingBuffer } from './ring-buffer.ts'
import { indexAfterBytes, indexOfSuffixWithin, splitByBytes } from './utf8.ts'

const text = fc.string({ unit: 'grapheme', maxLength: 40 })
const chunks = fc.array(text, { maxLength: 30 })

/** Referencia independiente: el sufijo más largo, por puntos de código, que cabe en `cap` bytes. */
function expectedSuffix(all: string, cap: number): string {
  const points = Array.from(all)
  let bytes = 0
  let start = points.length
  while (start > 0) {
    const size = utf8ByteLength(points[start - 1] as string)
    if (bytes + size > cap) break
    bytes += size
    start--
  }
  return points.slice(start).join('')
}

describe('RingBuffer (propiedades)', () => {
  it('nunca supera su capacidad y read() es el sufijo exacto de lo escrito', () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 64 }), chunks, (cap, parts) => {
        const ring = new RingBuffer(cap)
        let all = ''
        for (const part of parts) {
          ring.write(part)
          all += part
          expect(ring.size).toBeLessThanOrEqual(cap)
        }
        expect(ring.offset).toBe(utf8ByteLength(all))
        const { data, offset } = ring.read()
        expect(offset).toBe(ring.offset)
        expect(all.endsWith(data)).toBe(true)
        expect(utf8ByteLength(data)).toBe(ring.size)
        // Sin partir caracteres puede quedar a menos de 4 bytes de la capacidad.
        expect(data).toBe(expectedSuffix(all, cap))
        expect(ring.startOffset).toBe(offset - utf8ByteLength(data))
      }),
    )
  })

  it('los offsets son monótonos y leer por tramos concatena el sufijo sin huecos ni repetidos', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 64 }),
        chunks,
        fc.array(fc.integer({ min: 4, max: 20 }), { minLength: 1, maxLength: 10 }),
        (cap, parts, steps) => {
          const ring = new RingBuffer(cap)
          let all = ''
          for (const part of parts) {
            ring.write(part)
            all += part
          }
          let from = ring.startOffset
          let joined = ''
          let last = from
          for (const step of steps.concat(1000)) {
            const r = ring.read({ fromOffset: from, maxBytes: step })
            expect(r.truncated).toBe(false)
            expect(r.offset).toBeGreaterThanOrEqual(last)
            joined += r.data
            last = from = r.offset
          }
          expect(joined).toBe(expectedSuffix(all, cap))
          expect(from).toBe(ring.offset)
        },
      ),
    )
  })

  it('con escrituras y lecturas intercaladas el offset nunca retrocede', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(text, fc.nat(200)), { maxLength: 30 }), (ops) => {
        const ring = new RingBuffer(16)
        let previous = 0
        for (const [part, from] of ops) {
          ring.write(part)
          const r = ring.read({ fromOffset: from })
          expect(r.offset).toBeGreaterThanOrEqual(previous)
          previous = r.offset
        }
      }),
    )
  })
})

describe('utf8 (propiedades)', () => {
  it('splitByBytes reconstruye el texto y respeta el máximo', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 200 }),
        fc.integer({ min: 4, max: 32 }),
        (s, max) => {
          const pieces = splitByBytes(s, max)
          expect(pieces.join('')).toBe(s)
          for (const p of pieces) expect(utf8ByteLength(p)).toBeLessThanOrEqual(max)
        },
      ),
    )
  })

  it('indexOfSuffixWithin e indexAfterBytes caben en el límite aun con sustitutos sueltos', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 100 }), fc.nat(60), (s, max) => {
        expect(utf8ByteLength(s.slice(indexOfSuffixWithin(s, max)))).toBeLessThanOrEqual(max)
        expect(utf8ByteLength(s.slice(0, indexAfterBytes(s, 0, max)))).toBeLessThanOrEqual(max)
      }),
    )
  })
})
