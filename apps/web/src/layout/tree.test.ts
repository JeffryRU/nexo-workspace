import { describe, expect, it } from 'vitest'
import { leaf, pid, split } from '../test-helpers.ts'
import {
  aggregateAttention,
  dividerAddress,
  dividerPercent,
  dividersOf,
  isRow,
  neighborPane,
  paneIdsOf,
  paneRects,
} from './tree.ts'

// +-----+-----+
// |  a  |  b  |
// |     +-----+
// |     |  c  |
// +-----+-----+
const grid = split('row', leaf('a'), split('column', leaf('b'), leaf('c')))

describe('paneIdsOf y paneRects', () => {
  it('lista los paneles en orden de lectura', () => {
    expect(paneIdsOf(grid)).toEqual(['a', 'b', 'c'])
    expect(paneIdsOf(null)).toEqual([])
  })

  it('calcula los rectángulos según las proporciones', () => {
    const r = paneRects(grid)
    expect(r.get(pid('a'))).toEqual({ x: 0, y: 0, w: 0.5, h: 1 })
    expect(r.get(pid('c'))).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    expect(paneRects(null).size).toBe(0)
  })
})

describe('neighborPane', () => {
  it('encuentra el vecino en cada dirección', () => {
    expect(neighborPane(grid, pid('a'), 'right')).toBe('b')
    expect(neighborPane(grid, pid('b'), 'left')).toBe('a')
    expect(neighborPane(grid, pid('b'), 'down')).toBe('c')
    expect(neighborPane(grid, pid('c'), 'up')).toBe('b')
  })

  it('devuelve undefined si no hay vecino o el panel no existe', () => {
    expect(neighborPane(grid, pid('a'), 'left')).toBeUndefined()
    expect(neighborPane(grid, pid('a'), 'up')).toBeUndefined()
    expect(neighborPane(grid, pid('x'), 'right')).toBeUndefined()
    expect(neighborPane(null, pid('a'), 'right')).toBeUndefined()
  })

  it('desde un panel alto elige el vecino con más solape', () => {
    const l = split('row', leaf('a'), split('column', leaf('b'), leaf('c')))
    if (l.type !== 'split') throw new Error('x')
    const skewed = {
      ...l,
      children: [leaf('a'), { ...(l.children[1] as typeof l), ratios: [0.8, 0.2] }],
    }
    expect(neighborPane(skewed, pid('a'), 'right')).toBe('b')
  })
})

describe('divisores', () => {
  const grid = split(
    'row',
    split('column', leaf('a'), leaf('b')),
    split('column', leaf('c'), leaf('d')),
  )

  it('una cuadrícula 2x2 tiene tres divisores, incluido el central entre subárboles', () => {
    expect(dividersOf(grid)).toEqual([
      { path: [], index: 0 },
      { path: [0], index: 0 },
      { path: [1], index: 0 },
    ])
  })

  it('subárboles anidados: cada divisor lleva el camino de su split', () => {
    const nested = split(
      'row',
      leaf('x'),
      split('column', leaf('y'), split('row', leaf('z'), leaf('w'))),
    )
    expect(dividersOf(nested).map((d) => d.path)).toEqual([[], [1], [1, 1]])
    expect(dividersOf(null)).toEqual([])
    expect(dividersOf(leaf('solo'))).toEqual([])
  })

  it('dividerAddress copia el camino y rechaza los que pasan del límite', () => {
    const path = [0, 1]
    const addr = dividerAddress(path, 2)
    expect(addr).toEqual({ path: [0, 1], index: 2 })
    expect(addr?.path).not.toBe(path)
    expect(dividerAddress(new Array(64).fill(0), 0)).toBeDefined()
    expect(dividerAddress(new Array(65).fill(0), 0)).toBeUndefined()
    expect(dividerAddress([], -1)).toBeUndefined()
  })

  it('dividerPercent acumula los hijos hasta el divisor', () => {
    expect(dividerPercent([0.5, 0.5], 0)).toBe(50)
    expect(dividerPercent([0.2, 0.3, 0.5], 0)).toBe(20)
    expect(dividerPercent([0.2, 0.3, 0.5], 1)).toBe(50)
  })
})

describe('aggregateAttention', () => {
  it('elige la más urgente', () => {
    expect(aggregateAttention([])).toBe('idle')
    expect(aggregateAttention([{ attention: 'done' }, { attention: 'working' }])).toBe('working')
    expect(aggregateAttention([{ attention: 'needs-input' }, { attention: 'error' }])).toBe('error')
    expect(aggregateAttention([{ attention: 'idle' }, { attention: 'done' }])).toBe('done')
  })

  it('isRow distingue la dirección', () => {
    expect(isRow('row')).toBe(true)
    expect(isRow('column')).toBe(false)
  })
})
