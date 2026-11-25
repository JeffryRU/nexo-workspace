import type { Attention } from '@nexo/contracts'
import { fireEvent } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountApp } from '../test-app.tsx'
import { FakeClient, mkTab, mkWorkspace, snapshotOf } from '../test-helpers.ts'
import { FakeNotifier } from './fake-notifier.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

const snapshot = () =>
  snapshotOf(
    [
      mkWorkspace('w1', [mkTab('t1', ['p1', 'p2']), mkTab('t2', ['q1'])], { name: 'Proyecto' }),
      mkWorkspace('w2', [mkTab('t3', ['r1'])], { name: 'Otro' }),
    ],
    4,
  )

let seq = 100
async function mount(notifier?: FakeNotifier) {
  const client = new FakeClient()
  const app = await mountApp(snapshot(), client, notifier === undefined ? {} : { notifier })
  const set = async (paneId: string, attention: Attention) => {
    client.emit('pane.attention', { paneId, attention }, ++seq)
    await tick()
  }
  return { ...app, set }
}

const dot = (root: ParentNode, paneId: string) =>
  root.querySelector(`[data-pane-id="${paneId}"] .attention-dot`)?.getAttribute('data-attention')

afterEach(() => {
  vi.useRealTimers()
  document.title = ''
})

describe('atención visible', () => {
  it('la pestaña y la barra lateral muestran el estado y el contador de pendientes', async () => {
    const { container, set } = await mount()
    await set('q1', 'needs-input')
    const tabs = [...container.querySelectorAll('.tablist .tab-wrap')]
    expect(tabs.map((t) => t.getAttribute('data-attention'))).toEqual(['idle', 'needs-input'])
    expect(tabs[1]?.querySelector('.attention-count')?.textContent).toBe('1')
    expect(tabs[0]?.querySelector('.attention-count')).toBeNull()
    const wsBadges = container.querySelectorAll('.ws-row .attention-count')
    expect(wsBadges).toHaveLength(1)
    expect(container.querySelector('.tab-row .attention-count')?.getAttribute('aria-label')).toBe(
      '1 pendiente(s)',
    )
  })

  it('working se anima con un punto propio y error se distingue', async () => {
    const { container, set } = await mount()
    await set('p1', 'working')
    await set('p2', 'error')
    expect(dot(container, 'p1')).toBe('working')
    expect(dot(container, 'p2')).toBe('error')
    expect(container.querySelector('.tablist .tab-wrap')?.getAttribute('data-attention')).toBe(
      'error',
    )
  })

  it('el done se mantiene hasta enfocar el panel con la ventana a la vista, y vuelve con el siguiente done', async () => {
    const { container, set, model } = await mount()
    model.ui.setWindowFocused(false)
    await set('p2', 'done')
    expect(dot(container, 'p2')).toBe('done')
    // Enfocar el panel con la ventana sin foco no lo da por visto.
    await model.actions.focusPane('p2' as never)
    await tick()
    expect(dot(container, 'p2')).toBe('done')
    // Al volver a la ventana sí.
    model.ui.setWindowFocused(true)
    await tick()
    expect(dot(container, 'p2')).toBe('idle')
    // Otro turno con el panel enfocado y la ventana a la vista: el done se da por visto al instante.
    await set('p2', 'working')
    await set('p2', 'done')
    expect(dot(container, 'p2')).toBe('idle')
    // Si la ventana no está a la vista, el siguiente done sí se vuelve a mostrar.
    model.ui.setWindowFocused(false)
    await set('p2', 'working')
    await set('p2', 'done')
    expect(dot(container, 'p2')).toBe('done')
  })

  it('un done en un panel que no está enfocado no se da por visto', async () => {
    const { container, set, model } = await mount()
    model.ui.setWindowFocused(true)
    await set('p2', 'done')
    expect(dot(container, 'p2')).toBe('done')
    expect(
      container.querySelectorAll('.tablist .tab-wrap')[0]?.getAttribute('data-attention'),
    ).toBe('done')
  })

  it('el título del documento lleva el contador de paneles que necesitan atención', async () => {
    const { set } = await mount()
    expect(document.title).toBe('Nexo Workspace')
    await set('q1', 'needs-input')
    expect(document.title).toBe('(1) Nexo Workspace')
    await set('r1', 'error')
    expect(document.title).toBe('(2) Nexo Workspace')
    await set('q1', 'working')
    await set('r1', 'idle')
    expect(document.title).toBe('Nexo Workspace')
  })
})

describe('atajo al siguiente panel con atención', () => {
  const press = () =>
    fireEvent.keyDown(document.body, { key: 'N', code: 'KeyN', altKey: true, shiftKey: true })

  it('salta a otra pestaña y a otro espacio, empezando por lo más urgente', async () => {
    const { client, set, model } = await mount()
    await set('r1', 'needs-input')
    await set('q1', 'error')
    press()
    await tick()
    expect(model.ui.activeWorkspaceId()).toBe('w2')
    expect(client.callsOf('tab.focus').at(-1)?.params).toEqual({ tabId: 't3' })
    press()
    await tick()
    // Desde r1 (needs-input) sigue q1 (error), en el espacio anterior.
    expect(model.ui.activeWorkspaceId()).toBe('w1')
    expect(client.callsOf('tab.focus').at(-1)?.params).toEqual({ tabId: 't2' })
  })

  it('sin paneles con atención no hace nada', async () => {
    const { client } = await mount()
    press()
    await tick()
    expect(client.callsOf('tab.focus')).toHaveLength(0)
  })

  it('aparece en la ayuda de atajos', async () => {
    const { model } = await mount()
    expect(model.ui.keymap['attention.next']).toEqual(['Alt+Shift+N'])
  })
})

describe('notificaciones', () => {
  it('el interruptor del pie pide permiso, se activa y se persiste en el ajuste', async () => {
    const notifier = new FakeNotifier({ permission: 'default' })
    const { getByText, model } = await mount(notifier)
    fireEvent.click(getByText('Notificaciones desactivadas'))
    await tick()
    expect(notifier.requests).toBe(1)
    expect(getByText('Notificaciones activadas')).toBeTruthy()
    expect(model.settings.notifications()).toBe(true)
    fireEvent.click(getByText('Notificaciones activadas'))
    await tick()
    expect(getByText('Notificaciones desactivadas')).toBeTruthy()
  })

  it('con permiso denegado no se activa y se avisa', async () => {
    const notifier = new FakeNotifier({ permission: 'default' })
    notifier.onRequest = 'denied'
    const { getByText, container } = await mount(notifier)
    fireEvent.click(getByText('Notificaciones desactivadas'))
    await tick()
    expect(getByText('Notificaciones desactivadas')).toBeTruthy()
    expect(container.textContent).toContain('no permitió')
  })

  it('avisa una vez por un cambio a needs-input con la ventana sin foco y el clic lleva al panel', async () => {
    const notifier = new FakeNotifier({ permission: 'granted' })
    const { getByText, set, model, client } = await mount(notifier)
    fireEvent.click(getByText('Notificaciones desactivadas'))
    await tick()
    model.ui.setWindowFocused(false)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    client.emit('pane.attention', { paneId: 'q1', attention: 'working' }, ++seq)
    client.emit('pane.attention', { paneId: 'q1', attention: 'needs-input' }, ++seq)
    expect(notifier.sent).toHaveLength(0)
    vi.advanceTimersByTime(1600)
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]).toMatchObject({ title: 'Necesita tu respuesta' })
    expect(notifier.sent[0]?.body).toBe('Proyecto · Pestaña t2')
    notifier.sent[0]?.click()
    expect(model.ui.activeWorkspaceId()).toBe('w1')
    expect(client.callsOf('tab.focus').at(-1)?.params).toEqual({ tabId: 't2' })
    void set
  })

  it('con la ventana a la vista no avisa', async () => {
    const notifier = new FakeNotifier({ permission: 'granted' })
    const { getByText, model, client } = await mount(notifier)
    fireEvent.click(getByText('Notificaciones desactivadas'))
    await tick()
    model.ui.setWindowFocused(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    client.emit('pane.attention', { paneId: 'q1', attention: 'working' }, ++seq)
    client.emit('pane.attention', { paneId: 'q1', attention: 'needs-input' }, ++seq)
    vi.advanceTimersByTime(60_000)
    expect(notifier.sent).toHaveLength(0)
  })

  it('con el ajuste desactivado no avisa', async () => {
    const notifier = new FakeNotifier({ permission: 'granted' })
    const { model, client } = await mount(notifier)
    model.ui.setWindowFocused(false)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    client.emit('pane.attention', { paneId: 'q1', attention: 'working' }, ++seq)
    client.emit('pane.attention', { paneId: 'q1', attention: 'done' }, ++seq)
    vi.advanceTimersByTime(60_000)
    expect(notifier.sent).toHaveLength(0)
  })
})
