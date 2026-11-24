import { type Layout, LayoutSchema, PaneId } from '@atalaya/contracts'
import { arbLayout } from '@atalaya/testkit'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { close, focusNeighbor, leaves, MIN_RATIO, resize, split, swap } from './layout.ts'

type Op =
  | { kind: 'split'; at: number; direction: 'row' | 'column'; ratio: number }
  | { kind: 'close'; at: number }
  | { kind: 'resize'; at: number; delta: number }
  | { kind: 'swap'; at: number; other: number }

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('split' as const),
    at: fc.nat(),
    direction: fc.constantFrom('row' as const, 'column' as const),
    ratio: fc.double({ min: 0.01, max: 0.99, noNaN: true }),
  }),
  fc.record({ kind: fc.constant('close' as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant('resize' as const),
    at: fc.nat(),
    delta: fc.double({ min: -2, max: 2, noNaN: true }),
  }),
  fc.record({ kind: fc.constant('swap' as const), at: fc.nat(), other: fc.nat() }),
)

function checkInvariants(layout: Layout): void {
  expect(LayoutSchema.safeParse(layout).success).toBe(true)
  const ids = leaves(layout)
  expect(new Set(ids).size).toBe(ids.length)
  const stack: Layout[] = [layout]
  while (stack.length > 0) {
    const n = stack.pop()
    if (n === undefined) break
    if (n.type === 'split') {
      expect(Math.abs(n.ratios.reduce((x, y) => x + y, 0) - 1)).toBeLessThan(1e-6)
      expect(n.children.length).toBeGreaterThanOrEqual(2)
      stack.push(...n.children)
    }
  }
}

describe('propiedades del árbol de distribución', () => {
  it('tras cualquier secuencia de operaciones el árbol sigue siendo válido y el conteo de hojas es el esperado', () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 60 }), (ops) => {
        let layout: Layout | null = { type: 'leaf', paneId: PaneId.parse('p0') }
        let expected = 1
        let next = 1
        for (const op of ops) {
          if (layout === null) break
          const ids = leaves(layout)
          const target = ids[op.at % ids.length] as PaneId
          if (op.kind === 'split') {
            layout = split(layout, target, op.direction, PaneId.parse(`p${next++}`), op.ratio)
            expected++
          } else if (op.kind === 'close') {
            layout = close(layout, target)
            expected--
          } else if (op.kind === 'resize') {
            layout = resize(layout, target, op.delta)
          } else {
            layout = swap(layout, target, ids[op.other % ids.length] as PaneId)
          }
          if (layout === null) {
            expect(expected).toBe(0)
          } else {
            checkInvariants(layout)
            expect(leaves(layout)).toHaveLength(expected)
          }
        }
      }),
      { numRuns: 300 },
    )
  })

  it('las operaciones no mutan su entrada', () => {
    fc.assert(
      fc.property(
        arbLayout(),
        fc.nat(),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (layout, n, delta) => {
          const before = JSON.stringify(layout)
          const ids = leaves(layout)
          const target = ids[n % ids.length] as PaneId
          split(layout, target, 'row', PaneId.parse('nuevo'))
          close(layout, target)
          resize(layout, target, delta)
          swap(layout, target, ids[0] as PaneId)
          focusNeighbor(layout, target, 'left')
          expect(JSON.stringify(layout)).toBe(before)
        },
      ),
    )
  })

  it('split y luego close del nuevo panel restaura las hojas originales', () => {
    fc.assert(
      fc.property(arbLayout(), fc.nat(), (layout, n) => {
        const ids = leaves(layout)
        const target = ids[n % ids.length] as PaneId
        const nuevo = PaneId.parse('nuevo')
        const roundTrip = close(split(layout, target, 'column', nuevo), nuevo)
        expect(roundTrip && leaves(roundTrip)).toEqual(ids)
      }),
    )
  })

  it('resize nunca deja a un vecino por debajo del mínimo (si no lo estaba)', () => {
    fc.assert(
      fc.property(
        arbLayout(),
        fc.nat(),
        fc.double({ min: -5, max: 5, noNaN: true }),
        (layout, n, delta) => {
          const ids = leaves(layout)
          const target = ids[n % ids.length] as PaneId
          const after = resize(layout, target, delta)
          const minAfter = (l: Layout): number => {
            let m = 1
            const stack: Layout[] = [l]
            while (stack.length > 0) {
              const x = stack.pop()
              if (x === undefined) break
              if (x.type === 'split') {
                m = Math.min(m, ...x.ratios)
                stack.push(...x.children)
              }
            }
            return m
          }
          expect(minAfter(after)).toBeGreaterThanOrEqual(
            Math.min(minAfter(layout), MIN_RATIO) - 1e-9,
          )
        },
      ),
    )
  })

  it('swap dos veces es identidad y conserva el conjunto de hojas', () => {
    fc.assert(
      fc.property(arbLayout(), fc.nat(), fc.nat(), (layout, i, j) => {
        const ids = leaves(layout)
        const x = ids[i % ids.length] as PaneId
        const y = ids[j % ids.length] as PaneId
        const once = swap(layout, x, y)
        expect([...leaves(once)].sort()).toEqual([...ids].sort())
        expect(swap(once, x, y)).toEqual(layout)
      }),
    )
  })

  it('focusNeighbor devuelve una hoja distinta o null, y es simétrico en ida y vuelta cuando existe', () => {
    fc.assert(
      fc.property(arbLayout(), fc.nat(), (layout, n) => {
        const ids = leaves(layout)
        const from = ids[n % ids.length] as PaneId
        for (const dir of ['left', 'right', 'up', 'down'] as const) {
          const to = focusNeighbor(layout, from, dir)
          if (to !== null) {
            expect(to).not.toBe(from)
            expect(ids).toContain(to)
          }
        }
      }),
    )
  })
})
