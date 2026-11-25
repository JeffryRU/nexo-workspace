import { type Layout, LayoutSchema, LIMITS, PaneId } from '@nexo/contracts'
import { arbHostileString } from '@nexo/testkit'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  close,
  focusNeighbor,
  LayoutError,
  leaf,
  leaves,
  resize,
  resizeBoundary,
  split,
  swap,
} from './layout.ts'

const id = (s: string) => PaneId.parse(s)

function deepChain(splits: number, direction: 'row' | 'column' = 'row'): Layout {
  // Cada división anida la anterior como primer hijo: profundidad = splits.
  let tree: Layout = leaf(id('p0'))
  for (let i = 1; i <= splits; i++) {
    tree = { type: 'split', direction, children: [tree, leaf(id(`p${i}`))], ratios: [0.5, 0.5] }
    direction = direction === 'row' ? 'column' : 'row'
  }
  return tree
}

describe('adversarial: cerrar y ids inexistentes', () => {
  it('cerrar el último panel devuelve null y cerrarlo de nuevo falla', () => {
    expect(close(leaf(id('a')), id('a'))).toBeNull()
    expect(() => close(leaf(id('a')), id('b'))).toThrow(LayoutError)
  })

  it('ids inexistentes en todas las operaciones lanzan LayoutError NOT_FOUND', () => {
    const l = split(leaf(id('a')), id('a'), 'row', id('b'))
    const ghost = id('fantasma')
    const ops = [
      () => split(l, ghost, 'row', id('c')),
      () => close(l, ghost),
      () => resize(l, ghost, 0.1),
      () => swap(l, ghost, id('a')),
      () => focusNeighbor(l, ghost, 'left'),
    ]
    for (const op of ops) {
      try {
        op()
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(LayoutError)
        expect((e as LayoutError).code).toBe('NOT_FOUND')
      }
    }
  })

  it('ids con aspecto hostil no confunden la búsqueda (comparación exacta)', () => {
    fc.assert(
      fc.property(arbHostileString, (s) => {
        const l = split(leaf(id('a')), id('a'), 'row', id('b'))
        const hostile = s as PaneId
        if (s === 'a' || s === 'b') return
        expect(() => close(l, hostile)).toThrow(LayoutError)
        expect(() => focusNeighbor(l, hostile, 'up')).toThrow(LayoutError)
      }),
    )
  })

  it('un id nuevo que ya existe se rechaza con CONFLICT', () => {
    const l = split(leaf(id('a')), id('a'), 'row', id('b'))
    try {
      split(l, id('a'), 'column', id('b'))
      expect.unreachable()
    } catch (e) {
      expect((e as LayoutError).code).toBe('CONFLICT')
    }
  })
})

describe('adversarial: ratios y deltas', () => {
  const l = split(leaf(id('a')), id('a'), 'row', id('b'))

  it('ratios fuera de rango o no numéricos se rechazan con INVALID_PARAMS', () => {
    for (const r of [
      0,
      1,
      -1,
      2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1e-320,
    ]) {
      if (r === 1e-320) {
        // diminuto pero en (0,1): válido; el árbol resultante debe seguir siendo válido
        expect(LayoutSchema.safeParse(split(l, id('a'), 'row', id('c'), r)).success).toBe(true)
        continue
      }
      try {
        split(l, id('a'), 'row', id('c'), r)
        expect.unreachable()
      } catch (e) {
        expect((e as LayoutError).code).toBe('INVALID_PARAMS')
      }
    }
  })

  it('resize con deltas extremos mantiene el árbol válido; NaN lanza', () => {
    for (const delta of [
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MIN_VALUE,
      0,
      -0,
      1e-300,
    ]) {
      const r = resize(l, id('a'), delta)
      expect(LayoutSchema.safeParse(r).success).toBe(true)
    }
    expect(() => resize(l, id('a'), Number.NaN)).toThrow(LayoutError)
  })

  it('cientos de resizes extremos seguidos no degradan las proporciones', () => {
    let t: Layout = l
    for (let i = 0; i < 500; i++) t = resize(t, id(i % 2 ? 'a' : 'b'), i % 3 === 0 ? 1e9 : -1e9)
    expect(LayoutSchema.safeParse(t).success).toBe(true)
  })
})

describe('adversarial: árboles profundos', () => {
  it('1000 divisiones encadenadas con split sin desbordar la pila', () => {
    let t: Layout = leaf(id('p0'))
    let target = id('p0')
    for (let i = 1; i <= 1000; i++) {
      const next = id(`p${i}`)
      t = split(t, target, i % 2 ? 'row' : 'column', next)
      target = next
    }
    expect(leaves(t)).toHaveLength(1001)
    expect(LayoutSchema.safeParse(t).success).toBe(true)
  })

  it('close, resize, swap y focusNeighbor funcionan sobre 1000 niveles', () => {
    const t = deepChain(1000)
    expect(LayoutSchema.safeParse(t).success).toBe(true)
    const ids = leaves(t)
    expect(ids).toHaveLength(1001)
    const deepest = id('p0')
    expect(LayoutSchema.safeParse(resize(t, deepest, 0.1)).success).toBe(true)
    expect(LayoutSchema.safeParse(swap(t, deepest, id('p1000'))).success).toBe(true)
    expect(focusNeighbor(t, deepest, 'right')).not.toBeUndefined()
    let rest: Layout | null = t
    for (let i = 0; i < 1000 && rest !== null; i++) rest = close(rest, id(`p${i}`))
    expect(rest).toEqual(leaf(id('p1000')))
  })

  it('se rechaza superar el máximo de paneles por pestaña con CONFLICT', () => {
    let t: Layout = leaf(id('p0'))
    for (let i = 1; i < LIMITS.maxPanesPerTab; i++)
      t = split(t, id(`p${i - 1}`), 'row', id(`p${i}`))
    expect(leaves(t)).toHaveLength(LIMITS.maxPanesPerTab)
    try {
      split(t, id('p0'), 'row', id('extra'))
      expect.unreachable()
    } catch (e) {
      expect((e as LayoutError).code).toBe('CONFLICT')
    }
  })
})

describe('adversarial: resizeBoundary', () => {
  const two = (): Layout => split(leaf(id('a')), id('a'), 'row', id('b'))

  it('caminos vacíos, enormes, negativos y que apuntan a hojas lanzan LayoutError sin alterar el árbol', () => {
    const t = two()
    const before = JSON.stringify(t)
    const bad: [readonly number[], number][] = [
      [[0], 0],
      [[1], 0],
      [[-1], 0],
      [[Number.MAX_SAFE_INTEGER], 0],
      [[0, 0, 0], 0],
      [new Array(100_000).fill(0), 0],
      [[], 1],
      [[], 99],
      [[], -1],
      [[], Number.NaN],
      [[], Number.POSITIVE_INFINITY],
      [[Number.NaN], 0],
    ]
    for (const [path, index] of bad) {
      expect(() => resizeBoundary(t, path, index, 0.1)).toThrow(LayoutError)
    }
    expect(JSON.stringify(t)).toBe(before)
  })

  it('camino vacío en una hoja única: error', () => {
    expect(() => resizeBoundary(leaf(id('a')), [], 0, 0.1)).toThrow(LayoutError)
  })

  it('delta NaN lanza; ±Infinity se acota y deja el árbol válido', () => {
    const t = two()
    expect(() => resizeBoundary(t, [], 0, Number.NaN)).toThrow(LayoutError)
    for (const delta of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, -1e300]) {
      expect(LayoutSchema.safeParse(resizeBoundary(t, [], 0, delta)).success).toBe(true)
    }
  })

  it('un camino calculado antes de cerrar paneles ya no vale: error o árbol válido, nunca estado corrupto', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(3), { maxLength: 6 }), fc.nat(3), (path, index) => {
        const full = split(
          split(leaf(id('a')), id('a'), 'row', id('b')),
          id('b'),
          'column',
          id('c'),
        )
        const t = close(full, id('c'))
        if (t === null) return
        try {
          expect(LayoutSchema.safeParse(resizeBoundary(t, path, index, 0.1)).success).toBe(true)
        } catch (e) {
          expect(e).toBeInstanceOf(LayoutError)
        }
      }),
    )
  })

  it('1000 niveles: mover el divisor más profundo funciona', () => {
    const t = deepChain(1000)
    const path = new Array(999).fill(0)
    expect(LayoutSchema.safeParse(resizeBoundary(t, path, 0, 0.1)).success).toBe(true)
  })
})
