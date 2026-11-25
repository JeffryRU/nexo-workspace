import type { MethodResult } from '@nexo/contracts'
import { createStore, reconcile } from 'solid-js/store'
import type { AppState, StoreEvent, TabState, WorkspaceState } from './model.ts'
import {
  emptyState,
  fromSnapshot,
  reduce,
  terminalIdsOf,
  withActiveTab,
  withFocusedPane,
} from './reducers.ts'

/** Store de Solid alimentado por eventos: el reductor es puro y `reconcile` actualiza solo lo que cambió. */
export function createAppStore() {
  const [state, setState] = createStore<AppState>(emptyState())
  let raw: AppState = emptyState()

  const commit = (next: AppState) => {
    if (next === raw) return
    raw = next
    setState(reconcile(next, { merge: true }))
  }

  return {
    state,
    /** Copia plana (sin proxies) del estado, para pruebas y reductores. */
    snapshot: (): AppState => raw,
    applyEvent(ev: StoreEvent): void {
      commit(reduce(raw, ev))
    },
    applySnapshot(snapshot: MethodResult<'snapshot'>): void {
      commit(fromSnapshot(snapshot, raw))
    },
    setActiveTab(workspaceId: string, tabId: string): void {
      commit(withActiveTab(raw, workspaceId, tabId))
    },
    setFocusedPane(paneId: string): void {
      commit(withFocusedPane(raw, paneId))
    },
    terminalIds: (): Set<string> => terminalIdsOf(raw),
    reset(): void {
      commit({ ...emptyState() })
    },
  }
}

export type AppStore = ReturnType<typeof createAppStore>

export function findWorkspace(state: AppState, id: string | undefined): WorkspaceState | undefined {
  return id === undefined ? undefined : state.workspaces.find((w) => w.id === id)
}

export function activeTabOf(w: WorkspaceState | undefined): TabState | undefined {
  if (w === undefined) return undefined
  return w.tabs.find((t) => t.id === w.activeTabId) ?? w.tabs[0]
}

export function findPaneTab(
  state: AppState,
  paneId: string,
): { workspace: WorkspaceState; tab: TabState } | undefined {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs)
      if (tab.panes.some((p) => p.id === paneId)) return { workspace, tab }
  }
  return undefined
}
