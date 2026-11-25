import { fireEvent } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { mountApp } from '../test-app.tsx'
import { FakeClient, mkPane, mkTab, mkWorkspace, pid, snapshotOf, tid } from '../test-helpers.ts'
import { settle } from './test-helpers.ts'

function press(init: KeyboardEventInit) {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  )
}

const snapshot = () => snapshotOf([mkWorkspace('w1', [mkTab('t1', ['a'])])])

function wireTabCreate(client: Awaited<ReturnType<typeof mountApp>>['client']) {
  client.handlers.set('tab.create', () => ({ tab: mkTab('t2', ['n1']) }))
  client.handlers.set('pane.split', (p) => ({
    pane: mkPane('n2', { kind: 'agent' }),
    layout: { type: 'leaf', paneId: pid((p as { paneId: string }).paneId) },
  }))
  client.handlers.set('pane.close', () => ({}))
}

describe('crear paneles de agente desde la interfaz', () => {
  it('el botón de la barra de pestañas crea la pestaña, divide con kind agent y cierra el panel inicial', async () => {
    const { getByLabelText, client } = await mountApp(snapshot())
    wireTabCreate(client)
    fireEvent.click(getByLabelText('Nueva pestaña de agente'))
    await settle()
    expect(client.callsOf('tab.create')[0]?.params).toEqual({ workspaceId: 'w1' })
    expect(client.callsOf('pane.split')[0]?.params).toEqual({
      paneId: 'n1',
      direction: 'row',
      kind: 'agent',
    })
    expect(client.callsOf('pane.close')[0]?.params).toEqual({ paneId: 'n1' })
    expect(tid('t2')).toBe('t2')
  })

  it('Alt+Mayús+A abre una pestaña de agente', async () => {
    const { client } = await mountApp(snapshot())
    wireTabCreate(client)
    press({ key: 'A', code: 'KeyA', altKey: true, shiftKey: true })
    await settle()
    expect(client.callsOf('pane.split')[0]?.params).toMatchObject({ kind: 'agent' })
  })

  it('Alt+Mayús+E divide el panel enfocado con un agente', async () => {
    const { client } = await mountApp(snapshot())
    wireTabCreate(client)
    press({ key: 'E', code: 'KeyE', altKey: true, shiftKey: true })
    await settle()
    expect(client.callsOf('pane.split')[0]?.params).toEqual({
      paneId: 'a',
      direction: 'row',
      kind: 'agent',
    })
    expect(client.callsOf('tab.create')).toHaveLength(0)
  })

  it('el botón del panel divide con un agente a la derecha', async () => {
    const { getByLabelText, client } = await mountApp(snapshot())
    wireTabCreate(client)
    fireEvent.click(getByLabelText('Dividir con un agente'))
    await settle()
    expect(client.callsOf('pane.split')[0]?.params).toMatchObject({
      kind: 'agent',
      direction: 'row',
    })
  })

  it('si tab.create o pane.split fallan no se cierra nada', async () => {
    const { client, model } = await mountApp(snapshot())
    client.handlers.set('tab.create', () => {
      throw new Error('no')
    })
    await model.actions.newAgentTab()
    expect(client.callsOf('pane.split')).toHaveLength(0)
    client.handlers.set('tab.create', () => ({ tab: mkTab('t2', ['n1']) }))
    client.handlers.set('pane.split', () => {
      throw new Error('no')
    })
    await model.actions.newAgentTab()
    expect(client.callsOf('pane.close')).toHaveLength(0)
  })

  it('un panel de agente no crea terminal ni xterm', async () => {
    const tab = { ...mkTab('t1', ['a']), panes: [mkPane('a', { kind: 'agent', title: '' })] }
    const client = new FakeClient()
    client.handlers.set('agent.providers', () => ({ providers: [] }))
    const { xterms, container } = await mountApp(snapshotOf([mkWorkspace('w1', [tab])]), client)
    await settle()
    expect(client.callsOf('terminal.spawn')).toHaveLength(0)
    expect(xterms.size).toBe(0)
    expect(container.querySelector('.agent-panel')).not.toBeNull()
    expect(container.querySelector('.pane-title')?.textContent).toBe('Agente')
  })

  it('la ayuda lista los atajos de agente', async () => {
    const { client, container } = await mountApp(snapshot())
    expect(client).toBeDefined()
    press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
    await settle()
    expect(container.textContent).toContain('Nueva pestaña de agente')
    expect(container.textContent).toContain('Alt+Shift+A')
  })
})
