import type { Layout, Tab, Workspace } from '@nexo/contracts'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  layoutEvent,
  mkPane,
  pid,
  rowOf,
  snapshotOf,
  summaryOf,
  tid,
  wid,
  workspaceEvent,
  xid,
} from '../test-helpers.ts'
import type { StoreEvent } from './model.ts'
import { emptyState, fromSnapshot, reduce } from './reducers.ts'
import { createAppStore } from './store.ts'

/** Modelo del daemon: aplica operaciones y emite los mismos eventos que `LayoutService`. */
class ServerModel {
  workspaces: Workspace[] = []
  seq = 0
  events: StoreEvent[] = []
  #n = 0

  #id(prefix: string) {
    return `${prefix}${++this.#n}`
  }
  #emit(make: (seq: number) => StoreEvent) {
    this.events.push(make(++this.seq))
  }
  #ws(i: number) {
    return this.workspaces.length === 0 ? undefined : this.workspaces[i % this.workspaces.length]
  }
  #tab(i: number, j: number) {
    const w = this.#ws(i)
    if (w === undefined || w.tabs.length === 0) return undefined
    return { w, t: w.tabs[j % w.tabs.length] as Tab }
  }
  #replaceWs(w: Workspace) {
    this.workspaces = this.workspaces.map((x) => (x.id === w.id ? w : x))
  }
  #replaceTab(w: Workspace, t: Tab) {
    this.#replaceWs({ ...w, tabs: w.tabs.map((x) => (x.id === t.id ? t : x)) })
  }

  apply(op: number, a: number, b: number): void {
    switch (op) {
      case 0: {
        const w: Workspace = { id: wid(this.#id('w')), name: `E${this.#n}`, tabs: [] }
        this.workspaces = [...this.workspaces, w]
        this.#emit((s) => workspaceEvent(w, s))
        break
      }
      case 1: {
        const w = this.#ws(a)
        if (w === undefined) break
        const next = { ...w, name: `R${this.#n++}` }
        this.#replaceWs(next)
        this.#emit((s) => workspaceEvent(next, s))
        break
      }
      case 2: {
        const w = this.#ws(a)
        if (w === undefined) break
        this.workspaces = this.workspaces.filter((x) => x.id !== w.id)
        for (const t of w.tabs) this.#emit((s) => layoutEvent(w.id, null, s, t.id))
        this.#emit((s) => ({
          event: 'workspace.changed',
          seq: s,
          data: { workspaceId: w.id, removed: true },
        }))
        break
      }
      case 3: {
        const w = this.#ws(a)
        if (w === undefined) break
        const pane = mkPane(this.#id('p'))
        const tab: Tab = {
          id: tid(this.#id('t')),
          title: `Pestaña ${w.tabs.length + 1}`,
          layout: rowOf(pane.id),
          panes: [pane],
          focusedPaneId: pane.id,
        }
        const next = { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id }
        this.#replaceWs(next)
        this.#emit((s) => layoutEvent(w.id, tab, s))
        this.#emit((s) => workspaceEvent(next, s))
        break
      }
      case 4: {
        const f = this.#tab(a, b)
        if (f === undefined) break
        const { w, t } = f
        const tabs = w.tabs.filter((x) => x.id !== t.id)
        const at = w.tabs.findIndex((x) => x.id === t.id)
        const active = w.activeTabId === t.id ? (tabs[at] ?? tabs[at - 1])?.id : w.activeTabId
        const { activeTabId: _a, ...rest } = w
        const next: Workspace = {
          ...rest,
          tabs,
          ...(active === undefined ? {} : { activeTabId: active }),
        }
        this.#replaceWs(next)
        this.#emit((s) => layoutEvent(w.id, null, s, t.id))
        this.#emit((s) => workspaceEvent(next, s))
        break
      }
      case 5: {
        const f = this.#tab(a, b)
        if (f === undefined) break
        const { w, t } = f
        const next = {
          ...w,
          tabs: w.tabs.map((x) => (x.id === t.id ? { ...x, title: `T${this.#n++}` } : x)),
        }
        this.#replaceWs(next)
        this.#emit((s) => workspaceEvent(next, s))
        break
      }
      case 6: {
        // Añade un panel (nuevo reparto de la pestaña).
        const f = this.#tab(a, b)
        if (f === undefined) break
        const { w, t } = f
        const pane = mkPane(this.#id('p'))
        const panes = [...t.panes, pane]
        const layout: Layout = rowOf(...panes.map((p) => p.id))
        const next: Tab = { ...t, panes, layout, focusedPaneId: pane.id }
        this.#replaceTab(w, next)
        this.#emit((s) => layoutEvent(w.id, next, s))
        break
      }
      case 7: {
        const f = this.#tab(a, b)
        if (f === undefined) break
        const { w, t } = f
        const target = t.panes[(a + b) % t.panes.length]
        if (target === undefined) break
        const title = `título ${this.#n++}`
        this.#replaceTab(w, {
          ...t,
          panes: t.panes.map((p) => (p.id === target.id ? { ...p, title } : p)),
        })
        this.#emit((s) => ({ event: 'pane.title', seq: s, data: { paneId: target.id, title } }))
        break
      }
      case 8: {
        const f = this.#tab(a, b)
        if (f === undefined) break
        const { w, t } = f
        const target = t.panes[(a * 3 + b) % t.panes.length]
        if (target === undefined) break
        const attention = (['idle', 'working', 'needs-input', 'done', 'error'] as const)[
          (a + b) % 5
        ] as 'idle'
        this.#replaceTab(w, {
          ...t,
          panes: t.panes.map((p) => (p.id === target.id ? { ...p, attention } : p)),
        })
        this.#emit((s) => ({
          event: 'pane.attention',
          seq: s,
          data: { paneId: target.id, attention },
        }))
        break
      }
      case 9: {
        // Asocia una terminal a un panel (layout.changed con terminalId).
        const f = this.#tab(a, b)
        if (f === undefined) break
        const { w, t } = f
        const target = t.panes[b % t.panes.length]
        if (target === undefined) break
        const terminalId = xid(this.#id('x'))
        const next: Tab = {
          ...t,
          panes: t.panes.map((p) => (p.id === target.id ? { ...p, terminalId } : p)),
        }
        this.#replaceTab(w, next)
        this.#emit((s) => layoutEvent(w.id, next, s))
        break
      }
      default: {
        const f = this.#tab(a, b)
        if (f === undefined) break
        const { w, t } = f
        const next = { ...w, activeTabId: t.id }
        this.#replaceWs(next)
        this.#emit((s) => workspaceEvent(next, s))
      }
    }
  }
}

const ops = fc.array(fc.tuple(fc.integer({ min: 0, max: 10 }), fc.nat(40), fc.nat(40)), {
  maxLength: 80,
})

describe('propiedad: eventos == snapshot', () => {
  it('aplicar eventos al estado da lo mismo que el snapshot equivalente', () => {
    fc.assert(
      fc.property(ops, (list) => {
        const server = new ServerModel()
        for (const [op, a, b] of list) server.apply(op, a, b)
        let state = emptyState()
        for (const ev of server.events) state = reduce(state, ev)
        const expected = fromSnapshot(snapshotOf(server.workspaces, server.seq))
        expect(state.workspaces).toEqual(expected.workspaces)
        expect(state.seq).toBe(server.seq)
      }),
      { numRuns: 200 },
    )
  })

  it('el store de Solid termina igual que el reductor puro', () => {
    fc.assert(
      fc.property(ops, (list) => {
        const server = new ServerModel()
        for (const [op, a, b] of list) server.apply(op, a, b)
        const store = createAppStore()
        for (const ev of server.events) store.applyEvent(ev)
        const expected = fromSnapshot(snapshotOf(server.workspaces, server.seq))
        expect(JSON.parse(JSON.stringify(store.state.workspaces))).toEqual(
          JSON.parse(JSON.stringify(expected.workspaces)),
        )
      }),
      { numRuns: 60 },
    )
  })

  it('repetir cada evento no cambia el resultado', () => {
    fc.assert(
      fc.property(ops, (list) => {
        const server = new ServerModel()
        for (const [op, a, b] of list) server.apply(op, a, b)
        let once = emptyState()
        let twice = emptyState()
        for (const ev of server.events) {
          once = reduce(once, ev)
          twice = reduce(reduce(twice, ev), ev)
        }
        expect(twice).toEqual(once)
      }),
      { numRuns: 100 },
    )
  })

  it('un snapshot a mitad de camino más el resto de eventos converge igual', () => {
    fc.assert(
      fc.property(ops, fc.nat(100), (list, cut) => {
        const server = new ServerModel()
        const early = new ServerModel()
        list.forEach(([op, a, b], i) => {
          server.apply(op, a, b)
          if (i < cut % (list.length + 1)) early.apply(op, a, b)
        })
        const k = early.events.length
        let state = fromSnapshot(snapshotOf(early.workspaces, early.seq))
        for (const ev of server.events.slice(k)) state = reduce(state, ev)
        expect(state.workspaces).toEqual(
          fromSnapshot(snapshotOf(server.workspaces, server.seq)).workspaces,
        )
      }),
      { numRuns: 100 },
    )
  })

  it('summaryOf describe el espacio con sus pestañas', () => {
    const w: Workspace = { id: wid('w1'), name: 'x', tabs: [] }
    expect(summaryOf(w).tabs).toEqual([])
    expect(pid('a')).toBe('a')
  })
})
