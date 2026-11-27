import { useQuery } from '@tanstack/solid-query'
import { createEffect, createMemo, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { type AppModel, ModelProvider } from './app/model.tsx'
import { useAttentionEffects } from './attention/effects.ts'
import type { InfoFailure } from './daemon/info.ts'
import { HistoryDialog, HistoryToggle } from './history/HistoryDialog.tsx'
import { es } from './i18n/es.ts'
import { paneIdsOf } from './layout/tree.ts'
import { LimitsIndicator } from './limits/LimitsIndicator.tsx'
import { MemoryDialog, MemoryToggle } from './memory/MemoryDialog.tsx'
import { useMemoryEvents } from './memory/queries.ts'
import { installShortcuts } from './shortcuts/handler.ts'
import {
  ConnectionScreen,
  HelpDialog,
  NoDaemonScreen,
  ReconnectBanner,
  SearchBar,
  Toast,
} from './ui/Overlays.tsx'
import { NotificationToggle } from './ui/parts.tsx'
import { Sidebar } from './ui/Sidebar.tsx'
import { Stage } from './ui/Stage.tsx'
import { TabBar } from './ui/TabBar.tsx'
import './styles/app.css'

export type AppProps =
  | { kind: 'no-daemon'; reason: InfoFailure; onRetry: () => void }
  | { kind: 'ready'; model: AppModel }

export function App(props: { state: AppProps | undefined }) {
  return (
    <Switch>
      <Match when={props.state?.kind === 'ready' && (props.state as { model: AppModel }).model}>
        {(model) => (
          <ModelProvider value={model()}>
            <Workbench model={model()} />
          </ModelProvider>
        )}
      </Match>
      <Match
        when={
          props.state?.kind === 'no-daemon' &&
          (props.state as { reason: InfoFailure; onRetry: () => void })
        }
      >
        {(p) => <NoDaemonScreen reason={p().reason} onRetry={p().onRetry} />}
      </Match>
    </Switch>
  )
}

function Workbench(props: { model: AppModel }) {
  const { store, status, sessions, agents, request } = props.model
  // Hasta tener el primer snapshot no hay nada que mostrar salvo el estado de la conexión.
  const everOpened = createMemo<boolean>((was) => was || status() === 'open', false)

  useAttentionEffects(props.model)
  useMemoryEvents()
  onMount(() => {
    const stop = installShortcuts(props.model)
    onCleanup(stop)
  })
  onCleanup(() => {
    sessions.disposeAll()
    agents.disposeAll()
  })

  // Libera las terminales de paneles que ya no existen.
  createEffect(() => {
    const live = new Set<string>()
    for (const w of store.state.workspaces) {
      for (const t of w.tabs) for (const id of paneIdsOf(t.layout)) live.add(id)
    }
    sessions.prune(live)
    agents.prune(live)
  })

  const info = useQuery(() => ({
    queryKey: ['daemon.info', status() === 'open'],
    queryFn: () => request('daemon.info', {}),
    enabled: status() === 'open',
    staleTime: Number.POSITIVE_INFINITY,
  }))

  return (
    <Show when={everOpened()} fallback={<ConnectionScreen />}>
      <div class="workbench">
        <Sidebar />
        <div class="main">
          <TabBar />
          <Stage />
          <SearchBar />
          <footer class="statusbar">
            <span>{es.appName}</span>
            <LimitsIndicator />
            <HistoryToggle />
            <MemoryToggle />
            <NotificationToggle />
            <Show when={info.data}>{(d) => <span class="muted">v{d().version}</span>}</Show>
          </footer>
        </div>
        <ReconnectBanner />
        <HelpDialog />
        <MemoryDialog />
        <HistoryDialog />
        <Toast />
      </div>
    </Show>
  )
}
