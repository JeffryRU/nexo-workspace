import { utf8ByteLength } from '@nexo/contracts'
import { FakeClock } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { OutputBatcher } from './output-batcher.ts'

describe('OutputBatcher (adversarial)', () => {
  it('ráfaga de 50 MB de caracteres de 4 bytes: trozos acotados y sin pérdida', () => {
    const clock = new FakeClock()
    let total = 0
    let max = 0
    let pieces = 0
    const batcher = new OutputBatcher({
      clock,
      emit: (d) => {
        const b = utf8ByteLength(d)
        total += b
        max = Math.max(max, b)
        pieces++
      },
    })
    const unit = '😀'.repeat(16 * 1024)
    const count = Math.ceil((50 * 1024 * 1024) / utf8ByteLength(unit))
    for (let i = 0; i < count; i++) batcher.push(unit)
    batcher.flush()
    expect(total).toBe(count * utf8ByteLength(unit))
    expect(max).toBeLessThanOrEqual(64 * 1024)
    expect(pieces).toBeGreaterThanOrEqual(800)
  })

  it('emisión con maxBytes diminuto no parte caracteres', () => {
    const clock = new FakeClock()
    const out: string[] = []
    const batcher = new OutputBatcher({ clock, emit: (d) => out.push(d), maxBytes: 1 })
    batcher.push('😀é€')
    batcher.flush()
    expect(out.join('')).toBe('😀é€')
    expect(out.every((p) => p.length > 0)).toBe(true)
  })

  it('un emit que lanza no deja el lote en un estado corrupto para el siguiente push', () => {
    const clock = new FakeClock()
    let fail = true
    const out: string[] = []
    const batcher = new OutputBatcher({
      clock,
      emit: (d) => {
        if (fail) throw new Error('boom')
        out.push(d)
      },
    })
    batcher.push('a')
    expect(() => clock.advance(8)).toThrow('boom')
    fail = false
    batcher.push('b')
    clock.advance(8)
    expect(out).toEqual(['b'])
  })

  it('flush y dispose repetidos son inocuos', () => {
    const clock = new FakeClock()
    const batcher = new OutputBatcher({ clock, emit: () => {} })
    batcher.dispose()
    batcher.dispose()
    batcher.flush()
    expect(clock.pending).toBe(0)
  })
})
