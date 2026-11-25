import { utf8ByteLength } from '@nexo/contracts'
import { FakeClock } from '@nexo/testkit'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { OutputBatcher } from './output-batcher.ts'

function setup(options: { flushMs?: number; maxBytes?: number } = {}) {
  const clock = new FakeClock()
  const out: string[] = []
  const batcher = new OutputBatcher({ clock, emit: (d) => out.push(d), ...options })
  return { clock, out, batcher }
}

describe('OutputBatcher', () => {
  it('agrupa lo que llega en 8 ms en una sola emisión', () => {
    const { clock, out, batcher } = setup()
    batcher.push('a')
    clock.advance(3)
    batcher.push('b')
    clock.advance(4)
    expect(out).toEqual([])
    clock.advance(1)
    expect(out).toEqual(['ab'])
    expect(clock.pending).toBe(0)
  })

  it('emite al llegar a 64 KiB sin esperar al temporizador', () => {
    const { clock, out, batcher } = setup()
    batcher.push('x'.repeat(64 * 1024))
    expect(out).toHaveLength(1)
    expect(out[0]?.length).toBe(64 * 1024)
    expect(clock.pending).toBe(0)
    expect(batcher.pendingBytes).toBe(0)
  })

  it('una ráfaga grande se parte en trozos de 64 KiB y el resto espera', () => {
    const { clock, out, batcher } = setup()
    batcher.push('x'.repeat(64 * 1024 * 2 + 10))
    expect(out.map((d) => d.length)).toEqual([65536, 65536])
    expect(batcher.pendingBytes).toBe(10)
    clock.advance(8)
    expect(out.map((d) => d.length)).toEqual([65536, 65536, 10])
  })

  it('el temporizador empieza con el primer dato pendiente, no con cada push', () => {
    const { clock, out, batcher } = setup({ flushMs: 8 })
    batcher.push('a')
    clock.advance(7)
    batcher.push('b')
    clock.advance(1)
    expect(out).toEqual(['ab'])
    batcher.push('c')
    clock.advance(8)
    expect(out).toEqual(['ab', 'c'])
  })

  it('flush vacía lo pendiente y cancela el temporizador', () => {
    const { clock, out, batcher } = setup()
    batcher.push('a')
    batcher.flush()
    expect(out).toEqual(['a'])
    expect(clock.pending).toBe(0)
    batcher.flush()
    expect(out).toEqual(['a'])
  })

  it('dispose descarta lo pendiente y no emite más', () => {
    const { clock, out, batcher } = setup()
    batcher.push('a')
    batcher.dispose()
    batcher.push('b')
    clock.advance(100)
    batcher.flush()
    expect(out).toEqual([])
  })

  it('ignora datos vacíos', () => {
    const { clock, out, batcher } = setup()
    batcher.push('')
    expect(clock.pending).toBe(0)
    expect(out).toEqual([])
  })

  it('propiedad: lo emitido concatenado es lo empujado, en orden, y cada trozo cabe en el máximo', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: 'grapheme', maxLength: 30 }), { maxLength: 40 }),
        fc.integer({ min: 4, max: 40 }),
        fc.array(fc.nat(10), { maxLength: 40 }),
        (parts, maxBytes, waits) => {
          const { clock, out, batcher } = setup({ maxBytes })
          parts.forEach((p, i) => {
            batcher.push(p)
            clock.advance(waits[i] ?? 0)
          })
          batcher.flush()
          expect(out.join('')).toBe(parts.join(''))
          for (const piece of out) expect(utf8ByteLength(piece)).toBeLessThanOrEqual(maxBytes)
        },
      ),
    )
  })
})
