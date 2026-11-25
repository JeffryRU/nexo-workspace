import { describe, expect, it } from 'vitest'
import {
  attentionEvent,
  layoutEvent,
  mkPane,
  mkTab,
  mkWorkspace,
  pid,
  snapshotOf,
  summaryOf,
  tid,
  wid,
  workspaceEvent,
  xid,
} from '../test-helpers.ts'
import type { StoreEvent } from './model.ts'
import {
  emptyState,
  fromSnapshot,
  reduce,
  terminalIdsOf,
  withActiveTab,
  withFocusedPane,
} from './reducers.ts'
import { createAppStore } from './store.ts'

const ws = mkWorkspace('w1', [mkTab('t1', ['p1', 'p2']), mkTab('t2')])

describe('fromSnapshot', () => {
  it('copia espacios, pestañas y paneles', () => {
    const s = fromSnapshot(snapshotOf([ws], 7))
    expect(s.seq).toBe(7)
    expect(s.workspaces[0]?.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(s.workspaces[0]?.activeTabId).toBe('t1')
  })

  it('conserva las salidas de terminales que siguen existiendo y descarta las demás', () => {
    const tab = mkTab('t1', ['p1'])
    const withTerm = mkWorkspace('w1', [
      { ...tab, panes: [mkPane('p1', { terminalId: xid('x1') })] },
    ])
    let s = fromSnapshot(snapshotOf([withTerm], 1))
    s = reduce(s, {
      event: 'terminal.exit',
      seq: 2,
      data: { terminalId: xid('x1'), exitCode: 3, signal: null },
    })
    expect(s.exits.x1).toEqual({ exitCode: 3, signal: null })
    expect(fromSnapshot(snapshotOf([withTerm], 5), s).exits.x1).toBeDefined()
    expect(fromSnapshot(snapshotOf([ws], 5), s).exits).toEqual({})
  })

  it('terminalIdsOf lista los terminales de los paneles', () => {
    const w = mkWorkspace('w1', [
      { ...mkTab('t1', ['p1']), panes: [mkPane('p1', { terminalId: xid('x9') })] },
    ])
    expect([...terminalIdsOf(fromSnapshot(snapshotOf([w])))]).toEqual(['x9'])
  })
})

describe('reduce', () => {
  it('workspace.changed crea el espacio y luego renombra y reordena pestañas', () => {
    let s = reduce(emptyState(), workspaceEvent(mkWorkspace('w1'), 1))
    expect(s.workspaces).toHaveLength(1)
    const t1 = mkTab('t1')
    s = reduce(s, layoutEvent('w1', t1, 2))
    expect(s.workspaces[0]?.tabs[0]?.title).toBe('')
    s = reduce(s, workspaceEvent(mkWorkspace('w1', [t1], { name: 'Nuevo' }), 3))
    expect(s.workspaces[0]?.name).toBe('Nuevo')
    expect(s.workspaces[0]?.tabs[0]?.title).toBe(t1.title)
    expect(s.workspaces[0]?.activeTabId).toBe('t1')
  })

  it('workspace.changed con removed borra el espacio', () => {
    let s = fromSnapshot(snapshotOf([ws], 1))
    s = reduce(s, {
      event: 'workspace.changed',
      seq: 2,
      data: { workspaceId: wid('w1'), removed: true },
    })
    expect(s.workspaces).toEqual([])
  })

  it('layout.changed con layout nulo cierra la pestaña', () => {
    let s = fromSnapshot(snapshotOf([ws], 1))
    s = reduce(s, layoutEvent('w1', null, 2, 't2'))
    expect(s.workspaces[0]?.tabs.map((t) => t.id)).toEqual(['t1'])
  })

  it('layout.changed actualiza panes y foco', () => {
    let s = fromSnapshot(snapshotOf([ws], 1))
    const next = { ...mkTab('t1', ['p1', 'p2', 'p3']), focusedPaneId: pid('p3') }
    s = reduce(s, layoutEvent('w1', next, 2))
    expect(s.workspaces[0]?.tabs[0]?.panes).toHaveLength(3)
    expect(s.workspaces[0]?.tabs[0]?.focusedPaneId).toBe('p3')
  })

  it('layout.changed de un espacio desconocido se ignora', () => {
    const s = reduce(emptyState(), layoutEvent('nope', mkTab('t1'), 1))
    expect(s.workspaces).toEqual([])
  })

  it('mover una pestaña a otro espacio la quita del origen', () => {
    const a = mkWorkspace('a', [mkTab('t1'), mkTab('t2')])
    const b = mkWorkspace('b', [mkTab('t3')])
    let s = fromSnapshot(snapshotOf([a, b], 1))
    const moved = a.tabs[0] as (typeof a.tabs)[number]
    s = reduce(s, layoutEvent('b', moved, 2))
    expect(s.workspaces[0]?.tabs.map((t) => t.id)).toEqual(['t2'])
    expect(s.workspaces[1]?.tabs.map((t) => t.id)).toEqual(['t3', 't1'])
    expect(s.workspaces[1]?.tabs[1]?.title).toBe(moved.title)
  })

  it('pane.title y pane.attention cambian el panel', () => {
    let s = fromSnapshot(snapshotOf([ws], 1))
    s = reduce(s, { event: 'pane.title', seq: 2, data: { paneId: pid('p2'), title: 'vim' } })
    s = reduce(s, attentionEvent('p2', 'needs-input', 3))
    const p = s.workspaces[0]?.tabs[0]?.panes[1]
    expect(p?.title).toBe('vim')
    expect(p?.attention).toBe('needs-input')
  })

  it('terminal.exit de una terminal desconocida se ignora', () => {
    const s = reduce(fromSnapshot(snapshotOf([ws], 1)), {
      event: 'terminal.exit',
      seq: 2,
      data: { terminalId: xid('zzz'), exitCode: 0, signal: null },
    })
    expect(s.exits).toEqual({})
  })

  it('ignora eventos con seq ya aplicado', () => {
    const s0 = fromSnapshot(snapshotOf([ws], 10))
    const s1 = reduce(s0, attentionEvent('p1', 'error', 10))
    expect(s1).toBe(s0)
  })

  it('devuelve el mismo estado si el evento no toca nada', () => {
    const s0 = fromSnapshot(snapshotOf([ws], 1))
    const s1 = reduce(s0, attentionEvent('no-existe', 'done', 2))
    expect(s1.workspaces).toBe(s0.workspaces)
    expect(s1.seq).toBe(2)
  })
})

describe('optimistas', () => {
  it('withActiveTab y withFocusedPane', () => {
    const s0 = fromSnapshot(snapshotOf([ws], 1))
    const s1 = withActiveTab(s0, 'w1', 't2')
    expect(s1.workspaces[0]?.activeTabId).toBe('t2')
    expect(withActiveTab(s1, 'w1', 't2')).toBe(s1)
    expect(withActiveTab(s1, 'w1', 'no')).toBe(s1)
    expect(withActiveTab(s1, 'x', 't2')).toBe(s1)
    const s2 = withFocusedPane(s0, 'p2')
    expect(s2.workspaces[0]?.tabs[0]?.focusedPaneId).toBe('p2')
    expect(withFocusedPane(s2, 'p2')).toBe(s2)
    expect(withFocusedPane(s2, 'nada')).toBe(s2)
  })
})

describe('store', () => {
  it('aplica snapshot y eventos y notifica cambios finos', () => {
    const store = createAppStore()
    store.applySnapshot(snapshotOf([ws], 1))
    expect(store.state.workspaces[0]?.name).toBe('Espacio w1')
    const ev: StoreEvent = {
      event: 'pane.title',
      seq: 2,
      data: { paneId: pid('p1'), title: 'zsh' },
    }
    store.applyEvent(ev)
    expect(store.state.workspaces[0]?.tabs[0]?.panes[0]?.title).toBe('zsh')
    store.setActiveTab('w1', 't2')
    expect(store.state.workspaces[0]?.activeTabId).toBe('t2')
    store.setFocusedPane('p2')
    expect(store.state.workspaces[0]?.tabs[0]?.focusedPaneId).toBe('p2')
    expect([...store.terminalIds()]).toEqual([])
    store.reset()
    expect(store.state.workspaces).toEqual([])
  })

  it('un snapshot posterior reemplaza lo que había', () => {
    const store = createAppStore()
    store.applySnapshot(snapshotOf([ws], 1))
    store.applySnapshot(snapshotOf([mkWorkspace('otro', [mkTab('tx')])], 5))
    expect(store.state.workspaces.map((w) => w.id)).toEqual(['otro'])
    expect(store.snapshot().seq).toBe(5)
  })

  it('summaryOf y tid sirven de ayudas', () => {
    expect(summaryOf(ws).tabs[0]?.id).toBe(tid('t1'))
  })
})
