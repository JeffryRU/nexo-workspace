import { describe, expect, it } from 'vitest'
import {
  attentionEvent,
  layoutEvent,
  leaf,
  mkPane,
  mkTab,
  mkWorkspace,
  pid,
  snapshotOf,
  split,
  tid,
  wid,
  workspaceEvent,
} from '../test-helpers.ts'
import { emptyState, fromSnapshot, reduce } from './reducers.ts'
import { createAppStore } from './store.ts'

describe('reductor: entradas hostiles', () => {
  it('seq repetidos o desordenados no corrompen el estado', () => {
    const w = mkWorkspace('w1', [mkTab('t1')])
    let s = fromSnapshot(snapshotOf([w], 5))
    const late = attentionEvent('t1-p1', 'error', 3)
    const dup = attentionEvent('t1-p1', 'working', 6)
    s = reduce(s, dup)
    const before = s
    s = reduce(s, late)
    s = reduce(s, dup)
    expect(s).toBe(before)
    expect(s.workspaces[0]?.tabs[0]?.panes[0]?.attention).toBe('working')
  })

  it('eventos de paneles, pestañas y terminales inexistentes no cambian nada', () => {
    const s0 = fromSnapshot(snapshotOf([mkWorkspace('w1', [mkTab('t1')])], 1))
    let s = reduce(s0, {
      event: 'pane.title',
      seq: 2,
      data: { paneId: pid('fantasma'), title: 'x' },
    })
    s = reduce(s, layoutEvent('w1', null, 3, 'nunca-existio'))
    s = reduce(s, {
      event: 'workspace.changed',
      seq: 4,
      data: { workspaceId: wid('nada'), removed: true },
    })
    expect(s.workspaces).toEqual(s0.workspaces)
  })

  it('títulos con HTML se guardan como texto sin interpretar', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    let s = fromSnapshot(snapshotOf([mkWorkspace('w1', [mkTab('t1')])], 1))
    s = reduce(s, { event: 'pane.title', seq: 2, data: { paneId: pid('t1-p1'), title: evil } })
    expect(s.workspaces[0]?.tabs[0]?.panes[0]?.title).toBe(evil)
  })

  it('nombres enormes (256 caracteres, el máximo del contrato) pasan tal cual', () => {
    const name = 'ñ'.repeat(256)
    const s = reduce(emptyState(), workspaceEvent(mkWorkspace('w1', [], { name }), 1))
    expect(s.workspaces[0]?.name).toHaveLength(256)
  })

  it('200 paneles en una pestaña se reducen rápido', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `p${i}`)
    const tab = mkTab('t1', ids)
    let s = fromSnapshot(snapshotOf([mkWorkspace('w1', [mkTab('t1', ['p0'])])], 1))
    const start = performance.now()
    s = reduce(s, layoutEvent('w1', tab, 2))
    for (let i = 0; i < 200; i++) s = reduce(s, attentionEvent(`p${i}`, 'working', 3 + i))
    expect(performance.now() - start).toBeLessThan(2000)
    expect(s.workspaces[0]?.tabs[0]?.panes.every((p) => p.attention === 'working')).toBe(true)
  })

  it('un árbol de 200 niveles de profundidad no desborda la pila', () => {
    let layout = leaf('p0')
    const panes = [mkPane('p0')]
    for (let i = 1; i < 200; i++) {
      layout = split(i % 2 === 0 ? 'row' : 'column', layout, leaf(`p${i}`))
      panes.push(mkPane(`p${i}`))
    }
    const tab = { ...mkTab('t1', ['p0']), layout, panes }
    const store = createAppStore()
    store.applySnapshot(snapshotOf([mkWorkspace('w1', [tab])], 1))
    expect(store.state.workspaces[0]?.tabs[0]?.panes).toHaveLength(200)
  })

  it('una avalancha de eventos aleatorios nunca lanza', () => {
    const store = createAppStore()
    store.applySnapshot(snapshotOf([mkWorkspace('w1', [mkTab('t1')])], 0))
    for (let i = 1; i < 500; i++) {
      const kind = i % 4
      if (kind === 0) store.applyEvent(attentionEvent(`p${i % 7}`, 'done', i))
      else if (kind === 1) store.applyEvent(layoutEvent('w1', mkTab(`t${i % 5}`, [`p${i % 7}`]), i))
      else if (kind === 2) store.applyEvent(layoutEvent('w1', null, i, `t${i % 5}`))
      else store.applyEvent(workspaceEvent(mkWorkspace(`w${i % 3}`, [mkTab(`t${i % 5}`)]), i))
    }
    expect(store.state.workspaces.length).toBeGreaterThan(0)
    expect(tid('t1')).toBe('t1')
  })
})
