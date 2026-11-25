import type { PaneId } from '@nexo/contracts'
import type { AppModel } from '../app/model.tsx'
import { type Direction, neighborPane } from '../layout/tree.ts'
import { activeTabOf, findWorkspace } from '../state/store.ts'
import { GOTO_ACTIONS, matchShortcut, type ShortcutAction } from './keymap.ts'

const DIRECTIONS: Partial<Record<ShortcutAction, Direction>> = {
  'pane.focus-left': 'left',
  'pane.focus-right': 'right',
  'pane.focus-up': 'up',
  'pane.focus-down': 'down',
}

/** Ejecuta la acción de un atajo sobre el estado actual. */
export function runShortcut(action: ShortcutAction, model: AppModel): void {
  const { store, ui, actions } = model
  const state = store.snapshot()
  const workspace = findWorkspace(state, actions.currentWorkspaceId())
  const tab = activeTabOf(workspace)
  const focused = tab?.focusedPaneId ?? undefined

  const goToTab = (index: number) => {
    const target = workspace?.tabs[index]
    if (workspace !== undefined && target !== undefined)
      void actions.selectTab(workspace.id, target.id)
  }
  const cycle = (step: number) => {
    if (workspace === undefined || tab === undefined) return
    const i = workspace.tabs.findIndex((t) => t.id === tab.id)
    const n = workspace.tabs.length
    goToTab((i + step + n) % n)
  }

  const direction = DIRECTIONS[action]
  if (direction !== undefined) {
    if (tab === undefined || focused === undefined) return
    const next = neighborPane(tab.layout, focused, direction)
    if (next !== undefined) void actions.focusPane(next)
    return
  }
  const gotoIndex = GOTO_ACTIONS.indexOf(action)
  if (gotoIndex >= 0) {
    goToTab(gotoIndex)
    return
  }

  switch (action) {
    case 'tab.new':
      void actions.newTab(workspace?.id)
      return
    case 'pane.close':
      if (focused !== undefined) void actions.closePane(focused as PaneId)
      return
    case 'pane.split-right':
      if (focused !== undefined) void actions.splitPane(focused as PaneId, 'row')
      return
    case 'pane.split-down':
      if (focused !== undefined) void actions.splitPane(focused as PaneId, 'column')
      return
    case 'tab.next':
      cycle(1)
      return
    case 'tab.prev':
      cycle(-1)
      return
    case 'terminal.search':
      ui.setSearchOpen(!ui.searchOpen())
      return
    case 'help.toggle':
      ui.setHelpOpen(!ui.helpOpen())
      return
    default:
      return
  }
}

/** Escucha el teclado (en captura) y consume solo lo que el mapa de atajos reconoce. */
export function installShortcuts(
  model: AppModel,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const onKeyDown = (event: Event) => {
    const e = event as KeyboardEvent
    const el = e.target instanceof Element ? e.target : null
    const inTerminal = el?.closest('.xterm') != null
    const inEditable =
      !inTerminal &&
      el !== null &&
      (el.matches('input, textarea, select') || (el as HTMLElement).isContentEditable)
    const action = matchShortcut(e, model.ui.keymap, { inTerminal, inEditable })
    if (action === undefined) return
    e.preventDefault()
    e.stopPropagation()
    runShortcut(action, model)
  }
  target.addEventListener('keydown', onKeyDown, true)
  return () => target.removeEventListener('keydown', onKeyDown, true)
}
