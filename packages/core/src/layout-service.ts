import type {
  Layout,
  Pane,
  PaneId,
  PaneKind,
  SplitDirection,
  Tab,
  TabId,
  Workspace,
  WorkspaceId,
} from '@atalaya/contracts'
import { close, LayoutError, leaf, leaves, resize, split, swap } from './layout.ts'
import type { EventBusPort, IdPort } from './ports/misc.ts'

export type LayoutServiceDeps = { ids: IdPort; bus: EventBusPort }

const DEFAULT_TITLES: Record<PaneKind, string> = { terminal: 'Terminal', agent: 'Agente' }

/**
 * Caso de uso mínimo de F0: espacios, pestañas y paneles en memoria. Cada cambio de distribución o
 * de foco emite `layout.changed` por el `EventBusPort`. Los objetos devueltos no se mutan después:
 * cada cambio produce objetos nuevos.
 */
export class LayoutService {
  readonly #deps: LayoutServiceDeps
  readonly #workspaces = new Map<WorkspaceId, Workspace>()

  constructor(deps: LayoutServiceDeps) {
    this.#deps = deps
  }

  snapshot(): Workspace[] {
    return [...this.#workspaces.values()]
  }

  createWorkspace(name: string, cwd?: string): Workspace {
    const workspace: Workspace = {
      id: this.#deps.ids.workspace(),
      name,
      ...(cwd === undefined ? {} : { cwd }),
      tabs: [],
    }
    this.#workspaces.set(workspace.id, workspace)
    return workspace
  }

  createTab(workspaceId: WorkspaceId, title?: string): Tab {
    const workspace = this.#workspace(workspaceId)
    const pane: Pane = {
      id: this.#deps.ids.pane(),
      kind: 'terminal',
      title: DEFAULT_TITLES.terminal,
      attention: 'idle',
    }
    const tab: Tab = {
      id: this.#deps.ids.tab(),
      title: title ?? `Pestaña ${workspace.tabs.length + 1}`,
      layout: leaf(pane.id),
      panes: [pane],
      focusedPaneId: pane.id,
    }
    this.#workspaces.set(workspaceId, {
      ...workspace,
      tabs: [...workspace.tabs, tab],
      activeTabId: tab.id,
    })
    this.#emit(workspaceId, tab)
    return tab
  }

  split(
    paneId: PaneId,
    direction: SplitDirection,
    kind: PaneKind = 'terminal',
    ratio?: number,
  ): Pane {
    const { workspace, tab } = this.#locate(paneId)
    const pane: Pane = {
      id: this.#deps.ids.pane(),
      kind,
      title: DEFAULT_TITLES[kind],
      attention: 'idle',
    }
    const layout = split(tab.layout, paneId, direction, pane.id, ratio)
    this.#update(workspace.id, {
      ...tab,
      layout,
      panes: [...tab.panes, pane],
      focusedPaneId: pane.id,
    })
    return pane
  }

  /** Cierra un panel; si era el último, cierra la pestaña. */
  closePane(paneId: PaneId): void {
    const { workspace, tab } = this.#locate(paneId)
    const layout = close(tab.layout, paneId)
    if (layout === null) {
      this.#removeTab(workspace, tab)
      return
    }
    const remaining = tab.panes.filter((p) => p.id !== paneId)
    let focused = tab.focusedPaneId
    if (focused === paneId) {
      const order = leaves(tab.layout)
      const at = order.indexOf(paneId)
      focused = (order[at - 1] ?? order[at + 1]) as PaneId
    }
    this.#update(workspace.id, { ...tab, layout, panes: remaining, focusedPaneId: focused })
  }

  closeTab(tabId: TabId): void {
    const { workspace, tab } = this.#locateTab(tabId)
    this.#removeTab(workspace, tab)
  }

  focusPane(paneId: PaneId): void {
    const { workspace, tab } = this.#locate(paneId)
    this.#update(workspace.id, { ...tab, focusedPaneId: paneId })
  }

  focusTab(tabId: TabId): void {
    const { workspace, tab } = this.#locateTab(tabId)
    this.#workspaces.set(workspace.id, { ...workspace, activeTabId: tab.id })
    this.#emit(workspace.id, tab)
  }

  resizePane(paneId: PaneId, delta: number): Layout {
    const { workspace, tab } = this.#locate(paneId)
    const layout = resize(tab.layout, paneId, delta)
    this.#update(workspace.id, { ...tab, layout })
    return layout
  }

  swapPanes(a: PaneId, b: PaneId): Layout {
    const { workspace, tab } = this.#locate(a)
    const layout = swap(tab.layout, a, b)
    this.#update(workspace.id, { ...tab, layout })
    return layout
  }

  #workspace(id: WorkspaceId): Workspace {
    const workspace = this.#workspaces.get(id)
    if (workspace === undefined) throw new LayoutError('NOT_FOUND', `espacio inexistente: ${id}`)
    return workspace
  }

  #locate(paneId: PaneId): { workspace: Workspace; tab: Tab } {
    for (const workspace of this.#workspaces.values()) {
      for (const tab of workspace.tabs) {
        if (tab.panes.some((p) => p.id === paneId)) return { workspace, tab }
      }
    }
    throw new LayoutError('NOT_FOUND', `panel inexistente: ${paneId}`)
  }

  #locateTab(tabId: TabId): { workspace: Workspace; tab: Tab } {
    for (const workspace of this.#workspaces.values()) {
      const tab = workspace.tabs.find((t) => t.id === tabId)
      if (tab !== undefined) return { workspace, tab }
    }
    throw new LayoutError('NOT_FOUND', `pestaña inexistente: ${tabId}`)
  }

  #update(workspaceId: WorkspaceId, tab: Tab): void {
    const workspace = this.#workspace(workspaceId)
    this.#workspaces.set(workspaceId, {
      ...workspace,
      tabs: workspace.tabs.map((t) => (t.id === tab.id ? tab : t)),
    })
    this.#emit(workspaceId, tab)
  }

  #removeTab(workspace: Workspace, tab: Tab): void {
    const tabs = workspace.tabs.filter((t) => t.id !== tab.id)
    const at = workspace.tabs.findIndex((t) => t.id === tab.id)
    const wasActive = workspace.activeTabId === tab.id
    const activeTabId = wasActive ? (tabs[at] ?? tabs[at - 1])?.id : workspace.activeTabId
    const { activeTabId: _previous, ...rest } = workspace
    this.#workspaces.set(workspace.id, {
      ...rest,
      tabs,
      ...(activeTabId === undefined ? {} : { activeTabId }),
    })
    this.#deps.bus.publish({
      event: 'layout.changed',
      data: {
        workspaceId: workspace.id,
        tabId: tab.id,
        layout: null,
        focusedPaneId: null,
        panes: [],
      },
    })
  }

  #emit(workspaceId: WorkspaceId, tab: Tab): void {
    this.#deps.bus.publish({
      event: 'layout.changed',
      data: {
        workspaceId,
        tabId: tab.id,
        layout: tab.layout,
        focusedPaneId: tab.focusedPaneId,
        panes: tab.panes,
      },
    })
  }
}
