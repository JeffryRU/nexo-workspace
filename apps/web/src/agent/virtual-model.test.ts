import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { VirtualModel } from './virtual-model.ts'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `b${i}`)

describe('VirtualModel', () => {
  it('suma las alturas estimadas y calcula la ventana', () => {
    const m = new VirtualModel(() => 50)
    m.setIds(ids(100))
    expect(m.total).toBe(5000)
    const w = m.window(1000, 300, 0)
    expect(w.start).toBe(20)
    expect(w.end).toBe(27) // 1000..1300 cubre los elementos 20..25 y el 26 que empieza en 1300
    expect(w.padTop).toBe(1000)
    expect(w.padBottom).toBe(5000 - 27 * 50)
    expect(m.slice(w.start, w.end)).toHaveLength(7)
  })

  it('medir cambia el total y devuelve la diferencia; ignora medidas inválidas', () => {
    const m = new VirtualModel(() => 50)
    m.setIds(ids(10))
    expect(m.measure('b3', 120)).toBe(70)
    expect(m.total).toBe(570)
    expect(m.offsetOf(4)).toBe(50 * 3 + 120)
    expect(m.measure('b3', 120.2)).toBe(0)
    expect(m.measure('b3', 0)).toBe(0)
    expect(m.measure('b3', Number.NaN)).toBe(0)
    expect(m.measure('nope', 99)).toBe(0)
    expect(m.heightOf(3)).toBe(120)
  })

  it('al cambiar la lista conserva las medidas de los bloques que siguen', () => {
    const m = new VirtualModel(() => 50)
    m.setIds(ids(5))
    m.measure('b4', 200)
    m.setIds([...ids(5), 'b5'])
    expect(m.total).toBe(50 * 4 + 200 + 50)
    m.setIds(ids(3))
    expect(m.total).toBe(150)
    m.setIds(ids(5))
    expect(m.heightOf(4)).toBe(200)
  })

  it('indexAt acota y la lista vacía no rompe', () => {
    const m = new VirtualModel(() => 10)
    expect(m.window(0, 100, 50)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 })
    m.setIds(ids(3))
    expect(m.indexAt(-5)).toBe(0)
    expect(m.indexAt(9999)).toBe(2)
    expect(m.offsetOf(99)).toBe(30)
    expect(m.indexOf('b2')).toBe(2)
  })

  it('el colchón (overscan) amplía la ventana', () => {
    const m = new VirtualModel(() => 10)
    m.setIds(ids(100))
    const a = m.window(500, 100, 0)
    const b = m.window(500, 100, 200)
    expect(b.start).toBeLessThan(a.start)
    expect(b.end).toBeGreaterThan(a.end)
  })

  it('propiedad: la ventana siempre cubre el tramo visible y las sumas cuadran', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 200 }),
        fc.nat(100_000),
        fc.integer({ min: 1, max: 2000 }),
        (heights, scrollTop, viewport) => {
          const list = ids(heights.length)
          const m = new VirtualModel(() => 40)
          m.setIds(list)
          for (const [i, h] of heights.entries()) m.measure(list[i] as string, h)
          const total = heights.reduce((a, b) => a + b, 0)
          expect(m.total).toBe(total)
          const w = m.window(scrollTop, viewport, 0)
          expect(w.end).toBeGreaterThan(w.start)
          expect(w.padTop + w.padBottom).toBeLessThanOrEqual(total)
          const rendered = m.offsetOf(w.end) - m.offsetOf(w.start)
          expect(w.padTop + rendered + w.padBottom).toBe(total)
          const top = Math.min(scrollTop, total - 1)
          expect(w.padTop).toBeLessThanOrEqual(top)
          const bottom = Math.min(scrollTop + viewport, total)
          expect(w.padTop + rendered).toBeGreaterThanOrEqual(Math.min(bottom, total) - 0.01)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('5000 elementos: ventana, medidas y consultas en pocos milisegundos', () => {
    const m = new VirtualModel(() => 40)
    const list = ids(5000)
    m.setIds(list)
    const t = performance.now()
    for (let i = 0; i < 2000; i++) {
      m.measure(list[(i * 7) % 5000] as string, 20 + (i % 90))
      m.window((i * 331) % 200_000, 800, 600)
    }
    expect(performance.now() - t).toBeLessThan(1500)
  })
})
