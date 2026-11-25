import { For, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import { aggregateAttention } from '../layout/tree.ts'
import { findWorkspace } from '../state/store.ts'
import { AttentionDot, InlineEdit, useCurrentWorkspaceId } from './parts.tsx'
import './TabBar.css'

export const tabDomId = (tabId: string) => `tab-${tabId}`
export const panelDomId = (tabId: string) => `tabpanel-${tabId}`

export function TabBar() {
  const { store, ui, actions } = useModel()
  const currentId = useCurrentWorkspaceId()
  const workspace = () => findWorkspace(store.state, currentId())

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

  return (
    <div class="tabbar">
      <div class="tablist" role="tablist" aria-label={es.tabs.label}>
        <Show when={workspace()}>
          {(w) => (
            <For each={w().tabs}>
              {(t, i) => {
                const selected = () => (w().activeTabId ?? w().tabs[0]?.id) === t.id
                return (
                  <div class="tab-wrap" classList={{ selected: selected() }}>
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
                        <AttentionDot attention={aggregateAttention(t.panes)} />
                        <span class="ellipsis">{t.title === '' ? es.tabs.untitled : t.title}</span>
                      </button>
                    </InlineEdit>
                    <button
                      type="button"
                      class="icon-button subtle tab-close"
                      title={es.tabs.closeTab}
                      aria-label={`${es.tabs.closeTab}: ${t.title}`}
                      onClick={() => void actions.closeTab(t.id)}
                    >
                      ×
                    </button>
                  </div>
                )
              }}
            </For>
          )}
        </Show>
      </div>
      <button
        type="button"
        class="icon-button"
        title={es.tabs.newTab}
        aria-label={es.tabs.newTab}
        onClick={() => void actions.newTab()}
      >
        +
      </button>
    </div>
  )
}
