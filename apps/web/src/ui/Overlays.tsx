import { createEffect, For, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import type { InfoFailure } from '../daemon/info.ts'
import { es } from '../i18n/es.ts'
import type { ShortcutAction } from '../shortcuts/keymap.ts'
import { useCurrentTab } from './parts.tsx'
import './Overlays.css'

const NO_INFO_TEXT: Record<InfoFailure, string> = {
  'missing-token': es.status.noInfo.missingToken,
  'invalid-port': es.status.noInfo.invalidPort,
  'invalid-token': es.status.noInfo.invalidToken,
  'tauri-error': es.status.noInfo.tauri,
}

/** Pantalla completa cuando no hay datos del daemon. */
export function NoDaemonScreen(props: { reason: InfoFailure; onRetry: () => void }) {
  return (
    <main class="status-screen" role="alert">
      <h1>{es.status.noInfo.title}</h1>
      <p>{NO_INFO_TEXT[props.reason]}</p>
      <button type="button" class="text-button" onClick={props.onRetry}>
        {es.status.retry}
      </button>
    </main>
  )
}

/** Pantalla de estado mientras se conecta o si no hay conexión; con reconexión automática. */
export function ConnectionScreen() {
  const { status, failure, retry } = useModel()
  return (
    <main class="status-screen" role="status" aria-live="polite" data-status={status()}>
      <h1>{es.appName}</h1>
      <p>
        {status() === 'connecting'
          ? es.status.connecting
          : status() === 'reconnecting'
            ? es.status.reconnecting
            : es.status.offline}
      </p>
      <Show when={status() === 'offline'}>
        <p class="muted">{failure() === 'closed' ? es.status.closed : es.status.unreachable}</p>
        <button type="button" class="text-button" onClick={() => void retry()}>
          {es.status.retry}
        </button>
      </Show>
    </main>
  )
}

/** Franja sobre la interfaz cuando se pierde la conexión pero ya había estado. */
export function ReconnectBanner() {
  const { status, retry } = useModel()
  return (
    <Show when={status() === 'reconnecting' || status() === 'offline'}>
      <div class="banner" role="status" aria-live="polite">
        <span>{status() === 'reconnecting' ? es.status.reconnecting : es.status.offline}</span>
        <Show when={status() === 'offline'}>
          <button type="button" class="text-button" onClick={() => void retry()}>
            {es.status.retry}
          </button>
        </Show>
      </div>
    </Show>
  )
}

export function Toast() {
  const { ui } = useModel()
  return (
    <Show when={ui.error()}>
      {(message) => (
        <div class="toast" role="alert">
          <span>{message()}</span>
          <button type="button" class="text-button" onClick={() => ui.dismissError()}>
            {es.errors.dismiss}
          </button>
        </div>
      )}
    </Show>
  )
}

const HELP_ORDER = [
  'tab.new',
  'pane.close',
  'pane.split-right',
  'pane.split-down',
  'pane.focus-left',
  'pane.focus-right',
  'pane.focus-up',
  'pane.focus-down',
  'tab.next',
  'tab.prev',
  'terminal.search',
  'help.toggle',
] as const satisfies readonly ShortcutAction[]

export function HelpDialog() {
  const { ui } = useModel()
  let dialog!: HTMLDivElement
  createEffect(() => {
    if (ui.helpOpen()) dialog?.focus()
  })
  return (
    <Show when={ui.helpOpen()}>
      <div class="modal-backdrop">
        <div
          ref={dialog}
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-label={es.help.title}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') ui.setHelpOpen(false)
          }}
        >
          <h2>{es.help.title}</h2>
          <dl class="shortcut-list">
            <For each={HELP_ORDER}>
              {(action) => (
                <>
                  <dt>{es.shortcuts[action]}</dt>
                  <dd>
                    <For each={ui.keymap[action]}>{(combo) => <kbd>{combo}</kbd>}</For>
                  </dd>
                </>
              )}
            </For>
            <dt>{es.shortcuts['tab.goto']}</dt>
            <dd>
              <kbd>{ui.keymap['tab.goto-1'][0] ?? 'Alt+1'}</kbd>
            </dd>
          </dl>
          <p class="muted">{es.help.hint}</p>
          <button type="button" class="text-button" onClick={() => ui.setHelpOpen(false)}>
            {es.help.close}
          </button>
        </div>
      </div>
    </Show>
  )
}

export function SearchBar() {
  const { ui, sessions } = useModel()
  const tab = useCurrentTab()
  let input!: HTMLInputElement
  createEffect(() => {
    if (ui.searchOpen()) input?.focus()
  })
  const session = () => {
    const id = tab()?.focusedPaneId
    return id === null || id === undefined ? undefined : sessions.get(id)
  }
  const close = () => {
    session()?.clearSearch()
    ui.setSearchOpen(false)
    session()?.focus()
  }
  return (
    <Show when={ui.searchOpen()}>
      <search class="searchbar" aria-label={es.search.label}>
        <input
          ref={input}
          type="search"
          placeholder={es.search.placeholder}
          aria-label={es.search.label}
          onInput={(e) => session()?.find(e.currentTarget.value, 'next')}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') close()
            else if (e.key === 'Enter') {
              session()?.find(e.currentTarget.value, e.shiftKey ? 'prev' : 'next')
            }
          }}
        />
        <button
          type="button"
          class="icon-button subtle"
          aria-label={es.search.previous}
          title={es.search.previous}
          onClick={() => session()?.find(input.value, 'prev')}
        >
          ↑
        </button>
        <button
          type="button"
          class="icon-button subtle"
          aria-label={es.search.next}
          title={es.search.next}
          onClick={() => session()?.find(input.value, 'next')}
        >
          ↓
        </button>
        <button
          type="button"
          class="icon-button subtle"
          aria-label={es.search.close}
          title={es.search.close}
          onClick={close}
        >
          ×
        </button>
      </search>
    </Show>
  )
}
