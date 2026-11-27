import { fireEvent, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_KEY } from '../state/settings.ts'
import { mountApp } from '../test-app.tsx'
import { mkTab, mkWorkspace, snapshotOf } from '../test-helpers.ts'

/** `matchMedia` controlable: `set(true)` simula una ventana estrecha y avisa a quien escucha. */
function stubViewport(narrow: boolean) {
  let matches = narrow
  const listeners = new Set<(e: { matches: boolean }) => void>()
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return q.includes('max-width: 759') ? matches : false
    },
    media: q,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  }))
  return {
    set(next: boolean) {
      matches = next
      for (const fn of listeners) fn({ matches })
    },
  }
}

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

const snapshot = () =>
  snapshotOf([mkWorkspace('w1', [mkTab('t1', ['p1']), mkTab('t2', ['p2'])], { name: 'tienda' })])

afterEach(() => vi.unstubAllGlobals())

describe('barra lateral colapsable y cajón', () => {
  it('ancho: el botón colapsa y expande, con aria-expanded, y la preferencia se guarda', async () => {
    stubViewport(false)
    const storage = memoryStorage()
    const app = await mountApp(snapshot(), undefined, { storage })
    const nav = () => screen.queryByRole('navigation', { name: 'Espacios de trabajo' })
    expect(nav()).not.toBeNull()
    const hide = screen.getByRole('button', { name: 'Ocultar espacios' })
    expect(hide.getAttribute('aria-expanded')).toBe('true')
    expect(hide.getAttribute('title')).toBe('Ocultar espacios')
    fireEvent.click(hide)
    expect(nav()).toBeNull()
    expect(app.container.querySelector('.workbench')?.getAttribute('data-sidebar')).toBe('hidden')
    expect(JSON.parse(storage.data.get(SETTINGS_KEY) as string).sidebarCollapsed).toBe(true)
    const show = screen.getByRole('button', { name: 'Mostrar espacios' })
    expect(show.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(show)
    expect(nav()).not.toBeNull()
    expect(app.container.querySelector('.workbench')?.getAttribute('data-sidebar')).toBe('full')
  })

  it('el estado colapsado guardado se respeta al arrancar', async () => {
    stubViewport(false)
    const storage = memoryStorage()
    storage.setItem(SETTINGS_KEY, JSON.stringify({ sidebarCollapsed: true }))
    await mountApp(snapshot(), undefined, { storage })
    expect(screen.queryByRole('navigation', { name: 'Espacios de trabajo' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Mostrar espacios' })).toBeTruthy()
  })

  it('estrecho: la barra es un cajón cerrado; el botón lo abre y Esc lo cierra devolviendo el foco', async () => {
    stubViewport(true)
    const app = await mountApp(snapshot())
    expect(screen.queryByRole('navigation', { name: 'Espacios de trabajo' })).toBeNull()
    expect(app.container.querySelector('.workbench')?.getAttribute('data-sidebar')).toBe('hidden')
    const toggle = screen.getByRole('button', { name: 'Mostrar espacios' })
    toggle.focus()
    fireEvent.click(toggle)
    const drawer = screen.getByRole('dialog', { name: 'Menú de espacios' })
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('navigation', { name: 'Espacios de trabajo' })).toBeTruthy()
    expect(document.activeElement).toBe(drawer)
    expect(
      screen.getByRole('button', { name: 'Ocultar espacios' }).getAttribute('aria-expanded'),
    ).toBe('true')
    fireEvent.keyDown(drawer, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Menú de espacios' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mostrar espacios' }))
  })

  it('estrecho: clic fuera, el botón de cerrar y elegir una pestaña lo cierran', async () => {
    stubViewport(true)
    const app = await mountApp(snapshot())
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Mostrar espacios' }))
    const isOpen = () => screen.queryByRole('dialog', { name: 'Menú de espacios' }) !== null

    open()
    expect(isOpen()).toBe(true)
    fireEvent.pointerDown(screen.getByTestId('drawer-backdrop'))
    expect(isOpen()).toBe(false)

    open()
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar el menú de espacios' }))
    expect(isOpen()).toBe(false)

    open()
    const rows = app.container.querySelectorAll<HTMLButtonElement>('.tab-row')
    expect(rows.length).toBe(2)
    fireEvent.click(rows[1] as HTMLButtonElement)
    expect(isOpen()).toBe(false)
  })

  it('estrecho: Tab queda atrapado dentro del cajón', async () => {
    stubViewport(true)
    await mountApp(snapshot())
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar espacios' }))
    const drawer = screen.getByRole('dialog', { name: 'Menú de espacios' })
    const buttons = drawer.querySelectorAll<HTMLElement>('button')
    const last = buttons[buttons.length - 1] as HTMLElement
    last.focus()
    fireEvent.keyDown(drawer, { key: 'Tab' })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(drawer, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('al ensanchar la ventana con el cajón abierto, el cajón se cierra y vuelve la barra fija', async () => {
    const viewport = stubViewport(true)
    const app = await mountApp(snapshot())
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar espacios' }))
    expect(screen.queryByRole('dialog', { name: 'Menú de espacios' })).not.toBeNull()
    viewport.set(false)
    await Promise.resolve()
    expect(screen.queryByRole('dialog', { name: 'Menú de espacios' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Espacios de trabajo' })).not.toBeNull()
    expect(app.container.querySelector('.workbench')?.getAttribute('data-sidebar')).toBe('full')
  })

  it('el estado colapsado de la ventana ancha no afecta al cajón (estrecho)', async () => {
    stubViewport(true)
    const storage = memoryStorage()
    storage.setItem(SETTINGS_KEY, JSON.stringify({ sidebarCollapsed: true }))
    await mountApp(snapshot(), undefined, { storage })
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar espacios' }))
    expect(screen.queryByRole('navigation', { name: 'Espacios de trabajo' })).not.toBeNull()
  })
})
