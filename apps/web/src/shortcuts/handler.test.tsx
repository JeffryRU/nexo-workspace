import { describe, expect, it } from 'vitest'
import { mountApp } from '../test-app.tsx'
import { leaf, mkTab, mkWorkspace, snapshotOf, split } from '../test-helpers.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

function press(target: EventTarget, init: KeyboardEventInit) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

const grid = () => {
  const tab = {
    ...mkTab('t1', ['a', 'b', 'c']),
    layout: split('row', leaf('a'), split('column', leaf('b'), leaf('c'))),
  }
  return snapshotOf([mkWorkspace('w1', [tab, mkTab('t2'), mkTab('t3')])])
}

describe('atajos de teclado', () => {
  it('dividir, cerrar y nueva pestaña con el panel enfocado', async () => {
    const { client } = await mountApp(grid())
    press(document.body, { key: 'D', code: 'KeyD', altKey: true, shiftKey: true })
    press(document.body, { key: 'S', code: 'KeyS', altKey: true, shiftKey: true })
    press(document.body, { key: 'W', code: 'KeyW', altKey: true, shiftKey: true })
    press(document.body, { key: 'T', code: 'KeyT', altKey: true, shiftKey: true })
    await tick()
    expect(client.callsOf('pane.split').map((c) => c.params)).toEqual([
      { paneId: 'a', direction: 'row' },
      { paneId: 'a', direction: 'column' },
    ])
    expect(client.callsOf('pane.close')[0]?.params).toEqual({ paneId: 'a' })
    expect(client.callsOf('tab.create')[0]?.params).toEqual({ workspaceId: 'w1' })
  })

  it('Alt+flechas se mueven entre paneles según la geometría', async () => {
    const { client, model } = await mountApp(grid())
    press(document.body, { key: 'ArrowRight', altKey: true })
    await tick()
    expect(model.store.state.workspaces[0]?.tabs[0]?.focusedPaneId).toBe('b')
    press(document.body, { key: 'ArrowDown', altKey: true })
    await tick()
    expect(model.store.state.workspaces[0]?.tabs[0]?.focusedPaneId).toBe('c')
    press(document.body, { key: 'ArrowLeft', altKey: true })
    await tick()
    expect(model.store.state.workspaces[0]?.tabs[0]?.focusedPaneId).toBe('a')
    press(document.body, { key: 'ArrowUp', altKey: true }) // sin vecino
    await tick()
    expect(client.callsOf('pane.focus').map((c) => c.params)).toEqual([
      { paneId: 'b' },
      { paneId: 'c' },
      { paneId: 'a' },
    ])
  })

  it('siguiente, anterior y saltar a la pestaña N', async () => {
    const { client, model } = await mountApp(grid())
    const active = () => model.store.state.workspaces[0]?.activeTabId
    press(document.body, { key: 'PageDown', ctrlKey: true })
    expect(active()).toBe('t2')
    press(document.body, { key: 'PageDown', altKey: true })
    expect(active()).toBe('t3')
    press(document.body, { key: 'PageDown', altKey: true }) // da la vuelta
    expect(active()).toBe('t1')
    press(document.body, { key: 'PageUp', ctrlKey: true })
    expect(active()).toBe('t3')
    press(document.body, { key: '2', code: 'Digit2', altKey: true })
    expect(active()).toBe('t2')
    press(document.body, { key: '9', code: 'Digit9', altKey: true }) // no existe
    expect(active()).toBe('t2')
    await tick()
    expect(client.callsOf('tab.focus').length).toBe(5)
  })

  it('Ctrl+Shift+P abre y cierra la ayuda con la lista de atajos; «?» solo fuera de la terminal', async () => {
    const { container, getByText } = await mountApp(grid())
    press(document.body, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(getByText('Atajos de teclado')).toBeTruthy()
    expect(container.querySelector('kbd')?.textContent).toBe('Alt+Shift+T')
    press(document.body, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    press(document.body, { key: '?', shiftKey: true })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    // «?» dentro de una terminal (o de un campo de texto) es texto normal.
    const host = document.createElement('div')
    host.className = 'xterm'
    document.body.appendChild(host)
    const e = press(host, { key: '?', shiftKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    host.remove()
  })

  it('las combinaciones de la shell (Ctrl+C, Ctrl+D, Ctrl+R…) llegan a la terminal sin tocarse', async () => {
    const { client } = await mountApp(grid())
    const host = document.createElement('div')
    host.className = 'xterm'
    document.body.appendChild(host)
    for (const k of ['c', 'd', 'r', 'z', 'l', 'w', 't']) {
      const e = press(host, { key: k, code: `Key${k.toUpperCase()}`, ctrlKey: true })
      expect(e.defaultPrevented).toBe(false)
    }
    await tick()
    expect(
      client.calls.filter((c) => c.method.startsWith('pane.') || c.method.startsWith('tab.')),
    ).toHaveLength(0)
    host.remove()
  })

  it('Ctrl+Shift+F abre la búsqueda y busca en la terminal enfocada', async () => {
    const { container, xterms } = await mountApp(grid())
    press(document.body, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
    const input = container.querySelector('.searchbar input') as HTMLInputElement
    expect(input).not.toBeNull()
    input.value = 'error'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    )
    const focused = [...xterms.values()].find((x) => x.searches.length > 0)
    expect(focused?.searches).toEqual(['next:error', 'next:error', 'prev:error'])
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(container.querySelector('.searchbar')).toBeNull()
  })

  it('con el foco en un campo de texto, las teclas sueltas no disparan atajos', async () => {
    const { client } = await mountApp(grid())
    const input = document.createElement('input')
    document.body.appendChild(input)
    const e = press(input, { key: '?', shiftKey: true })
    expect(e.defaultPrevented).toBe(false)
    await tick()
    expect(client.callsOf('pane.focus')).toHaveLength(0)
    input.remove()
  })
})
