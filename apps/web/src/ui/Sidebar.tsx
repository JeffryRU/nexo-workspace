import { For, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import { aggregateAttention } from '../layout/tree.ts'
import type { TabState, WorkspaceState } from '../state/model.ts'
import { activeTabOf } from '../state/store.ts'
import { AttentionDot, InlineEdit, useCurrentWorkspaceId } from './parts.tsx'
import './Sidebar.css'

function tabAttention(tab: TabState) {
  return aggregateAttention(tab.panes)
}

function workspaceAttention(w: WorkspaceState) {
  return aggregateAttention(w.tabs.map((t) => ({ attention: tabAttention(t) })))
}

export function Sidebar() {
  const { store, ui, actions } = useModel()
  const current = useCurrentWorkspaceId()

  return (
    <nav class="sidebar" aria-label={es.sidebar.label}>
      <header class="sidebar-header">
        <span class="sidebar-title">{es.sidebar.label}</span>
        <button
          type="button"
          class="icon-button"
          title={es.sidebar.newWorkspace}
          aria-label={es.sidebar.newWorkspace}
          onClick={() => void actions.newWorkspace()}
        >
          +
        </button>
      </header>
      <Show
        when={store.state.workspaces.length > 0}
        fallback={
          <div class="sidebar-empty">
            <p>{es.sidebar.empty}</p>
            <button type="button" class="text-button" onClick={() => void actions.newWorkspace()}>
              {es.sidebar.createFirst}
            </button>
          </div>
        }
      >
        <ul class="ws-list">
          <For each={store.state.workspaces}>
            {(w) => (
              <li class="ws-item" classList={{ active: current() === w.id }}>
                <div class="ws-row">
                  <InlineEdit
                    value={w.name}
                    editing={ui.editing() === `ws:${w.id}`}
                    label={es.sidebar.renameHint}
                    onCommit={(v) => {
                      ui.setEditing(undefined)
                      void actions.renameWorkspace(w.id, v)
                    }}
                    onCancel={() => ui.setEditing(undefined)}
                  >
                    <button
                      type="button"
                      class="ws-name"
                      title={es.sidebar.renameHint}
                      aria-current={current() === w.id ? 'true' : undefined}
                      onClick={() => actions.selectWorkspace(w.id)}
                      onDblClick={() => ui.setEditing(`ws:${w.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'F2') ui.setEditing(`ws:${w.id}`)
                      }}
                    >
                      <AttentionDot attention={workspaceAttention(w)} />
                      <span class="ellipsis">{w.name}</span>
                    </button>
                  </InlineEdit>
                  <button
                    type="button"
                    class="icon-button subtle"
                    title={es.sidebar.closeWorkspace}
                    aria-label={`${es.sidebar.closeWorkspace}: ${w.name}`}
                    onClick={() => void actions.closeWorkspace(w.id)}
                  >
                    ×
                  </button>
                </div>
                <ul class="tab-list">
                  <For each={w.tabs}>
                    {(t) => (
                      <li class="tab-item">
                        <button
                          type="button"
                          class="tab-row"
                          classList={{ active: current() === w.id && activeTabOf(w)?.id === t.id }}
                          onClick={() => void actions.selectTab(w.id, t.id)}
                        >
                          <AttentionDot attention={tabAttention(t)} />
                          <span class="ellipsis">
                            {t.title === '' ? es.tabs.untitled : t.title}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </nav>
  )
}
