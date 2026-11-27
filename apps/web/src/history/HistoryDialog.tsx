import type { HistoryProject, HistorySession } from '@nexo/contracts'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { AgentModelContext, BlockView } from '../agent/blocks.tsx'
import { MarkdownEnvContext } from '../agent/markdown.tsx'
import { useModel } from '../app/model.tsx'
import { es, format } from '../i18n/es.ts'
import { useHistoryBlocks, useHistoryList, useProviderNames } from './queries.ts'
import { createReadOnlyModel } from './readonly-model.ts'
import {
  capSessions,
  countSessions,
  filterProjects,
  formatLocalWhen,
  MAX_RENDERED_SESSIONS,
  providerNotice,
  sessionTitle,
  toBlock,
} from './view.ts'
import './history.css'

type Picked = {
  provider: string
  sessionId: string
  cwd?: string
  title: string
  session: HistorySession
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Botón de la barra de estado que abre el historial. */
export function HistoryToggle() {
  const app = useModel()
  return (
    <button
      type="button"
      class="status-toggle history-toggle"
      title={es.history.openHint}
      aria-haspopup="dialog"
      onClick={() => app.ui.setHistoryOpen(true)}
    >
      {es.history.open}
    </button>
  )
}

/**
 * Historial de los proveedores (F4.5): sesiones anteriores agrupadas por carpeta, con filtro por proveedor, búsqueda
 * y paginación incremental, y la lectura de una sesión antigua. Todo lo que viene del historial (títulos, carpetas,
 * mensajes) es dato ajeno: los títulos se pintan como texto plano y los bloques con el render seguro del panel.
 */
export function HistoryDialog() {
  const app = useModel()
  let dialog!: HTMLDivElement
  const [picked, setPicked] = createSignal<Picked | undefined>()
  createEffect(() => {
    if (app.ui.historyOpen()) dialog?.focus()
    else setPicked(undefined)
  })
  const close = () => app.ui.setHistoryOpen(false)

  return (
    <Show when={app.ui.historyOpen()}>
      <div class="modal-backdrop">
        <div
          ref={dialog}
          class="modal history-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={es.history.title}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            if (picked() === undefined) close()
            else setPicked(undefined)
          }}
        >
          <header class="history-head">
            <h2>{es.history.title}</h2>
            <button type="button" class="text-button" onClick={close}>
              {es.history.close}
            </button>
          </header>
          <Show when={picked()} fallback={<HistoryList onPick={setPicked} onResumed={close} />}>
            {(p) => (
              <SessionView picked={p()} onBack={() => setPicked(undefined)} onResumed={close} />
            )}
          </Show>
        </div>
      </div>
    </Show>
  )
}

/** Reanuda y, si el daemon creó la sesión, cierra la ventana. */
function useResume(onResumed: () => void) {
  const app = useModel()
  const [busy, setBusy] = createSignal(false)
  const resume = async (s: HistorySession) => {
    if (busy() || !s.resumable) return
    setBusy(true)
    try {
      const ok = await app.actions.resumeInNewTab({
        provider: s.provider,
        sessionId: s.sessionId,
        cwd: s.cwd,
      })
      if (ok) onResumed()
    } finally {
      setBusy(false)
    }
  }
  return { busy, resume }
}

function HistoryList(props: { onPick: (p: Picked) => void; onResumed: () => void }) {
  const [provider, setProvider] = createSignal<string | undefined>()
  const [query, setQuery] = createSignal('')
  const names = useProviderNames()
  const list = useHistoryList(provider)
  const { busy, resume } = useResume(props.onResumed)

  const filtered = createMemo(() => filterProjects(list.projects(), query()))
  const total = createMemo(() => countSessions(filtered()))
  const shown = createMemo(() => capSessions(filtered(), MAX_RENDERED_SESSIONS))
  const notices = createMemo(() =>
    list
      .statuses()
      .map((s) => providerNotice(s, names.name))
      .filter((n): n is string => n !== undefined),
  )
  const loaded = () => list.query.data !== undefined
  const hasNext = () => list.query.hasNextPage === true

  return (
    <div class="history-body">
      <div class="history-toolbar">
        <label class="history-field">
          <span>{es.history.providerFilter}</span>
          <select
            aria-label={es.history.providerFilter}
            onChange={(e) =>
              setProvider(e.currentTarget.value === '' ? undefined : e.currentTarget.value)
            }
          >
            <option value="">{es.history.allProviders}</option>
            <For each={names.providers()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
          </select>
        </label>
        <label class="history-field history-search">
          <span class="sr-only">{es.history.search}</span>
          <input
            type="search"
            aria-label={es.history.search}
            placeholder={es.history.searchPlaceholder}
            maxLength={200}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
      </div>
      <Show when={hasNext() && query().trim() !== ''}>
        <p class="muted history-hint">{es.history.searchHint}</p>
      </Show>

      <Show when={list.query.isPending}>
        <p class="muted" role="status">
          {es.history.loading}
        </p>
      </Show>
      <Show when={list.query.isError}>
        <p class="history-error" role="alert">
          {format(es.history.loadFailed, { message: errorText(list.query.error) })}{' '}
          <button type="button" class="text-button" onClick={() => void list.query.refetch()}>
            {es.history.retry}
          </button>
        </p>
      </Show>
      <For each={notices()}>
        {(n) => (
          <p class="history-notice" role="status">
            {n}
          </p>
        )}
      </For>

      <Show when={loaded() && total() === 0 && !list.query.isPending}>
        <p class="muted" role="status">
          {query().trim() === '' ? es.history.empty : es.history.emptyFiltered}
        </p>
      </Show>
      <Show when={total() > MAX_RENDERED_SESSIONS}>
        <p class="muted" role="status">
          {format(es.history.capped, { shown: MAX_RENDERED_SESSIONS, total: total() })}
        </p>
      </Show>

      <div class="history-projects">
        <For each={shown()}>
          {(project) => (
            <ProjectGroup
              project={project}
              providerName={names.name}
              busy={busy()}
              onPick={props.onPick}
              onResume={(s) => void resume(s)}
            />
          )}
        </For>
      </div>

      <Show when={hasNext()}>
        <button
          type="button"
          class="text-button history-more"
          disabled={list.query.isFetchingNextPage}
          aria-busy={list.query.isFetchingNextPage}
          onClick={() => void list.query.fetchNextPage()}
        >
          {list.query.isFetchingNextPage ? es.history.loadingMore : es.history.loadMore}
        </button>
      </Show>
    </div>
  )
}

function ProjectGroup(props: {
  project: HistoryProject
  providerName: (id: string) => string
  busy: boolean
  onPick: (p: Picked) => void
  onResume: (s: HistorySession) => void
}) {
  const heading = () => props.project.name || es.history.noFolder
  return (
    <section class="history-project" aria-label={heading()}>
      <h3 class="ellipsis" title={props.project.cwd ?? es.history.noFolder}>
        {heading()}
        <Show when={props.project.cwd}>
          {(cwd) => <span class="history-cwd muted">{cwd()}</span>}
        </Show>
      </h3>
      <ul class="history-sessions">
        <For each={props.project.sessions}>
          {(s) => (
            <li class="history-session" data-provider={s.provider}>
              <div class="history-session-main">
                <span class="history-session-title ellipsis" title={sessionTitle(s)}>
                  {sessionTitle(s)}
                </span>
                <span class="history-session-meta muted">
                  <span class="history-tag">{props.providerName(s.provider)}</span>
                  {` · ${formatLocalWhen(s.updatedAt)}`}
                  <Show when={s.messageCount !== undefined}>
                    {` · ${format(es.history.messages, { count: s.messageCount ?? 0 })}`}
                  </Show>
                </span>
              </div>
              <div class="history-session-actions">
                <button
                  type="button"
                  class="text-button"
                  title={s.readable ? es.history.viewTitle : es.history.notReadable}
                  disabled={!s.readable}
                  onClick={() =>
                    props.onPick({
                      provider: s.provider,
                      sessionId: s.sessionId,
                      ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
                      title: sessionTitle(s),
                      session: s,
                    })
                  }
                >
                  {es.history.view}
                </button>
                <button
                  type="button"
                  class="text-button"
                  title={s.resumable ? es.history.resumeTitle : es.history.notResumable}
                  disabled={!s.resumable || props.busy}
                  onClick={() => props.onResume(s)}
                >
                  {es.history.resume}
                </button>
              </div>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}

/** Sesión antigua de solo lectura: los mismos bloques del panel de agente, sin nada que responda ni envíe. */
function SessionView(props: { picked: Picked; onBack: () => void; onResumed: () => void }) {
  const app = useModel()
  const names = useProviderNames()
  const data = useHistoryBlocks(() => props.picked)
  const blocks = createMemo(() => data.blocks().map(toBlock))
  const model = createReadOnlyModel(blocks)
  const { busy, resume } = useResume(props.onResumed)
  const env = {
    baseDir: props.picked.cwd,
    openFile: (path: string) => {
      app.ui.setHistoryOpen(false)
      void app.actions.openInViewerHere(path)
    },
  }
  const s = () => props.picked.session

  return (
    <div class="history-body">
      <div class="history-session-head">
        <button type="button" class="text-button" onClick={props.onBack}>
          ← {es.history.back}
        </button>
        <div class="history-session-info">
          <strong class="ellipsis" title={props.picked.title}>
            {props.picked.title}
          </strong>
          <span class="muted">
            {names.name(s().provider)}
            {` · ${formatLocalWhen(s().updatedAt)}`}
            <Show when={props.picked.cwd}>{(cwd) => ` · ${cwd()}`}</Show>
          </span>
        </div>
        <span class="history-tag history-readonly" title={es.history.readOnlyHint}>
          {es.history.readOnly}
        </span>
        <button
          type="button"
          class="text-button"
          title={s().resumable ? es.history.resumeTitle : es.history.notResumable}
          disabled={!s().resumable || busy()}
          onClick={() => void resume(s())}
        >
          {es.history.resume}
        </button>
      </div>

      <Show when={data.query.isPending}>
        <p class="muted" role="status">
          {es.history.blocksLoading}
        </p>
      </Show>
      <Show when={data.query.isError}>
        <p class="history-error" role="alert">
          {format(es.history.blocksFailed, { message: errorText(data.query.error) })}{' '}
          <button type="button" class="text-button" onClick={() => void data.query.refetch()}>
            {es.history.retry}
          </button>
        </p>
      </Show>
      <Show when={data.query.data !== undefined && blocks().length === 0}>
        <p class="muted" role="status">
          {es.history.blocksEmpty}
        </p>
      </Show>
      <AgentModelContext.Provider value={model}>
        <MarkdownEnvContext.Provider value={env}>
          <div class="agent-panel history-transcript" role="log" aria-label={es.history.document}>
            <For each={blocks()}>{(b) => <BlockView id={b.id} />}</For>
          </div>
        </MarkdownEnvContext.Provider>
      </AgentModelContext.Provider>
      <Show when={data.truncated()}>
        <p class="muted" role="status">
          {es.history.truncated}
        </p>
      </Show>
      <Show when={data.query.hasNextPage === true}>
        <p class="muted">
          {format(es.history.blocksCount, { shown: blocks().length, total: data.total() })}
        </p>
        <button
          type="button"
          class="text-button history-more"
          disabled={data.query.isFetchingNextPage}
          aria-busy={data.query.isFetchingNextPage}
          onClick={() => void data.query.fetchNextPage()}
        >
          {data.query.isFetchingNextPage ? es.history.loadingMore : es.history.blocksMore}
        </button>
      </Show>
    </div>
  )
}
