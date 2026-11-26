import { describe, expect, it } from 'vitest'
import { FakeClient, mkPane, mkTab, mkWorkspace, pid, snapshotOf } from '../test-helpers.ts'
import { createActions } from './actions.ts'
import { createAppStore } from './store.ts'
import { createUiState } from './ui.ts'

function setup(panes: ReturnType<typeof mkPane>[]) {
  const client = new FakeClient()
  client.state = 'open'
  const tab = mkTab(
    't1',
    panes.map((p) => p.id),
  )
  tab.panes = panes
  const store = createAppStore()
  store.applySnapshot(snapshotOf([mkWorkspace('w1', [tab], { cwd: '/work' })], 1))
  client.handlers.set('pane.split', () => ({
    pane: mkPane('nuevo', { kind: 'viewer' }),
    layout: { type: 'leaf', paneId: pid('nuevo') },
  }))
  const actions = createActions({ client: () => client, store, ui: createUiState() })
  return { client, actions }
}

describe('openInViewer', () => {
  it('sin visor en la pestaña divide el panel de origen con uno nuevo', async () => {
    const { client, actions } = setup([mkPane('a', { kind: 'agent' })])
    await actions.openInViewer(pid('a'), '/work/x.md')
    expect(client.callsOf('pane.split')[0]?.params).toEqual({
      paneId: 'a',
      direction: 'row',
      kind: 'viewer',
      path: '/work/x.md',
    })
  })

  it('con un visor en la pestaña lo reutiliza', async () => {
    const { client, actions } = setup([
      mkPane('a', { kind: 'agent' }),
      mkPane('v', { kind: 'viewer' }),
    ])
    await actions.openInViewer(pid('a'), '/work/x.md')
    expect(client.callsOf('viewer.open')[0]?.params).toEqual({ paneId: 'v', path: '/work/x.md' })
    expect(client.callsOf('pane.split')).toHaveLength(0)
  })

  it('desde un visor reutiliza el propio', async () => {
    const { client, actions } = setup([
      mkPane('v1', { kind: 'viewer' }),
      mkPane('v2', { kind: 'viewer' }),
    ])
    await actions.openInViewer(pid('v2'), '/work/y.md')
    expect(client.callsOf('viewer.open')[0]?.params).toEqual({ paneId: 'v2', path: '/work/y.md' })
  })

  it('ignora rutas vacías, enormes y paneles que no existen', async () => {
    const { client, actions } = setup([mkPane('a', { kind: 'agent' })])
    await actions.openInViewer(pid('a'), '')
    await actions.openInViewer(pid('a'), `/${'x'.repeat(5000)}`)
    await actions.openInViewer(pid('fantasma'), '/work/x.md')
    expect(client.calls.filter((c) => c.method !== 'pane.focus')).toHaveLength(0)
  })
})
