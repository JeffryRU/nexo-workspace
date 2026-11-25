import { describe, expect, it } from 'vitest'
import { leaf, pid, split } from '../test-helpers.ts'
import {
  aggregateAttention,
  dividerTarget,
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

describe('dividerTarget', () => {
  it('usa la hoja izquierda con signo positivo', () => {
    expect(dividerTarget([leaf('a'), leaf('b'), leaf('c')], 0)).toEqual({ paneId: 'a', sign: 1 })
  })

  it('usa la última hoja con signo negativo si la izquierda es un subárbol', () => {
    const sub = split('column', leaf('x'), leaf('y'))
    expect(dividerTarget([sub, leaf('z')], 0)).toEqual({ paneId: 'z', sign: -1 })
  })

  it('no hay forma de mover un divisor entre dos subárboles', () => {
    const a = split('column', leaf('x'), leaf('y'))
    const b = split('column', leaf('u'), leaf('v'))
    expect(dividerTarget([a, b], 0)).toBeUndefined()
    expect(dividerTarget([a, leaf('m'), leaf('n')], 0)).toBeUndefined()
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
