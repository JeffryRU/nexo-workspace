import type { PaneId } from '@nexo/contracts'
import { createMemo, Match, Show, Switch } from 'solid-js'
import { AgentPanel } from '../agent/AgentPanel.tsx'
import { MarkdownEnvContext } from '../agent/markdown.tsx'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import { findPaneTab } from '../state/store.ts'
import { paneTitle } from '../terminal/title.ts'
import { ViewerPane } from '../viewer/ViewerPane.tsx'
import { Icon } from './Icon.tsx'
import { AttentionDot } from './parts.tsx'
import { TerminalView } from './TerminalView.tsx'
import './PaneView.css'

export function PaneView(props: { paneId: PaneId }) {
  const { store, ui, actions, attention } = useModel()
  const located = createMemo(() => findPaneTab(store.state, props.paneId))
  const pane = () => located()?.tab.panes.find((p) => p.id === props.paneId)
  const focused = () => located()?.tab.focusedPaneId === props.paneId
  const isAgent = () => pane()?.kind === 'agent'
  const isViewer = () => pane()?.kind === 'viewer'
  const title = () => {
    const t = paneTitle(pane()?.title ?? '')
    if (t.label !== '') return t
    const fallback = isAgent() ? es.agent.paneTitle : isViewer() ? es.viewer.paneTitle : undefined
    return fallback === undefined ? t : { label: fallback, full: fallback }
  }
  // Los enlaces a archivos del texto del agente se abren en el visor, relativos a la carpeta del espacio.
  const agentEnv = createMemo(() => ({
    baseDir: located()?.workspace.cwd,
    openFile: (path: string) => void actions.openInViewer(props.paneId, path),
  }))
  const swapping = () => ui.swapSource() !== undefined

  const swap = () => {
    const source = ui.swapSource()
    if (source === undefined) ui.setSwapSource(props.paneId)
    else {
      ui.setSwapSource(undefined)
      void actions.swapPanes(source as PaneId, props.paneId)
    }
  }

  return (
    <Show when={pane()}>
      {(p) => (
        <section
          class="pane"
          classList={{ focused: focused(), 'swap-source': ui.swapSource() === props.paneId }}
          data-pane-id={props.paneId}
          data-attention={attention.paneAttention(props.paneId, p().attention)}
          aria-label={title().label}
          onPointerDown={() => void actions.focusPane(props.paneId)}
          onFocusIn={() => void actions.focusPane(props.paneId)}
        >
          <header class="pane-header">
            <AttentionDot attention={attention.paneAttention(props.paneId, p().attention)} />
            <span class="pane-title ellipsis" title={title().full}>
              {title().label}
            </span>
            <span class="pane-actions">
              <button
                type="button"
                class="icon-button subtle"
                data-tertiary="true"
                title={es.pane.splitRight}
                aria-label={es.pane.splitRight}
                onClick={() => void actions.splitPane(props.paneId, 'row')}
              >
                <Icon name="split-right" />
              </button>
              <button
                type="button"
                class="icon-button subtle"
                data-secondary="true"
                title={es.agent.splitWithAgent}
                aria-label={es.agent.splitWithAgent}
                onClick={() => void actions.splitAgent(props.paneId, 'row')}
              >
                <Icon name="sparkle" />
              </button>
              <button
                type="button"
                class="icon-button subtle"
                data-tertiary="true"
                title={es.pane.splitDown}
                aria-label={es.pane.splitDown}
                onClick={() => void actions.splitPane(props.paneId, 'column')}
              >
                <Icon name="split-down" />
              </button>
              <button
                type="button"
                class="icon-button subtle"
                data-secondary="true"
                classList={{ active: swapping() }}
                title={swapping() ? es.pane.swapPending : es.pane.swap}
                aria-label={es.pane.swap}
                aria-pressed={ui.swapSource() === props.paneId}
                onClick={swap}
              >
                <Icon name="swap" />
              </button>
              <button
                type="button"
                class="icon-button subtle"
                title={es.pane.close}
                aria-label={es.pane.close}
                onClick={() => void actions.closePane(props.paneId)}
              >
                <Icon name="x" />
              </button>
            </span>
          </header>
          <Switch
            fallback={
              <TerminalView
                paneId={props.paneId}
                terminalId={p().terminalId}
                exit={
                  p().terminalId === undefined
                    ? undefined
                    : store.state.exits[p().terminalId as string]
                }
                focused={focused()}
              />
            }
          >
            <Match when={p().kind === 'agent'}>
              <MarkdownEnvContext.Provider value={agentEnv()}>
                <AgentPanel
                  paneId={props.paneId}
                  sessionId={p().agentSessionId}
                  defaultCwd={located()?.workspace.cwd}
                  focused={focused()}
                />
              </MarkdownEnvContext.Provider>
            </Match>
            <Match when={p().kind === 'viewer'}>
              <ViewerPane paneId={props.paneId} path={p().viewerPath} />
            </Match>
          </Switch>
        </section>
      )}
    </Show>
  )
}
