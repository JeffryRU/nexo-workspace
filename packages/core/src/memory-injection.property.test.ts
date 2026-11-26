import { arbBlockDocument, arbHostileString, arbProjectMemory } from '@nexo/testkit'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  assertMemoryBlock,
  blocksContextTokens,
  buildMemoryBlock,
  checkPreparedMemory,
  MEMORY_CLOSE_TAG,
  MEMORY_OPEN_TAG,
  recentTurnsFromBlocks,
} from './index.ts'

const text = fc.oneof(fc.string({ unit: 'binary', maxLength: 400 }), arbHostileString)
const turn = fc.record({
  role: fc.constantFrom('usuario' as const, 'agente' as const),
  text,
})
const count = (s: string, needle: string) => s.split(needle).length - 1

describe('buildMemoryBlock con turnos (propiedades)', () => {
  it('cualquier memoria, reflexión y turnos dan un bloque con una apertura y un cierre, o null', () => {
    fc.assert(
      fc.property(
        arbProjectMemory,
        text,
        fc.array(turn, { maxLength: 12 }),
        fc.integer({ min: 200, max: 6000 }),
        (memory, reflection, recentTurns, maxTokens) => {
          const block = buildMemoryBlock(
            {
              ...memory,
              reflection:
                reflection.trim() === ''
                  ? null
                  : {
                      generation: 1,
                      createdAt: 1,
                      coversThroughSeq: 0,
                      text: reflection,
                      sources: [],
                    },
            },
            { recentTurns, maxTokens },
          )
          if (block === null) return
          expect(count(block.text, MEMORY_OPEN_TAG)).toBe(1)
          expect(count(block.text, MEMORY_CLOSE_TAG)).toBe(1)
          expect(() => assertMemoryBlock(block.text)).not.toThrow()
          expect(() => checkPreparedMemory(block.text)).not.toThrow()
          expect(block.turns).toBeLessThanOrEqual(recentTurns.length)
          // el tope manda salvo por el margen del preámbulo y los encabezados
          expect(block.tokens).toBeLessThanOrEqual(maxTokens + 200)
        },
      ),
    )
  })

  it('es determinista: mismas entradas, mismo bloque', () => {
    fc.assert(
      fc.property(arbProjectMemory, fc.array(turn, { maxLength: 6 }), (memory, recentTurns) => {
        expect(buildMemoryBlock(memory, { recentTurns })?.text).toBe(
          buildMemoryBlock(memory, { recentTurns })?.text,
        )
      }),
    )
  })
})

describe('recentTurnsFromBlocks y blocksContextTokens (propiedades)', () => {
  it('los turnos caben en el tope (salvo el primero) y respetan el orden del documento', () => {
    fc.assert(
      fc.property(arbBlockDocument, fc.integer({ min: 0, max: 5000 }), (blocks, max) => {
        const turns = recentTurnsFromBlocks(blocks, max)
        const all = recentTurnsFromBlocks(blocks, Number.MAX_SAFE_INTEGER)
        expect(turns.length).toBeLessThanOrEqual(all.length)
        // son un sufijo de la lista completa
        expect(all.slice(all.length - turns.length)).toEqual(turns)
      }),
    )
  })

  it('el contexto es monótono: contar desde más atrás nunca da menos', () => {
    fc.assert(
      fc.property(
        arbBlockDocument,
        fc.integer({ min: -1, max: 40 }),
        fc.integer({ min: -1, max: 40 }),
        (blocks, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          expect(blocksContextTokens(blocks, lo)).toBeGreaterThanOrEqual(
            blocksContextTokens(blocks, hi),
          )
          expect(blocksContextTokens(blocks, Number.MAX_SAFE_INTEGER)).toBe(0)
        },
      ),
    )
  })
})
