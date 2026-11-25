import { type Layout, LayoutSchema, PaneId } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import {
  close,
  focusNeighbor,
  LayoutError,
  leaf,
  leaves,
  MIN_RATIO,
  nodeAt,
  pathOf,
  resize,
  resizeBoundary,
  split,
  swap,
} from './layout.ts'

const id = (s: string) => PaneId.parse(s)
const a = id('a')
const b = id('b')
const c = id('c')
const d = id('d')

const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0)

function expectValid(layout: Layout | null): asserts layout is Layout {
  expect(layout).not.toBeNull()
  expect(LayoutSchema.safeParse(layout).success).toBe(true)
}

describe('split', () => {
  it('divide una hoja en dos con la proporción pedida', () => {
    const l = split(leaf(a), a, 'row', b, 0.25)
    expect(l).toEqual({
      type: 'split',
      direction: 'row',
      children: [leaf(a), leaf(b)],
      ratios: [0.75, 0.25],
    })
  })

  it('usa 0.5 por omisión', () => {
    const l = split(leaf(a), a, 'column', b)
    expect(l.type === 'split' && l.ratios).toEqual([0.5, 0.5])
  })

  it('en la misma dirección inserta como hermano y reparte el espacio del original', () => {
    const l = split(split(leaf(a), a, 'row', b), a, 'row', c)
    expect(l.type).toBe('split')
    if (l.type !== 'split') return
    expect(l.children).toEqual([leaf(a), leaf(c), leaf(b)])
    expect(l.ratios[0]).toBeCloseTo(0.25)
    expect(l.ratios[1]).toBeCloseTo(0.25)
    expect(l.ratios[2]).toBeCloseTo(0.5)
    expectValid(l)
  })

  it('en otra dirección anida', () => {
    const l = split(split(leaf(a), a, 'row', b), a, 'column', c)
    expect(l.type === 'split' && l.children[0]?.type).toBe('split')
    expect(leaves(l)).toEqual([a, c, b])
    expectValid(l)
  })

  it('no muta la entrada', () => {
    const original = split(leaf(a), a, 'row', b)
    const snapshot = JSON.stringify(original)
    split(original, b, 'column', c)
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('errores: panel inexistente, id repetido, ratio inválido', () => {
    const l = split(leaf(a), a, 'row', b)
    expect(() => split(l, c, 'row', d)).toThrow(LayoutError)
    expect(() => split(l, a, 'row', b)).toThrow(/ya existe/)
    for (const r of [0, 1, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => split(l, a, 'row', c, r)).toThrow(LayoutError)
    }
    try {
      split(l, c, 'row', d)
    } catch (e) {
      expect((e as LayoutError).code).toBe('NOT_FOUND')
    }
  })
})

describe('close', () => {
  it('colapsa el nodo con un solo hijo y deja la hoja', () => {
    const l = split(leaf(a), a, 'row', b)
    expect(close(l, b)).toEqual(leaf(a))
    expect(close(l, a)).toEqual(leaf(b))
  })

  it('el último panel devuelve null', () => {
    expect(close(leaf(a), a)).toBeNull()
  })

  it('renormaliza las proporciones restantes', () => {
    let l = split(leaf(a), a, 'row', b, 0.5)
    l = split(l, b, 'row', c, 0.5)
    const closed = close(l, a)
    expectValid(closed)
    expect(closed.type === 'split' && sum(closed.ratios)).toBeCloseTo(1, 12)
    expect(leaves(closed)).toEqual([b, c])
  })

  it('colapsa en profundidad y mantiene el resto del árbol', () => {
    let l = split(leaf(a), a, 'row', b)
    l = split(l, b, 'column', c)
    const closed = close(l, c)
    expectValid(closed)
    expect(closed).toEqual(split(leaf(a), a, 'row', b))
  })

  it('panel inexistente lanza NOT_FOUND', () => {
    expect(() => close(leaf(a), b)).toThrow(LayoutError)
  })
})

describe('resize', () => {
  const base = split(leaf(a), a, 'row', b)

  it('agranda el panel a costa del vecino', () => {
    const l = resize(base, a, 0.2)
    expect(l.type === 'split' && l.ratios[0]).toBeCloseTo(0.7)
    expect(l.type === 'split' && l.ratios[1]).toBeCloseTo(0.3)
    expectValid(l)
  })

  it('un delta negativo reduce; el último hijo usa el vecino anterior', () => {
    const l = resize(base, b, -0.1)
    expect(l.type === 'split' && l.ratios[1]).toBeCloseTo(0.4)
    expect(l.type === 'split' && l.ratios[0]).toBeCloseTo(0.6)
  })

  it('respeta el mínimo por panel con deltas extremos', () => {
    const grown = resize(base, a, 1e12)
    expect(grown.type === 'split' && grown.ratios[1]).toBeCloseTo(MIN_RATIO)
    const shrunk = resize(base, a, Number.NEGATIVE_INFINITY)
    expect(shrunk.type === 'split' && shrunk.ratios[0]).toBeCloseTo(MIN_RATIO)
    const inf = resize(base, a, Number.POSITIVE_INFINITY)
    expectValid(inf)
  })

  it('NaN es un error y no cambia nada', () => {
    expect(() => resize(base, a, Number.NaN)).toThrow(LayoutError)
  })

  it('acepta un camino; la raíz y un panel único no cambian', () => {
    const viaPath = resize(base, [0], 0.1)
    expect(viaPath.type === 'split' && viaPath.ratios[0]).toBeCloseTo(0.6)
    expect(resize(base, [], 0.1)).toBe(base)
    expect(resize(leaf(a), a, 0.1)).toEqual(leaf(a))
    expect(() => resize(base, [5], 0.1)).toThrow(LayoutError)
    expect(() => resize(base, [0, 0], 0.1)).toThrow(LayoutError)
    expect(() => resize(base, c, 0.1)).toThrow(LayoutError)
  })

  it('un panel que ya está bajo el mínimo no se reduce más, pero sí puede crecer', () => {
    const l = split(leaf(a), a, 'row', b, 0.99)
    const shrunk = resize(l, a, -1)
    expect(shrunk.type === 'split' && shrunk.ratios[0]).toBeCloseTo(0.01)
    const grown = resize(l, a, 1)
    expect(grown.type === 'split' && grown.ratios[0]).toBeCloseTo(1 - MIN_RATIO)
  })
})

describe('swap', () => {
  it('intercambia posiciones', () => {
    let l = split(leaf(a), a, 'row', b)
    l = split(l, b, 'column', c)
    expect(leaves(l)).toEqual([a, b, c])
    const s = swap(l, a, c)
    expect(leaves(s)).toEqual([c, b, a])
    expectValid(s)
  })

  it('el mismo panel es identidad; inexistente lanza', () => {
    const l = split(leaf(a), a, 'row', b)
    expect(swap(l, a, a)).toBe(l)
    expect(() => swap(l, a, c)).toThrow(LayoutError)
    expect(() => swap(l, c, a)).toThrow(LayoutError)
  })
})

describe('focusNeighbor', () => {
  // +---+---+
  // | a | b |
  // |   +---+
  // |   | c |
  // +---+---+
  const l = split(split(leaf(a), a, 'row', b), b, 'column', c)

  it('se mueve en las cuatro direcciones', () => {
    expect(focusNeighbor(l, a, 'right')).toBe(b)
    expect(focusNeighbor(l, b, 'left')).toBe(a)
    expect(focusNeighbor(l, c, 'left')).toBe(a)
    expect(focusNeighbor(l, b, 'down')).toBe(c)
    expect(focusNeighbor(l, c, 'up')).toBe(b)
  })

  it('devuelve null en el borde y con un solo panel', () => {
    expect(focusNeighbor(l, a, 'left')).toBeNull()
    expect(focusNeighbor(l, a, 'up')).toBeNull()
    expect(focusNeighbor(l, a, 'down')).toBeNull()
    expect(focusNeighbor(l, c, 'right')).toBeNull()
    expect(focusNeighbor(leaf(a), a, 'right')).toBeNull()
  })

  it('elige el vecino con más solapamiento y el más cercano', () => {
    // a ocupa toda la columna izquierda; a la derecha b (arriba, pequeño) y c (abajo, grande)
    const t = split(split(leaf(a), a, 'row', b), b, 'column', c, 0.8)
    expect(focusNeighbor(t, a, 'right')).toBe(c)
    const far = split(split(split(leaf(a), a, 'row', b), b, 'row', c), a, 'column', d)
    expect(focusNeighbor(far, d, 'right')).toBe(b)
  })

  it('panel inexistente lanza', () => {
    expect(() => focusNeighbor(l, d, 'left')).toThrow(LayoutError)
  })
})

describe('utilidades', () => {
  it('pathOf y nodeAt son coherentes', () => {
    const l = split(split(leaf(a), a, 'row', b), b, 'column', c)
    const path = pathOf(l, c)
    expect(path).toEqual([1, 1])
    expect(nodeAt(l, path ?? [])).toEqual(leaf(c))
    expect(pathOf(l, d)).toBeNull()
    expect(() => nodeAt(l, [9])).toThrow(LayoutError)
    expect(() => nodeAt(leaf(a), [0])).toThrow(LayoutError)
  })
})

describe('resizeBoundary', () => {
  const grid = (): Layout => {
    const l = split(split(leaf(a), a, 'row', c), a, 'column', b)
    return split(l, c, 'column', d)
  }

  it('mueve el divisor central de una 2x2 (entre dos subárboles)', () => {
    const g = grid()
    expect(g.type === 'split' && g.children.map((x) => x.type)).toEqual(['split', 'split'])
    const next = resizeBoundary(g, [], 0, 0.1)
    expect(next.type === 'split' && next.ratios[0]).toBeCloseTo(0.6)
    expect(next.type === 'split' && next.ratios[1]).toBeCloseTo(0.4)
    expectValid(next)
  })

  it('delta negativo achica el hijo de la izquierda y no toca la entrada', () => {
    const g = grid()
    const before = JSON.stringify(g)
    const next = resizeBoundary(g, [], 0, -0.2)
    expect(next.type === 'split' && next.ratios[0]).toBeCloseTo(0.3)
    expect(JSON.stringify(g)).toBe(before)
  })

  it('respeta el mínimo por panel', () => {
    const next = resizeBoundary(split(leaf(a), a, 'row', b), [], 0, 5)
    expect(next.type === 'split' && next.ratios[1]).toBeCloseTo(MIN_RATIO)
  })

  it('divisores de subárboles anidados', () => {
    const t = split(split(leaf(a), a, 'row', b), b, 'column', c)
    const next = resizeBoundary(t, [1], 0, 0.2)
    const inner = next.type === 'split' ? next.children[1] : undefined
    expect(inner?.type === 'split' && inner.ratios[0]).toBeCloseTo(0.7)
    expect(next.type === 'split' && next.ratios).toEqual(t.type === 'split' ? t.ratios : [])
  })

  it('camino que no existe, que apunta a una hoja o índice fuera de rango: error', () => {
    const t = split(leaf(a), a, 'row', b)
    expect(() => resizeBoundary(t, [5], 0, 0.1)).toThrow(LayoutError)
    expect(() => resizeBoundary(t, [0], 0, 0.1)).toThrow(LayoutError)
    expect(() => resizeBoundary(t, [], 1, 0.1)).toThrow(LayoutError)
    expect(() => resizeBoundary(t, [], -1, 0.1)).toThrow(LayoutError)
    expect(() => resizeBoundary(t, [], 0.5, 0.1)).toThrow(LayoutError)
  })
})
