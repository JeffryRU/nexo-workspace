import type { MethodParams, MethodResult, PaneId } from '@nexo/contracts'
import type { LayoutService } from './layout-service.ts'
import type { TerminalService } from './terminal-service.ts'

/** Lo que `WorkspaceService` necesita del servicio de agentes: cerrar la sesión de un panel que se cierra. */
export interface AgentPaneCloser {
  closePane(paneId: PaneId): void
}

export type WorkspaceServiceDeps = {
  layout: LayoutService
  terminals: TerminalService
  /** Sin él (daemon sin proveedores) no hay sesiones de agente que cerrar. */
  agents?: AgentPaneCloser
}

/**
 * Casos de uso `workspace.*`, `tab.*` y `pane.*`. Envuelve a `LayoutService` (dueño del estado)
 * para que cerrar un panel, una pestaña o un espacio mate también sus terminales: nunca quedan
 * terminales sin panel.
 */
export class WorkspaceService {
  readonly #layout: LayoutService
  readonly #terminals: TerminalService
  readonly #agents: AgentPaneCloser | undefined

  constructor(deps: WorkspaceServiceDeps) {
    this.#layout = deps.layout
    this.#terminals = deps.terminals
    this.#agents = deps.agents
  }

  list(): MethodResult<'workspace.list'> {
    return { workspaces: this.#layout.snapshot() }
  }

  create(params: MethodParams<'workspace.create'>): MethodResult<'workspace.create'> {
    return { workspace: this.#layout.createWorkspace(params.name, params.cwd) }
  }

  rename(params: MethodParams<'workspace.rename'>): MethodResult<'workspace.rename'> {
    this.#layout.renameWorkspace(params.workspaceId, params.name)
    return {}
  }

  close(params: MethodParams<'workspace.close'>): MethodResult<'workspace.close'> {
    this.#killPanes(this.#layout.closeWorkspace(params.workspaceId))
    return {}
  }

  createTab(params: MethodParams<'tab.create'>): MethodResult<'tab.create'> {
    return { tab: this.#layout.createTab(params.workspaceId, params.title) }
  }

  closeTab(params: MethodParams<'tab.close'>): MethodResult<'tab.close'> {
    this.#killPanes(this.#layout.closeTab(params.tabId))
    return {}
  }

  focusTab(params: MethodParams<'tab.focus'>): MethodResult<'tab.focus'> {
    this.#layout.focusTab(params.tabId)
    return {}
  }

  moveTab(params: MethodParams<'tab.move'>): MethodResult<'tab.move'> {
    this.#layout.moveTab(params.tabId, params.index, params.workspaceId)
    return {}
  }

  renameTab(params: MethodParams<'tab.rename'>): MethodResult<'tab.rename'> {
    this.#layout.renameTab(params.tabId, params.title)
    return {}
  }

  split(params: MethodParams<'pane.split'>): MethodResult<'pane.split'> {
    const pane = this.#layout.split(params.paneId, params.direction, params.kind, params.ratio)
    return { pane, layout: this.#layout.layoutOfPane(pane.id) }
  }

  closePane(params: MethodParams<'pane.close'>): MethodResult<'pane.close'> {
    this.#layout.closePane(params.paneId)
    this.#terminals.closePane(params.paneId)
    this.#agents?.closePane(params.paneId)
    return {}
  }

  focusPane(params: MethodParams<'pane.focus'>): MethodResult<'pane.focus'> {
    this.#layout.focusPane(params.paneId)
    return {}
  }

  resizePane(params: MethodParams<'pane.resize'>): MethodResult<'pane.resize'> {
    if ('paneId' in params) {
      return { layout: this.#layout.resizePane(params.paneId, params.delta) }
    }
    return {
      layout: this.#layout.resizeBoundaryAt(params.tabId, params.path, params.index, params.delta),
    }
  }

  swapPanes(params: MethodParams<'pane.swap'>): MethodResult<'pane.swap'> {
    return { layout: this.#layout.swapPanes(params.paneId, params.otherPaneId) }
  }

  #killPanes(paneIds: readonly PaneId[]): void {
    for (const id of paneIds) {
      this.#terminals.closePane(id)
      this.#agents?.closePane(id)
    }
  }
}
