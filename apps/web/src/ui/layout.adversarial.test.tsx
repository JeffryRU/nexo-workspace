import { fireEvent, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountApp } from '../test-app.tsx'
import { mkTab, mkWorkspace, snapshotOf } from '../test-helpers.ts'

afterEach(() => vi.unstubAllGlobals())

const LONG = 'x'.repeat(20_000)
const NAMES = [
  LONG,
  '😀👩‍👩‍👧‍👦🏳️‍🌈'.repeat(500),
  'مرحبا بالعالم '.repeat(300),
  '<img src=x onerror=1>',
  '‮oculto‬',
  '',
]

describe('pulido visual (adversarial)', () => {
  it('etiquetas de pestaña y espacio larguísimas, con emojis, RTL o marcado: todo se trunca y los botones siguen ahí', async () => {
    const tabs = NAMES.map((name, i) => mkTab(`t${i}`, [`p${i}`], { title: name }))
    const ws = NAMES.map((name, i) =>
      mkWorkspace(`w${i}`, i === 0 ? tabs : [mkTab(`u${i}`, [`q${i}`])], { name: name || 'vacío' }),
    )
    const app = await mountApp(snapshotOf(ws))
    expect(app.container.querySelectorAll('[role="tab"]').length).toBe(NAMES.length)
    for (const el of app.container.querySelectorAll('.tab .ellipsis')) {
      expect(el.className).toContain('ellipsis')
    }
    expect(app.container.querySelectorAll('img').length).toBe(0)
    expect(screen.getByRole('button', { name: 'Nueva pestaña' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Nueva pestaña de agente' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ocultar espacios' })).toBeTruthy()
    // Los botones de la derecha están fuera del contenedor que se desplaza.
    const list = app.container.querySelector('.tablist')
    for (const b of app.container.querySelectorAll('.tabbar-actions button')) {
      expect(list?.contains(b)).toBe(false)
    }
  })

  it('cientos de pestañas: la barra las monta todas y marca solo una como seleccionada', async () => {
    const tabs = Array.from({ length: 400 }, (_, i) =>
      mkTab(`t${i}`, [`p${i}`], { title: `Pestaña ${i}` }),
    )
    const app = await mountApp(snapshotOf([mkWorkspace('w1', tabs)]))
    expect(app.container.querySelectorAll('[role="tab"]').length).toBe(400)
    expect(app.container.querySelectorAll('[role="tab"][aria-selected="true"]').length).toBe(1)
    expect(app.container.querySelectorAll('.tabbar-actions button').length).toBe(2)
  })

  it('redimensionado rápido: cruzar el umbral cientos de veces deja un estado coherente', async () => {
    let matches = false
    const listeners = new Set<(e: { matches: boolean }) => void>()
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() {
        return q.includes('max-width: 759') ? matches : false
      },
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) =>
        listeners.delete(fn),
    }))
    const app = await mountApp(snapshotOf([mkWorkspace('w1', [mkTab('t1', ['p1'])])]))
    for (let i = 0; i < 301; i++) {
      matches = i % 2 === 0
      for (const fn of listeners) fn({ matches })
      if (matches) fireEvent.click(screen.getByRole('button', { name: /espacios$/ }))
    }
    await Promise.resolve()
    // La última vuelta (i = 300) deja la ventana estrecha: cajón disponible, nada fijo.
    expect(app.container.querySelector('.workbench')?.getAttribute('data-sidebar')).toBe('hidden')
    const drawers = screen.queryAllByRole('dialog', { name: 'Menú de espacios' })
    expect(drawers.length).toBeLessThanOrEqual(1)
    // Y al ensanchar, vuelve la barra fija y no queda ningún cajón.
    matches = false
    for (const fn of listeners) fn({ matches })
    await Promise.resolve()
    expect(screen.queryAllByRole('dialog', { name: 'Menú de espacios' }).length).toBe(0)
    expect(app.container.querySelector('.workbench')?.getAttribute('data-sidebar')).toBe('full')
  })

  it('sin matchMedia (entornos viejos) se comporta como ventana ancha', async () => {
    vi.stubGlobal('matchMedia', undefined)
    const app = await mountApp(snapshotOf([mkWorkspace('w1', [mkTab('t1', ['p1'])])]))
    expect(app.container.querySelector('.workbench')?.getAttribute('data-sidebar')).toBe('full')
  })
})
