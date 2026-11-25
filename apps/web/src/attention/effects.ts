import type { PaneId } from '@nexo/contracts'
import { createEffect, on, onCleanup, onMount } from 'solid-js'
import type { AppModel } from '../app/model.tsx'
import { es, format } from '../i18n/es.ts'
import { activeTabOf, findWorkspace } from '../state/store.ts'
import { NotificationCoordinator, type PaneSignal } from './coordinator.ts'
import { type FocusDocument, type FocusTarget, trackWindowFocus } from './focus.ts'

export type AttentionEnv = {
  win: FocusTarget
  doc: FocusDocument & { title: string }
}

/**
 * Lo que hay que mantener vivo mientras la interfaz está montada: foco de la ventana, «visto» de los `done`, título
 * del documento con el contador y el coordinador de notificaciones. Va en un solo sitio para que el orden sea claro.
 */
export function useAttentionEffects(
  model: AppModel,
  env: AttentionEnv = { win: window, doc: document },
): void {
  const { store, ui, actions, attention, notifications } = model

  onMount(() => {
    onCleanup(trackWindowFocus(env.win, env.doc, ui.setWindowFocused))
  })

  // El `done` se da por visto al enfocar el panel con la ventana a la vista (decisión del cliente, no del servidor).
  createEffect(() => {
    if (!ui.windowFocused()) return
    const workspace = findWorkspace(store.state, actions.currentWorkspaceId())
    const tab = activeTabOf(workspace)
    const focused = tab?.panes.find((p) => p.id === tab.focusedPaneId)
    if (focused?.attention === 'done') attention.markSeen(focused.id)
  })
  // Y se olvida al salir de `done`, para que el siguiente sí se muestre.
  createEffect(() => attention.forgetSeen())

  createEffect(() => {
    const n = attention.count()
    env.doc.title = n > 0 ? format(es.attention.documentTitle, { count: n }) : es.appName
  })
  onCleanup(() => {
    env.doc.title = es.appName
  })

  const coordinator = new NotificationCoordinator({
    notifier: notifications.notifier,
    enabled: notifications.enabled,
    windowFocused: ui.windowFocused,
    reveal: (paneId) => void actions.revealPane(paneId as PaneId),
    now: () => Date.now(),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  onCleanup(() => coordinator.dispose())

  createEffect(() => {
    const signals: PaneSignal[] = []
    for (const w of store.state.workspaces) {
      for (const t of w.tabs) {
        const label = `${w.name} · ${t.title === '' ? es.tabs.untitled : t.title}`
        for (const p of t.panes) signals.push({ paneId: p.id, attention: p.attention, label })
      }
    }
    coordinator.observe(signals)
  })
  createEffect(
    on(ui.windowFocused, (focused) => coordinator.focusChanged(focused), { defer: true }),
  )
}
