import { LIMITS, type ProviderEvent, utf8ByteLength } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { HistoryAssembler } from './history-assemble.ts'

const textStart = (ref: string): ProviderEvent => ({
  type: 'block-start',
  ref,
  block: { type: 'text', text: '', complete: false },
})

const textOf = (b: { block: unknown } | undefined): string =>
  (b as { block: { text: string } }).block.text

describe('HistoryAssembler', () => {
  it('arma texto por deltas y una acción con salida, en orden y con su turno', () => {
    const a = new HistoryAssembler({ maxBlocks: 100 })
    a.startTurn()
    a.add({ type: 'user', text: 'hola' })
    a.push(textStart('t'))
    a.push({ type: 'block-delta', ref: 't', field: 'text', text: 'ho' })
    a.push({ type: 'block-delta', ref: 't', field: 'text', text: 'la' })
    a.push({ type: 'block-end', ref: 't' })
    a.push({
      type: 'block-start',
      ref: 'x',
      block: { type: 'action', kind: 'exec', status: 'running', tool: 'Bash', title: 'ls' },
    })
    a.push({ type: 'block-delta', ref: 'x', field: 'output', text: 'a\nb' })
    a.push({
      type: 'block-end',
      ref: 'x',
      block: {
        type: 'action',
        kind: 'exec',
        status: 'ok',
        tool: 'Bash',
        title: 'ls',
        output: 'a\nb',
      },
    })
    const blocks = a.blocks()
    expect(blocks.map((b) => b.block.type)).toEqual(['user', 'text', 'action'])
    expect(blocks.every((b) => b.turn === 1)).toBe(true)
    expect(textOf(blocks[1])).toBe('hola')
  })

  it('ignora eventos con ref desconocida y repetidos', () => {
    const a = new HistoryAssembler({ maxBlocks: 10 })
    a.push({ type: 'block-delta', ref: 'nada', field: 'text', text: 'x' })
    a.push({ type: 'block-end', ref: 'nada' })
    a.push({ type: 'block-update', ref: 'nada', block: { type: 'user', text: 'x' } })
    a.push(textStart('r'))
    a.push(textStart('r'))
    expect(a.ignored).toBe(4)
    expect(a.blocks()).toHaveLength(1)
  })

  it('corta en el tope de bloques y lo marca', () => {
    const a = new HistoryAssembler({ maxBlocks: 3 })
    for (let i = 0; i < 10; i++) a.add({ type: 'user', text: `m${i}` })
    expect(a.blocks()).toHaveLength(3)
    expect(a.truncated).toBe(true)
    expect(a.full).toBe(true)
  })

  it('recorta un texto enorme al tope de un bloque', () => {
    const a = new HistoryAssembler({ maxBlocks: 3 })
    a.push(textStart('r'))
    for (let i = 0; i < 6; i++) {
      a.push({
        type: 'block-delta',
        ref: 'r',
        field: 'text',
        text: 'é'.repeat(LIMITS.maxDeltaBytes / 2),
      })
    }
    const text = textOf(a.blocks()[0])
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(LIMITS.maxBlockTextBytes)
    expect(a.truncated).toBe(true)
  })

  it('un delta con NUL o sustitutos sueltos sale limpio', () => {
    const a = new HistoryAssembler({ maxBlocks: 3 })
    a.push(textStart('r'))
    a.push({ type: 'block-delta', ref: 'r', field: 'text', text: 'a\u0000b\ud800c' })
    expect(textOf(a.blocks()[0])).toBe('a�b�c')
  })

  it('propiedad: nunca produce más bloques que el tope ni lanza con eventos arbitrarios', () => {
    const ev: fc.Arbitrary<ProviderEvent> = fc.oneof(
      fc.record({
        type: fc.constant('block-start' as const),
        ref: fc.constantFrom('a', 'b', 'c'),
        block: fc.constant({ type: 'text' as const, text: '', complete: false }),
      }),
      fc.record({
        type: fc.constant('block-delta' as const),
        ref: fc.constantFrom('a', 'b', 'c', 'z'),
        field: fc.constantFrom('text' as const, 'output' as const),
        text: fc.string({ minLength: 1, maxLength: 20 }),
      }),
      fc.record({ type: fc.constant('block-end' as const), ref: fc.constantFrom('a', 'b', 'z') }),
    )
    fc.assert(
      fc.property(
        fc.array(ev, { maxLength: 80 }),
        fc.integer({ min: 0, max: 5 }),
        (events, max) => {
          const a = new HistoryAssembler({ maxBlocks: max })
          for (const e of events) a.push(e)
          expect(a.blocks().length).toBeLessThanOrEqual(max)
        },
      ),
      { numRuns: 200 },
    )
  })
})
