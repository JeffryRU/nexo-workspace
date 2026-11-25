import { fireEvent, render } from '@solidjs/testing-library'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { resetTabSwitchSamples, tabSwitchSamples } from './perf.ts'
import { mountApp } from './test-app.tsx'
import {
  leaf,
  mkPane,
  mkTab,
  mkWorkspace,
  pid,
  snapshotOf,
  split,
  tid,
  xid,
} from './test-helpers.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

const threePanes = () => {
  const tab = mkTab('t1', ['p1', 'p2', 'p3'])
  return {
    ...tab,
    title: 'Principal',
    layout: split('row', leaf('p1'), split('column', leaf('p2'), leaf('p3'))),
  }
}

const twoWorkspaces = () =>
  snapshotOf(
    [
      mkWorkspace('w1', [threePanes(), mkTab('t2', ['q1'])], { name: 'Proyecto' }),
      mkWorkspace('w2', [mkTab('t3', ['r1'])], { name: 'Otro' }),
    ],
    4,
  )

describe('barra lateral', () => {
  it('muestra espacios con sus pestañas y el estado de atención', async () => {
    const tab = {
      ...threePanes(),
      panes: threePanes().panes.map((p) =>
        p.id === 'p2' ? { ...p, attention: 'needs-input' as const } : p,
      ),
    }
    const { getByText, container } = await mountApp(
      snapshotOf([mkWorkspace('w1', [tab], { name: 'Proyecto' })]),
    )
    expect(getByText('Proyecto')).toBeTruthy()
    const dots = container.querySelectorAll('.sidebar .attention-dot')
    expect([...dots].map((d) => d.getAttribute('data-attention'))).toContain('needs-input')
    expect(container.querySelector('.sidebar [aria-label="Necesita tu respuesta"]')).not.toBeNull()
  })

  it('crear espacio llama a workspace.create y tab.create', async () => {
    const { getByLabelText, client } = await mountApp(snapshotOf([]))
    client.handlers.set('workspace.create', () => ({ workspace: mkWorkspace('nuevo') }))
    fireEvent.click(getByLabelText('Nuevo espacio'))
    await tick()
    await tick()
    expect(client.callsOf('workspace.create')[0]?.params).toEqual({ name: 'Espacio 1' })
    expect(client.callsOf('tab.create')[0]?.params).toEqual({ workspaceId: 'nuevo' })
  })

  it('doble clic renombra en línea; Intro confirma y Esc cancela', async () => {
    const { getByText, container, client } = await mountApp(twoWorkspaces())
    fireEvent.dblClick(getByText('Proyecto'))
    const input = container.querySelector('.sidebar input.inline-edit') as HTMLInputElement
    expect(input.value).toBe('Proyecto')
    input.value = '  Nuevo   nombre  '
    fireEvent.keyDown(input, { key: 'Enter' })
    await tick()
    expect(client.callsOf('workspace.rename')[0]?.params).toEqual({
      workspaceId: 'w1',
      name: 'Nuevo nombre',
    })
    fireEvent.dblClick(getByText('Otro'))
    const second = container.querySelector('.sidebar input.inline-edit') as HTMLInputElement
    second.value = 'no'
    fireEvent.keyDown(second, { key: 'Escape' })
    await tick()
    expect(client.callsOf('workspace.rename')).toHaveLength(1)
    expect(container.querySelector('.sidebar input.inline-edit')).toBeNull()
  })

  it('un nombre vacío al renombrar no llama al daemon', async () => {
    const { getByText, container, client } = await mountApp(twoWorkspaces())
    fireEvent.dblClick(getByText('Otro'))
    const input = container.querySelector('.sidebar input.inline-edit') as HTMLInputElement
    input.value = '   '
    fireEvent.blur(input)
    await tick()
    expect(client.callsOf('workspace.rename')).toHaveLength(0)
  })

  it('cerrar espacio y seleccionar una pestaña de otro espacio', async () => {
    const { getByLabelText, getAllByText, client, container } = await mountApp(twoWorkspaces())
    fireEvent.click(getByLabelText('Cerrar espacio: Otro'))
    await tick()
    expect(client.callsOf('workspace.close')[0]?.params).toEqual({ workspaceId: 'w2' })
    fireEvent.click(getAllByText('Pestaña t3')[0] as HTMLElement)
    await tick()
    expect(client.callsOf('tab.focus')[0]?.params).toEqual({ tabId: 't3' })
    expect(container.querySelector('#tabpanel-t3')?.hasAttribute('hidden')).toBe(false)
  })

  it('sin espacios ofrece crear el primero', async () => {
    const { getByText, client } = await mountApp(snapshotOf([]))
    client.handlers.set('workspace.create', () => ({ workspace: mkWorkspace('a') }))
    fireEvent.click(getByText('Crear el primero'))
    await tick()
    expect(client.callsOf('workspace.create')).toHaveLength(1)
  })
})

describe('pestañas', () => {
  it('usa los roles tablist, tab y tabpanel con sus relaciones', async () => {
    const { container } = await mountApp(twoWorkspaces())
    const list = container.querySelector('[role="tablist"]') as HTMLElement
    const tabs = [...list.querySelectorAll('[role="tab"]')]
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]?.getAttribute('tabindex')).toBe('-1')
    const panel = container.querySelector(`#${tabs[0]?.getAttribute('aria-controls')}`)
    expect(panel?.getAttribute('role')).toBe('tabpanel')
    expect(panel?.getAttribute('aria-labelledby')).toBe(tabs[0]?.id)
  })

  it('cambiar de pestaña no desmonta nada: solo oculta, y mide tab-switch', async () => {
    const { container, getAllByRole, client } = await mountApp(twoWorkspaces())
    const panelsBefore = [...container.querySelectorAll('[role="tabpanel"]')]
    const paneBefore = container.querySelector('[data-pane-id="p1"]')
    expect(panelsBefore).toHaveLength(3)
    resetTabSwitchSamples()
    const second = getAllByRole('tab')[1] as HTMLElement
    fireEvent.click(second)
    await tick()
    expect(client.callsOf('tab.focus')).toHaveLength(1)
    expect(container.querySelector('#tabpanel-t1')?.hasAttribute('hidden')).toBe(true)
    expect(container.querySelector('#tabpanel-t2')?.hasAttribute('hidden')).toBe(false)
    expect(container.querySelector('[data-pane-id="p1"]')).toBe(paneBefore)
    await vi.waitFor(() => expect(tabSwitchSamples()).toHaveLength(1))
    expect(performance.getEntriesByName('tab-switch').length).toBeGreaterThan(0)
  })

  it('las flechas mueven entre pestañas', async () => {
    const { getAllByRole, client } = await mountApp(twoWorkspaces())
    const first = getAllByRole('tab')[0] as HTMLElement
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    await tick()
    expect(client.callsOf('tab.focus')[0]?.params).toEqual({ tabId: 't2' })
    fireEvent.keyDown(first, { key: 'End' })
    fireEvent.keyDown(first, { key: 'Home' })
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    fireEvent.keyDown(first, { key: 'x' })
  })

  it('doble clic en una pestaña la renombra; el botón + crea y × cierra', async () => {
    const { getAllByRole, getByLabelText, container, client } = await mountApp(twoWorkspaces())
    fireEvent.dblClick(getAllByRole('tab')[0] as HTMLElement)
    const input = container.querySelector('.tablist input.inline-edit') as HTMLInputElement
    input.value = 'Build'
    fireEvent.keyDown(input, { key: 'Enter' })
    await tick()
    expect(client.callsOf('tab.rename')[0]?.params).toEqual({ tabId: 't1', title: 'Build' })
    fireEvent.click(getByLabelText('Nueva pestaña'))
    fireEvent.click(getByLabelText('Cerrar pestaña: Principal'))
    await tick()
    expect(client.callsOf('tab.create')[0]?.params).toEqual({ workspaceId: 'w1' })
    expect(client.callsOf('tab.close')[0]?.params).toEqual({ tabId: 't1' })
  })
})

describe('paneles y divisores', () => {
  it('dibuja el árbol con separadores accesibles', async () => {
    const { container } = await mountApp(twoWorkspaces())
    const panel = container.querySelector('#tabpanel-t1') as HTMLElement
    expect(panel.querySelectorAll('[data-pane-id]')).toHaveLength(3)
    const seps = [...panel.querySelectorAll('hr.divider')]
    expect(seps).toHaveLength(2)
    expect(seps[0]?.getAttribute('aria-orientation')).toBe('vertical')
    expect(seps[0]?.getAttribute('aria-valuenow')).toBe('50')
    expect(seps[1]?.getAttribute('aria-orientation')).toBe('horizontal')
    expect(seps[0]?.getAttribute('tabindex')).toBe('0')
  })

  it('el teclado mueve el divisor con pane.resize', async () => {
    const { container, client } = await mountApp(twoWorkspaces())
    const sep = container.querySelector('#tabpanel-t1 hr.divider') as HTMLElement
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(sep, { key: 'a' })
    await tick()
    const calls = client.callsOf('pane.resize').map((c) => c.params)
    expect(calls).toEqual([
      { paneId: 'p1', delta: 0.02 },
      { paneId: 'p1', delta: -0.1 },
    ])
  })

  it('arrastrar el divisor envía incrementos y soltar termina', async () => {
    const { container, client } = await mountApp(twoWorkspaces())
    const sep = container.querySelector('#tabpanel-t1 hr.divider') as HTMLElement
    const parent = sep.parentElement as HTMLElement
    parent.getBoundingClientRect = () => ({ width: 1000, height: 500 }) as DOMRect
    sep.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, button: 0 }))
    sep.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200 }))
    sep.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 300 }))
    sep.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 300 }))
    sep.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 600 }))
    await tick()
    const deltas = client.callsOf('pane.resize').map((c) => (c.params as { delta: number }).delta)
    expect(deltas).toHaveLength(2)
    expect(deltas[0]).toBeCloseTo(0.1)
    expect(deltas[1]).toBeCloseTo(0.1)
  })

  it('perder la conexión durante un arrastre lo suelta sin errores', async () => {
    const { container, client } = await mountApp(twoWorkspaces())
    const sep = container.querySelector('#tabpanel-t1 hr.divider') as HTMLElement
    const parent = sep.parentElement as HTMLElement
    parent.getBoundingClientRect = () => ({ width: 1000, height: 500 }) as DOMRect
    sep.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, button: 0 }))
    sep.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200 }))
    client.setState('reconnecting')
    sep.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 400 }))
    await tick()
    expect(client.callsOf('pane.resize')).toHaveLength(1)
    expect(sep.classList.contains('dragging')).toBe(false)
  })

  it('un divisor entre dos subárboles no se puede arrastrar', async () => {
    const tab = {
      ...mkTab('t1', ['a', 'b', 'c', 'd']),
      layout: split(
        'row',
        split('column', leaf('a'), leaf('b')),
        split('column', leaf('c'), leaf('d')),
      ),
    }
    const { container, client } = await mountApp(snapshotOf([mkWorkspace('w1', [tab])]))
    const sep = container.querySelector('#tabpanel-t1 .divider.vertical') as HTMLElement
    expect(sep.getAttribute('aria-disabled')).toBe('true')
    expect(sep.getAttribute('tabindex')).toBe('-1')
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    await tick()
    expect(client.callsOf('pane.resize')).toHaveLength(0)
  })

  it('enfocar con clic, dividir, intercambiar y cerrar llaman al daemon', async () => {
    const { container, getAllByLabelText, client } = await mountApp(twoWorkspaces())
    const p2 = container.querySelector('[data-pane-id="p2"]') as HTMLElement
    p2.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await tick()
    expect(client.callsOf('pane.focus')[0]?.params).toEqual({ paneId: 'p2' })
    expect(p2.classList.contains('focused')).toBe(true)

    const within = (id: string, label: string) =>
      (container.querySelector(`[data-pane-id="${id}"]`) as HTMLElement).querySelector(
        `[aria-label="${label}"]`,
      ) as HTMLElement
    fireEvent.click(within('p1', 'Dividir a la derecha'))
    fireEvent.click(within('p1', 'Dividir hacia abajo'))
    fireEvent.click(within('p3', 'Cerrar panel'))
    fireEvent.click(within('p1', 'Intercambiar de sitio'))
    expect(container.querySelector('[data-pane-id="p1"]')?.classList.contains('swap-source')).toBe(
      true,
    )
    fireEvent.click(within('p3', 'Intercambiar de sitio'))
    await tick()
    expect(client.callsOf('pane.split').map((c) => c.params)).toEqual([
      { paneId: 'p1', direction: 'row' },
      { paneId: 'p1', direction: 'column' },
    ])
    expect(client.callsOf('pane.close')[0]?.params).toEqual({ paneId: 'p3' })
    expect(client.callsOf('pane.swap')[0]?.params).toEqual({ paneId: 'p1', otherPaneId: 'p3' })
    expect(getAllByLabelText('Cerrar panel').length).toBeGreaterThan(0)
  })

  it('los eventos de layout actualizan el árbol en vivo', async () => {
    const { container, client } = await mountApp(twoWorkspaces())
    const next = mkTab('t1', ['p1', 'p2', 'p3', 'p4'])
    client.emit(
      'layout.changed',
      {
        workspaceId: 'w1',
        tabId: 't1',
        layout: next.layout,
        focusedPaneId: next.focusedPaneId,
        panes: next.panes,
      },
      5,
    )
    expect(container.querySelectorAll('#tabpanel-t1 [data-pane-id]')).toHaveLength(4)
    client.emit('pane.title', { paneId: pid('p4'), title: 'vim' }, 6)
    expect(container.querySelector('[data-pane-id="p4"] .pane-title')?.textContent).toBe('vim')
    expect(tid('t1')).toBe('t1')
  })
})

describe('terminales (xterm)', () => {
  it('solo se crean las de pestañas vistas, con WebGL únicamente si están visibles', async () => {
    const { xterms, getAllByRole, client } = await mountApp(twoWorkspaces())
    // 3 paneles de la pestaña activa; las demás pestañas no se han visto aún.
    expect(xterms.size).toBe(3)
    expect([...xterms.values()].every((x) => x.webglActive)).toBe(true)
    expect(client.callsOf('terminal.spawn')).toHaveLength(3)
    fireEvent.click(getAllByRole('tab')[1] as HTMLElement)
    await tick()
    const all = [...xterms.values()]
    expect(all).toHaveLength(4)
    expect(all.filter((x) => x.webglActive)).toHaveLength(1)
    expect(all.filter((x) => x.webglDisposals > 0)).toHaveLength(3)
    fireEvent.click(getAllByRole('tab')[0] as HTMLElement)
    await tick()
    expect([...xterms.values()].filter((x) => x.webglActive)).toHaveLength(3)
    expect(xterms.size).toBe(4)
  })

  it('un panel con terminal recibe su salida y la entrada se envía agrupada', async () => {
    const tab = mkTab('t1', ['p1'])
    const ws = mkWorkspace('w1', [{ ...tab, panes: [mkPane('p1', { terminalId: xid('x1') })] }])
    const { xterms, client, frames } = await mountApp(snapshotOf([ws]))
    await tick()
    client.emit('terminal.output', { terminalId: xid('x1'), offset: 5, data: 'hola\n' }, 5)
    frames.flush()
    const x = xterms.get(0)
    expect(x?.written.join('')).toBe('hola\n')
    x?.type('l')
    x?.type('s')
    frames.flush()
    expect(client.callsOf('terminal.write')).toHaveLength(1)
    expect(client.callsOf('terminal.write')[0]?.params).toEqual({ terminalId: 'x1', data: 'ls' })
    expect(client.callsOf('terminal.spawn')).toHaveLength(0)
  })

  it('terminal.exit avisa dentro de la terminal', async () => {
    const tab = mkTab('t1', ['p1'])
    const ws = mkWorkspace('w1', [{ ...tab, panes: [mkPane('p1', { terminalId: xid('x1') })] }])
    const { xterms, client } = await mountApp(snapshotOf([ws]))
    client.emit('terminal.exit', { terminalId: xid('x1'), exitCode: 1, signal: null }, 5)
    expect(xterms.get(0)?.notices[0]).toContain('código 1')
  })

  it('al cerrarse un panel se libera su terminal', async () => {
    const { xterms, client } = await mountApp(twoWorkspaces())
    const next = mkTab('t1', ['p1'])
    client.emit(
      'layout.changed',
      {
        workspaceId: 'w1',
        tabId: 't1',
        layout: next.layout,
        focusedPaneId: next.focusedPaneId,
        panes: next.panes,
      },
      5,
    )
    const disposed = [...xterms.values()].filter((x) => x.disposed)
    expect(disposed).toHaveLength(2)
  })
})

describe('pantallas de estado', () => {
  it('muestra el estado de conexión mientras no hay snapshot y permite reintentar', async () => {
    const { FakeClient } = await import('./test-helpers.ts')
    const client = new FakeClient()
    client.connectError = new Error('x')
    const { findByText, getByText, container } = await mountApp(snapshotOf([]), client)
    expect(await findByText('Sin conexión con el daemon')).toBeTruthy()
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    client.connectError = undefined
    fireEvent.click(getByText('Reintentar'))
    await tick()
    await tick()
    expect(container.querySelector('.workbench')).not.toBeNull()
  })

  it('al perder la conexión muestra el aviso de reconexión sin desmontar nada', async () => {
    const { container, client, getByText } = await mountApp(twoWorkspaces())
    const pane = container.querySelector('[data-pane-id="p1"]')
    client.setState('reconnecting')
    expect(getByText('Conexión perdida. Reconectando…')).toBeTruthy()
    expect(container.querySelector('[data-pane-id="p1"]')).toBe(pane)
    client.setState('open')
    expect(container.querySelector('.banner')).toBeNull()
  })

  it('sin datos del daemon muestra la pantalla correspondiente', () => {
    let retried = 0
    const { getByText } = render(() => (
      <App state={{ kind: 'no-daemon', reason: 'missing-token', onRetry: () => retried++ }} />
    ))
    expect(getByText('No hay daemon al que conectarse')).toBeTruthy()
    fireEvent.click(getByText('Reintentar'))
    expect(retried).toBe(1)
  })

  it('estado indefinido no pinta nada', () => {
    const { container } = render(() => <App state={undefined} />)
    expect(container.textContent).toBe('')
  })

  it('un error de una acción aparece en un aviso descartable', async () => {
    const { client, getByLabelText, findByRole, getByText } = await mountApp(
      snapshotOf([mkWorkspace('w1')]),
    )
    client.handlers.set('tab.create', () => {
      throw new Error('límite alcanzado')
    })
    fireEvent.click(getByLabelText('Nueva pestaña'))
    const alert = await findByRole('alert')
    expect(alert.textContent).toContain('límite alcanzado')
    fireEvent.click(getByText('Descartar'))
    expect(document.querySelector('.toast')).toBeNull()
  })
})
