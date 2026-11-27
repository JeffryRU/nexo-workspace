import { fireEvent } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { mountApp } from '../test-app.tsx'
import { mkTab, mkWorkspace, snapshotOf } from '../test-helpers.ts'

const snapshot = (count = 6) =>
  snapshotOf([
    mkWorkspace(
      'w1',
      Array.from({ length: count }, (_, i) => mkTab(`t${i}`, [`p${i}`])),
      { name: 'tienda' },
    ),
  ])

/** jsdom no maqueta: se fingen las medidas de la lista (ancho visible, ancho total y desplazamiento). */
function fakeLayout(list: HTMLElement, m: { client: number; scroll: number; left: number }) {
  Object.defineProperty(list, 'clientWidth', { configurable: true, get: () => m.client })
  Object.defineProperty(list, 'scrollWidth', { configurable: true, get: () => m.scroll })
  Object.defineProperty(list, 'scrollLeft', {
    configurable: true,
    get: () => m.left,
    set: (v: number) => {
      m.left = Math.max(0, Math.min(v, m.scroll - m.client))
    },
  })
}

describe('barra de pestañas: desborde', () => {
  it('la rueda vertical desplaza la lista en horizontal cuando desborda', async () => {
    const { container } = await mountApp(snapshot())
    const list = container.querySelector('.tablist') as HTMLElement
    const m = { client: 300, scroll: 900, left: 0 }
    fakeLayout(list, m)
    const notCancelled = fireEvent.wheel(list, { deltaY: 120 })
    expect(notCancelled).toBe(false)
    expect(m.left).toBe(120)
  })

  it('si no desborda, o la rueda ya es horizontal, no la toca', async () => {
    const { container } = await mountApp(snapshot(1))
    const list = container.querySelector('.tablist') as HTMLElement
    const m = { client: 300, scroll: 300, left: 0 }
    fakeLayout(list, m)
    expect(fireEvent.wheel(list, { deltaY: 120 })).toBe(true)
    expect(m.left).toBe(0)
    m.scroll = 900
    expect(fireEvent.wheel(list, { deltaX: 90, deltaY: 10 })).toBe(true)
    expect(m.left).toBe(0)
  })

  it('un desplazamiento enorme o hostil no rompe nada', async () => {
    const { container } = await mountApp(snapshot())
    const list = container.querySelector('.tablist') as HTMLElement
    const m = { client: 300, scroll: 900, left: 0 }
    fakeLayout(list, m)
    for (const deltaY of [1e12, -1e12, Number.MAX_VALUE, 0.0001]) {
      fireEvent.wheel(list, { deltaY })
    }
    expect(m.left).toBeGreaterThanOrEqual(0)
    expect(m.left).toBeLessThanOrEqual(600)
  })

  it('los fundidos avisan de qué lado hay más pestañas', async () => {
    const { container } = await mountApp(snapshot())
    const frame = container.querySelector('.tablist-frame') as HTMLElement
    const list = frame.querySelector('.tablist') as HTMLElement
    const m = { client: 300, scroll: 900, left: 0 }
    fakeLayout(list, m)
    fireEvent.scroll(list)
    expect(frame.dataset.more).toBe('end')
    m.left = 300
    fireEvent.scroll(list)
    expect(frame.dataset.more).toBe('start end')
    m.left = 600
    fireEvent.scroll(list)
    expect(frame.dataset.more).toBe('start')
    m.scroll = 300
    m.left = 0
    fireEvent.scroll(list)
    expect(frame.dataset.more).toBe('')
  })
})
