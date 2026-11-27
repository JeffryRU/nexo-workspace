import { createEffect, For, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import { findWorkspace } from '../state/store.ts'
import { Icon } from './Icon.tsx'
import { AttentionCount, AttentionDot, InlineEdit, useCurrentWorkspaceId } from './parts.tsx'
import './TabBar.css'

export const tabDomId = (tabId: string) => `tab-${tabId}`
export const panelDomId = (tabId: string) => `tabpanel-${tabId}`
export const SIDE_COLUMN_ID = 'side-column'

export function TabBar() {
  const { store, ui, actions, attention, settings } = useModel()
  const currentId = useCurrentWorkspaceId()
  const workspace = () => findWorkspace(store.state, currentId())
  const selectedId = () => {
    const w = workspace()
    return w === undefined ? undefined : (w.activeTabId ?? w.tabs[0]?.id)
  }

  // La pestaña activa siempre queda a la vista, aunque haya cientos y la barra se desplace.
  createEffect(() => {
    const id = selectedId()
    if (id === undefined) return
    // Tras el pintado: una pestaña recién creada todavía no está en el DOM en este instante.
    const later = globalThis.requestAnimationFrame ?? queueMicrotask
    later(() => {
      // Se desplaza la pestaña entera (con su botón de cerrar), no solo el botón del título.
      document
        .getElementById(tabDomId(id))
        ?.closest('.tab-wrap')
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
  })

  const sidebarOpen = () => (ui.narrow() ? ui.drawerOpen() : !settings.sidebarCollapsed())
  const toggleSidebar = () => {
    if (ui.narrow()) ui.setDrawerOpen(!ui.drawerOpen())
    else settings.setSidebarCollapsed(!settings.sidebarCollapsed())
  }

  const move = (e: KeyboardEvent, index: number) => {
    const w = workspace()
    if (w === undefined || w.tabs.length === 0) return
    let next = index
    if (e.key === 'ArrowRight') next = (index + 1) % w.tabs.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + w.tabs.length) % w.tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = w.tabs.length - 1
    else return
    e.preventDefault()
    const tab = w.tabs[next]
    if (tab === undefined) return
    void actions.selectTab(w.id, tab.id)
    queueMicrotask(() => document.getElementById(tabDomId(tab.id))?.focus())
  }

  const label = () => (sidebarOpen() ? es.sidebar.hide : es.sidebar.show)

  return (
    <div class="tabbar">
      <button
        type="button"
        class="icon-button sidebar-toggle"
        classList={{ active: sidebarOpen() }}
        title={label()}
        aria-label={label()}
        aria-expanded={sidebarOpen()}
        aria-controls={SIDE_COLUMN_ID}
        onClick={toggleSidebar}
      >
        <Icon name="panel-left" />
      </button>
      <div class="tablist" role="tablist" aria-label={es.tabs.label}>
        <Show when={workspace()}>
          {(w) => (
            <For each={w().tabs}>
              {(t, i) => {
                const selected = () => selectedId() === t.id
                return (
                  <div
                    class="tab-wrap"
                    classList={{ selected: selected() }}
                    data-attention={attention.tabAttention(t)}
                  >
                    <InlineEdit
                      value={t.title}
                      editing={ui.editing() === `tab:${t.id}`}
                      label={es.tabs.label}
                      onCommit={(v) => {
                        ui.setEditing(undefined)
                        void actions.renameTab(t.id, v)
                      }}
                      onCancel={() => ui.setEditing(undefined)}
                    >
                      <button
                        type="button"
                        role="tab"
                        id={tabDomId(t.id)}
                        class="tab"
                        title={t.title === '' ? es.tabs.untitled : t.title}
                        aria-selected={selected()}
                        aria-controls={panelDomId(t.id)}
                        tabIndex={selected() ? 0 : -1}
                        onClick={() => void actions.selectTab(w().id, t.id)}
                        onDblClick={() => ui.setEditing(`tab:${t.id}`)}
                        onKeyDown={(e) => {
                          if (e.key === 'F2') ui.setEditing(`tab:${t.id}`)
                          else move(e, i())
                        }}
                      >
                        <AttentionDot attention={attention.tabAttention(t)} />
                        <span class="ellipsis">{t.title === '' ? es.tabs.untitled : t.title}</span>
                        <AttentionCount count={attention.tabPending(t)} />
                      </button>
                    </InlineEdit>
                    <button
                      type="button"
                      class="icon-button subtle tab-close"
                      title={es.tabs.closeTab}
                      aria-label={`${es.tabs.closeTab}: ${t.title}`}
                      onClick={() => void actions.closeTab(t.id)}
                    >
                      <Icon name="x" size="sm" />
                    </button>
                  </div>
                )
              }}
            </For>
          )}
        </Show>
      </div>
      <div class="tabbar-actions">
        <button
          type="button"
          class="icon-button"
          title={es.tabs.newTab}
          aria-label={es.tabs.newTab}
          onClick={() => void actions.newTab()}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          class="icon-button"
          title={`${es.agent.newTab} (${ui.keymap['agent.new-tab'][0] ?? ''})`}
          aria-label={es.agent.newTab}
          onClick={() => void actions.newAgentTab()}
        >
          <Icon name="sparkle" />
        </button>
      </div>
    </div>
  )
}
