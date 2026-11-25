import type {
  Layout,
  Pane,
  PaneId,
  PaneKind,
  SplitDirection,
  Tab,
  TabId,
  TerminalId,
  Workspace,
  WorkspaceId,
} from '@nexo/contracts'
import { DomainError } from './errors.ts'
import { close, LayoutError, leaf, leaves, resize, split, swap } from './layout.ts'
import type { EventBusPort, IdPort } from './ports/misc.ts'

export type LayoutServiceDeps = { ids: IdPort; bus: EventBusPort }

const DEFAULT_TITLES: Record<PaneKind, string> = { terminal: 'Terminal', agent: 'Agente' }
const MAX_WORKSPACES = 1024
const MAX_TABS_PER_WORKSPACE = 1024

/** Lo que `TerminalService` necesita saber de los paneles (lo implementa `LayoutService`). */
export interface PaneDirectory {
  paneContext(paneId: PaneId): { pane: Pane; cwd?: string } | undefined
  attachTerminal(paneId: PaneId, terminalId: TerminalId): void
  /** No hace nada si el panel ya no existe o apunta a otra terminal. */
  detachTerminal(paneId: PaneId, terminalId: TerminalId): void
  /** No hace nada si el panel ya no existe. */
  setPaneTitle(paneId: PaneId, title: string): void
}

/**
 * Dueño del estado de espacios, pestañas y paneles (en memoria). Cada cambio de distribución o de
 * foco emite `layout.changed` por el `EventBusPort`. Los objetos devueltos no se mutan después:
 * cada cambio produce objetos nuevos. Valida que los ids que entrega `IdPort` no se repitan.
 */
export class LayoutService implements PaneDirectory {
  readonly #deps: LayoutServiceDeps
  readonly #workspaces = new Map<WorkspaceId, Workspace>()

  constructor(deps: LayoutServiceDeps) {
    this.#deps = deps
  }

  snapshot(): Workspace[] {
    return [...this.#workspaces.values()]
  }

  createWorkspace(name: string, cwd?: string): Workspace {
    if (this.#workspaces.size >= MAX_WORKSPACES) {
      throw new DomainError('CONFLICT', 'demasiados espacios')
    }
    const id = this.#deps.ids.workspace()
    if (this.#workspaces.has(id)) throw new DomainError('CONFLICT', `id de espacio repetido: ${id}`)
    const workspace: Workspace = { id, name, ...(cwd === undefined ? {} : { cwd }), tabs: [] }
    this.#workspaces.set(workspace.id, workspace)
    return workspace
  }

  renameWorkspace(workspaceId: WorkspaceId, name: string): void {
    const workspace = this.#workspace(workspaceId)
    this.#workspaces.set(workspaceId, { ...workspace, name })
  }

  /** Cierra el espacio y devuelve los paneles que tenía. Emite `layout.changed` (nulo) por pestaña. */
  closeWorkspace(workspaceId: WorkspaceId): PaneId[] {
    const workspace = this.#workspace(workspaceId)
    this.#workspaces.delete(workspaceId)
    const paneIds: PaneId[] = []
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) paneIds.push(pane.id)
      this.#emitClosed(workspaceId, tab.id)
    }
    return paneIds
  }

  createTab(workspaceId: WorkspaceId, title?: string): Tab {
    const workspace = this.#workspace(workspaceId)
    if (workspace.tabs.length >= MAX_TABS_PER_WORKSPACE) {
      throw new DomainError('CONFLICT', 'demasiadas pestañas en el espacio')
    }
    const tabId = this.#deps.ids.tab()
    if (this.#findTab(tabId) !== undefined) {
      throw new DomainError('CONFLICT', `id de pestaña repetido: ${tabId}`)
    }
    const paneId = this.#deps.ids.pane()
    if (this.#findPane(paneId) !== undefined) {
      throw new DomainError('CONFLICT', `id de panel repetido: ${paneId}`)
    }
    const pane: Pane = {
      id: paneId,
      kind: 'terminal',
      title: DEFAULT_TITLES.terminal,
      attention: 'idle',
    }
    const tab: Tab = {
      id: tabId,
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

  renameTab(tabId: TabId, title: string): void {
    const { workspace, tab } = this.#locateTab(tabId)
    this.#workspaces.set(workspace.id, {
      ...workspace,
      tabs: workspace.tabs.map((t) => (t.id === tab.id ? { ...t, title } : t)),
    })
  }

  /** Mueve la pestaña a `index` (acotado) del espacio indicado o del suyo, y la deja activa. */
  moveTab(tabId: TabId, index: number, targetWorkspaceId?: WorkspaceId): void {
    const { workspace: source, tab } = this.#locateTab(tabId)
    const target = targetWorkspaceId === undefined ? source : this.#workspace(targetWorkspaceId)
    if (target.id !== source.id && target.tabs.length >= MAX_TABS_PER_WORKSPACE) {
      throw new DomainError('CONFLICT', 'demasiadas pestañas en el espacio')
    }
    if (target.id === source.id) {
      const others = source.tabs.filter((t) => t.id !== tab.id)
      const at = Math.min(Math.max(0, index), others.length)
      others.splice(at, 0, tab)
      this.#workspaces.set(source.id, { ...source, tabs: others })
      this.#emit(source.id, tab)
      return
    }
    this.#setWithoutTab(source, tab)
    const moved = this.#workspace(target.id)
    const tabs = moved.tabs.slice()
    tabs.splice(Math.min(Math.max(0, index), tabs.length), 0, tab)
    this.#workspaces.set(moved.id, { ...moved, tabs, activeTabId: tab.id })
    this.#emit(moved.id, tab)
  }

  split(
    paneId: PaneId,
    direction: SplitDirection,
    kind: PaneKind = 'terminal',
    ratio?: number,
  ): Pane {
    const { workspace, tab } = this.#locate(paneId)
    const newId = this.#deps.ids.pane()
    if (this.#findPane(newId) !== undefined) {
      throw new DomainError('CONFLICT', `id de panel repetido: ${newId}`)
    }
    const pane: Pane = {
      id: newId,
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

  /** Cierra la pestaña y devuelve los paneles que tenía. */
  closeTab(tabId: TabId): PaneId[] {
    const { workspace, tab } = this.#locateTab(tabId)
    this.#removeTab(workspace, tab)
    return tab.panes.map((p) => p.id)
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

  /** Distribución actual de la pestaña que contiene el panel. */
  layoutOfPane(paneId: PaneId): Layout {
    return this.#locate(paneId).tab.layout
  }

  paneContext(paneId: PaneId): { pane: Pane; cwd?: string } | undefined {
    const found = this.#findPane(paneId)
    if (found === undefined) return undefined
    const { workspace, pane } = found
    return { pane, ...(workspace.cwd === undefined ? {} : { cwd: workspace.cwd }) }
  }

  attachTerminal(paneId: PaneId, terminalId: TerminalId): void {
    const { workspace, tab } = this.#locate(paneId)
    this.#updatePane(workspace.id, tab, paneId, (pane) => ({ ...pane, terminalId }), true)
  }

  detachTerminal(paneId: PaneId, terminalId: TerminalId): void {
    const found = this.#findPane(paneId)
    if (found === undefined || found.pane.terminalId !== terminalId) return
    this.#updatePane(
      found.workspace.id,
      found.tab,
      paneId,
      ({ terminalId: _gone, ...pane }) => pane,
      true,
    )
  }

  /** El título cambia sin emitir `layout.changed`: el aviso es el evento `pane.title`. */
  setPaneTitle(paneId: PaneId, title: string): void {
    const found = this.#findPane(paneId)
    if (found === undefined) return
    this.#updatePane(found.workspace.id, found.tab, paneId, (pane) => ({ ...pane, title }), false)
  }

  #updatePane(
    workspaceId: WorkspaceId,
    tab: Tab,
    paneId: PaneId,
    change: (pane: Pane) => Pane,
    emit: boolean,
  ): void {
    const next: Tab = {
      ...tab,
      panes: tab.panes.map((p) => (p.id === paneId ? change(p) : p)),
    }
    if (emit) this.#update(workspaceId, next)
    else this.#store(workspaceId, next)
  }

  #workspace(id: WorkspaceId): Workspace {
    const workspace = this.#workspaces.get(id)
    if (workspace === undefined) throw new LayoutError('NOT_FOUND', `espacio inexistente: ${id}`)
    return workspace
  }

  #findPane(paneId: PaneId): { workspace: Workspace; tab: Tab; pane: Pane } | undefined {
    for (const workspace of this.#workspaces.values()) {
      for (const tab of workspace.tabs) {
        const pane = tab.panes.find((p) => p.id === paneId)
        if (pane !== undefined) return { workspace, tab, pane }
      }
    }
    return undefined
  }

  #findTab(tabId: TabId): { workspace: Workspace; tab: Tab } | undefined {
    for (const workspace of this.#workspaces.values()) {
      const tab = workspace.tabs.find((t) => t.id === tabId)
      if (tab !== undefined) return { workspace, tab }
    }
    return undefined
  }

  #locate(paneId: PaneId): { workspace: Workspace; tab: Tab } {
    const found = this.#findPane(paneId)
    if (found === undefined) throw new LayoutError('NOT_FOUND', `panel inexistente: ${paneId}`)
    return found
  }

  #locateTab(tabId: TabId): { workspace: Workspace; tab: Tab } {
    const found = this.#findTab(tabId)
    if (found === undefined) throw new LayoutError('NOT_FOUND', `pestaña inexistente: ${tabId}`)
    return found
  }

  #store(workspaceId: WorkspaceId, tab: Tab): void {
    const workspace = this.#workspace(workspaceId)
    this.#workspaces.set(workspaceId, {
      ...workspace,
      tabs: workspace.tabs.map((t) => (t.id === tab.id ? tab : t)),
    })
  }

  #update(workspaceId: WorkspaceId, tab: Tab): void {
    this.#store(workspaceId, tab)
    this.#emit(workspaceId, tab)
  }

  /** Quita la pestaña del espacio y reajusta la pestaña activa; no emite. */
  #setWithoutTab(workspace: Workspace, tab: Tab): void {
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
  }

  #removeTab(workspace: Workspace, tab: Tab): void {
    this.#setWithoutTab(workspace, tab)
    this.#emitClosed(workspace.id, tab.id)
  }

  #emitClosed(workspaceId: WorkspaceId, tabId: TabId): void {
    this.#deps.bus.publish({
      event: 'layout.changed',
      data: { workspaceId, tabId, layout: null, focusedPaneId: null, panes: [] },
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
