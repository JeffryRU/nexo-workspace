import { For, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import { LayoutView } from './PaneTree.tsx'
import { useCurrentWorkspaceId } from './parts.tsx'
import { panelDomId, tabDomId } from './TabBar.tsx'
import { VisibilityContext } from './visibility.ts'
import './Stage.css'

/**
 * Todas las pestañas de todos los espacios se montan y se ocultan con `hidden` (display: none): no se
 * desmontan al cambiar, así las terminales conservan su estado y el cambio de pestaña es solo CSS.
 */
export function Stage() {
  const { store } = useModel()
  const current = useCurrentWorkspaceId()
  return (
    <div class="stage">
      <For each={store.state.workspaces}>
        {(w) => (
          <For each={w.tabs}>
            {(t) => {
              const visible = () => current() === w.id && (w.activeTabId ?? w.tabs[0]?.id) === t.id
              return (
                <div
                  class="tab-panel"
                  role="tabpanel"
                  id={panelDomId(t.id)}
                  aria-labelledby={tabDomId(t.id)}
                  hidden={!visible()}
                >
                  <VisibilityContext.Provider value={visible}>
                    <Show when={t.layout}>
                      {(layout) => <LayoutView node={layout()} tabId={t.id} path={[]} />}
                    </Show>
                  </VisibilityContext.Provider>
                </div>
              )
            }}
          </For>
        )}
      </For>
      <Show when={store.state.workspaces.length > 0 && current() !== undefined}>
        <Show when={store.state.workspaces.find((w) => w.id === current())?.tabs.length === 0}>
          <p class="stage-empty">{es.tabs.emptyWorkspace}</p>
        </Show>
      </Show>
    </div>
  )
}
