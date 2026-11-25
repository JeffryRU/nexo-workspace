import type { MethodResult } from '@nexo/contracts'
import type { AppState, StoreEvent, TabState, WorkspaceState } from './model.ts'

export function emptyState(): AppState {
  return { seq: 0, workspaces: [], exits: {} }
}

/** IDs de terminal presentes en algún panel. */
export function terminalIdsOf(state: AppState): Set<string> {
  const ids = new Set<string>()
  for (const w of state.workspaces) {
    for (const t of w.tabs) {
      for (const p of t.panes) if (p.terminalId !== undefined) ids.add(p.terminalId)
    }
  }
  return ids
}

function pruneExits(state: AppState): AppState {
  const keys = Object.keys(state.exits)
  if (keys.length === 0) return state
  const live = terminalIdsOf(state)
  const kept = keys.filter((k) => live.has(k))
  if (kept.length === keys.length) return state
  const exits: AppState['exits'] = {}
  for (const k of kept) exits[k] = state.exits[k] as AppState['exits'][string]
  return { ...state, exits }
}

/** Estado equivalente al `snapshot` del daemon (conserva las salidas de terminales que siguen existiendo). */
export function fromSnapshot(
  snapshot: MethodResult<'snapshot'>,
  previous: AppState = emptyState(),
): AppState {
  const workspaces: WorkspaceState[] = snapshot.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    ...(w.cwd === undefined ? {} : { cwd: w.cwd }),
    ...(w.activeTabId === undefined ? {} : { activeTabId: w.activeTabId }),
    tabs: w.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      layout: t.layout,
      panes: t.panes,
      focusedPaneId: t.focusedPaneId,
    })),
  }))
  return pruneExits({ seq: snapshot.seq, workspaces, exits: previous.exits })
}

function withoutTab(
  workspaces: WorkspaceState[],
  tabId: string,
  keepIn?: string,
): WorkspaceState[] {
  let changed = false
  const next = workspaces.map((w) => {
    if (w.id === keepIn || !w.tabs.some((t) => t.id === tabId)) return w
    changed = true
    return { ...w, tabs: w.tabs.filter((t) => t.id !== tabId) }
  })
  return changed ? next : workspaces
}

function findTabAnywhere(workspaces: WorkspaceState[], tabId: string): TabState | undefined {
  for (const w of workspaces) {
    const t = w.tabs.find((x) => x.id === tabId)
    if (t !== undefined) return t
  }
  return undefined
}

function mapPanes(
  state: AppState,
  paneId: string,
  update: (pane: TabState['panes'][number]) => TabState['panes'][number],
): AppState {
  let changed = false
  const workspaces = state.workspaces.map((w) => {
    let wChanged = false
    const tabs = w.tabs.map((t) => {
      if (!t.panes.some((p) => p.id === paneId)) return t
      wChanged = true
      return { ...t, panes: t.panes.map((p) => (p.id === paneId ? update(p) : p)) }
    })
    if (!wChanged) return w
    changed = true
    return { ...w, tabs }
  })
  return changed ? { ...state, workspaces } : state
}

/**
 * Aplica un evento del daemon. Pura: devuelve un estado nuevo (o el mismo si el evento no cambia nada).
 * Los eventos de un `seq` ya aplicado se ignoran, así que repetirlos o desordenarlos no corrompe el estado.
 */
export function reduce(state: AppState, ev: StoreEvent): AppState {
  if (ev.seq <= state.seq) return state
  const next = reduceData(state, ev)
  return pruneExits({ ...next, seq: ev.seq })
}

function reduceData(state: AppState, ev: StoreEvent): AppState {
  switch (ev.event) {
    case 'layout.changed': {
      const d = ev.data
      if (d.layout === null) {
        return { ...state, workspaces: withoutTab(state.workspaces, d.tabId) }
      }
      const layout = d.layout
      const target = state.workspaces.find((w) => w.id === d.workspaceId)
      if (target === undefined) return state
      const update = (t: TabState): TabState => ({
        ...t,
        layout,
        panes: d.panes,
        focusedPaneId: d.focusedPaneId,
      })
      const known = target.tabs.some((t) => t.id === d.tabId)
      const moved = known ? undefined : findTabAnywhere(state.workspaces, d.tabId)
      const base = withoutTab(state.workspaces, d.tabId, d.workspaceId)
      const workspaces = base.map((w) => {
        if (w.id !== d.workspaceId) return w
        if (known) return { ...w, tabs: w.tabs.map((t) => (t.id === d.tabId ? update(t) : t)) }
        const fresh: TabState = moved ?? {
          id: d.tabId,
          title: '',
          layout: null,
          panes: [],
          focusedPaneId: null,
        }
        return { ...w, tabs: [...w.tabs, update(fresh)] }
      })
      return { ...state, workspaces }
    }
    case 'workspace.changed': {
      const d = ev.data
      if ('removed' in d) {
        return { ...state, workspaces: state.workspaces.filter((w) => w.id !== d.workspaceId) }
      }
      const s = d.workspace
      const tabs: TabState[] = s.tabs.map((st) => {
        const existing = findTabAnywhere(state.workspaces, st.id)
        return existing === undefined
          ? { id: st.id, title: st.title, layout: null, panes: [], focusedPaneId: null }
          : { ...existing, title: st.title }
      })
      const merged: WorkspaceState = {
        id: s.id,
        name: s.name,
        ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
        ...(s.activeTabId === undefined ? {} : { activeTabId: s.activeTabId }),
        tabs,
      }
      let workspaces = state.workspaces
      for (const t of s.tabs) workspaces = withoutTab(workspaces, t.id, s.id)
      const exists = workspaces.some((w) => w.id === s.id)
      workspaces = exists
        ? workspaces.map((w) => (w.id === s.id ? merged : w))
        : [...workspaces, merged]
      return { ...state, workspaces }
    }
    case 'pane.title':
      return mapPanes(state, ev.data.paneId, (p) => ({ ...p, title: ev.data.title }))
    case 'pane.attention':
      return mapPanes(state, ev.data.paneId, (p) => ({ ...p, attention: ev.data.attention }))
    case 'terminal.exit': {
      const id = ev.data.terminalId
      if (!terminalIdsOf(state).has(id)) return state
      return {
        ...state,
        exits: { ...state.exits, [id]: { exitCode: ev.data.exitCode, signal: ev.data.signal } },
      }
    }
  }
}

/** Cambia la pestaña activa de un espacio (optimista; el daemon lo confirma con `workspace.changed`). */
export function withActiveTab(state: AppState, workspaceId: string, tabId: string): AppState {
  const w = state.workspaces.find((x) => x.id === workspaceId)
  if (w === undefined || w.activeTabId === tabId || !w.tabs.some((t) => t.id === tabId)) {
    return state
  }
  return {
    ...state,
    workspaces: state.workspaces.map((x) =>
      x.id === workspaceId ? { ...x, activeTabId: tabId as TabState['id'] } : x,
    ),
  }
}

/** Cambia el panel con foco de una pestaña (optimista). */
export function withFocusedPane(state: AppState, paneId: string): AppState {
  let changed = false
  const workspaces = state.workspaces.map((w) => {
    let wc = false
    const tabs = w.tabs.map((t) => {
      if (t.focusedPaneId === paneId || !t.panes.some((p) => p.id === paneId)) return t
      wc = true
      return { ...t, focusedPaneId: paneId as TabState['panes'][number]['id'] }
    })
    if (!wc) return w
    changed = true
    return { ...w, tabs }
  })
  return changed ? { ...state, workspaces } : state
}
