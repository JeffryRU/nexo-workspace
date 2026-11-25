import type {
  Attention,
  EventData,
  Layout,
  Pane,
  PaneId,
  TabId,
  TerminalId,
  WorkspaceId,
} from '@nexo/contracts'

export type TabState = {
  id: TabId
  title: string
  /** `null` mientras solo se conoce el resumen de la pestaña (aún no llegó su `layout.changed`). */
  layout: Layout | null
  panes: Pane[]
  focusedPaneId: PaneId | null
}

export type WorkspaceState = {
  id: WorkspaceId
  name: string
  cwd?: string
  activeTabId?: TabId
  tabs: TabState[]
}

export type ExitInfo = { exitCode: number | null; signal: string | null }

export type AppState = {
  /** `seq` del último evento (o snapshot) aplicado. */
  seq: number
  workspaces: WorkspaceState[]
  /** Terminales cuyo proceso terminó (el snapshot no lo trae: solo lo dicen los eventos). */
  exits: Record<string, ExitInfo>
}

export type StoreEventName =
  | 'layout.changed'
  | 'workspace.changed'
  | 'pane.title'
  | 'pane.attention'
  | 'terminal.exit'

export type StoreEvent = {
  [E in StoreEventName]: { event: E; seq: number; data: EventData<E> }
}[StoreEventName]

export const STORE_EVENTS: readonly StoreEventName[] = [
  'layout.changed',
  'workspace.changed',
  'pane.title',
  'pane.attention',
  'terminal.exit',
]

export type { Attention, PaneId, TabId, TerminalId, WorkspaceId }
