import { memoryApi } from '@nexo/client'
import { type MemoryUsageTotals, type Observation, PaneId } from '@nexo/contracts'
import { useMutation, useQueryClient } from '@tanstack/solid-query'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { type AppModel, useModel } from '../app/model.tsx'
import { es, format } from '../i18n/es.ts'
import { activeTabOf } from '../state/store.ts'
import { useCurrentWorkspaceId } from '../ui/parts.tsx'
import { useMemoryList, useMemoryRecall, useMemoryStatus } from './queries.ts'
import {
  blockPlainText,
  formatCost,
  formatTokens,
  formatWhen,
  rangeLabel,
  totalUsage,
} from './view.ts'
import './memory.css'

/** Umbrales que ofrece el selector de renovación (el rango válido es de 10 000 a 5 000 000). */
const RENEW_CHOICES = [20_000, 50_000, 100_000, 200_000, 500_000] as const

/** Carpeta cuya memoria se ve: la de la sesión de agente del panel con foco o, si no, la del espacio. */
export function useMemoryCwd() {
  const app = useModel()
  const workspaceId = useCurrentWorkspaceId()
  const tab = createMemo(() =>
    activeTabOf(app.store.state.workspaces.find((w) => w.id === workspaceId())),
  )
  return createMemo(() => {
    const focused = tab()?.focusedPaneId
    const fromAgent = focused == null ? undefined : app.agents.get(focused)?.session()?.cwd
    if (fromAgent !== undefined) return fromAgent
    return app.store.state.workspaces.find((w) => w.id === workspaceId())?.cwd
  })
}

/** Panel en el que está abierta una sesión de agente (para saltar a su bloque), si lo hay. */
export function paneOfSession(app: AppModel, sessionId: string): string | undefined {
  for (const w of app.store.state.workspaces) {
    for (const t of w.tabs) {
      for (const p of t.panes) {
        if (app.agents.get(p.id)?.sessionId === sessionId) return p.id
      }
    }
  }
  return undefined
}

function Cost(props: { label: string; usage: MemoryUsageTotals }) {
  return (
    <tr>
      <th scope="row">{props.label}</th>
      <td>{props.usage.calls}</td>
      <td>{formatTokens(props.usage.inputTokens)}</td>
      <td>{formatTokens(props.usage.outputTokens)}</td>
      <td>{formatCost(props.usage.costUsd)}</td>
    </tr>
  )
}

function Source(props: { observation: Observation }) {
  const recall = useMemoryRecall(() => ({
    sessionId: props.observation.sessionId,
    from: props.observation.range.from,
    to: props.observation.range.to,
  }))
  return (
    <div class="memory-source">
      <Show when={recall.isPending}>
        <p class="muted">{es.memory.sourceLoading}</p>
      </Show>
      <Show when={recall.isError}>
        <p class="muted" role="status">
          {/NOT_FOUND|inexistente/i.test(String(recall.error?.message ?? recall.error))
            ? es.memory.sourceGone
            : format(es.memory.sourceFailed, {
                message: String(recall.error?.message ?? recall.error),
              })}
        </p>
      </Show>
      <Show when={recall.data}>
        {(data) => (
          <>
            <Show when={data().blocks.length === 0}>
              <p class="muted">{es.memory.sourceEmpty}</p>
            </Show>
            <For each={data().blocks}>
              {(block) => {
                const part = blockPlainText(block)
                return (
                  <div class="memory-source-block">
                    <span class="memory-source-label">
                      #{block.index} {part.label}
                    </span>
                    <pre class="memory-text">{part.text}</pre>
                  </div>
                )
              }}
            </For>
            <Show when={data().truncated}>
              <p class="muted">{es.memory.sourceTruncated}</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

function ObservationItem(props: { observation: Observation }) {
  const app = useModel()
  const [open, setOpen] = createSignal(false)
  const o = () => props.observation
  const pane = () => paneOfSession(app, o().sessionId)
  const goTo = () => {
    const id = pane()
    if (id === undefined) return
    app.ui.setJump({ sessionId: o().sessionId, from: o().range.from, to: o().range.to })
    app.ui.setMemoryOpen(false)
    void app.actions.revealPane(PaneId.parse(id))
  }
  return (
    <li class="memory-obs" data-priority={o().priority} data-scope={o().scope}>
      <div class="memory-obs-meta">
        <span class="memory-obs-seq">#{o().seq}</span>
        <span>{formatWhen(o().at)}</span>
        <span class="memory-tag" data-priority={o().priority}>
          {es.memory.priority[o().priority]}
        </span>
        <span class="memory-tag">{es.memory.scope[o().scope]}</span>
      </div>
      <pre class="memory-text">{o().text}</pre>
      <div class="memory-obs-origin">
        <span class="muted">
          {format(es.memory.origin, {
            session: o().sessionId.slice(-8),
            range: rangeLabel(o().range),
          })}
        </span>
        <button
          type="button"
          class="text-button"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          {open() ? es.memory.hideSource : es.memory.showSource}
        </button>
        <Show when={pane() !== undefined}>
          <button type="button" class="text-button" onClick={goTo}>
            {es.memory.goToBlock}
          </button>
        </Show>
      </div>
      <Show when={open()}>
        <Source observation={o()} />
      </Show>
    </li>
  )
}

/** Ventana de la memoria (F3.5.4): ajustes en caliente, costo y las observaciones y la reflexión de la carpeta. */
export function MemoryDialog() {
  const app = useModel()
  const queryClient = useQueryClient()
  const cwd = useMemoryCwd()
  const status = useMemoryStatus(cwd)
  const list = useMemoryList(cwd)
  let dialog!: HTMLDivElement
  createEffect(() => {
    if (app.ui.memoryOpen()) dialog?.focus()
  })

  const configure = useMutation(() => ({
    mutationFn: async (params: { enabled?: boolean; renewAtTokens?: number | null }) => {
      const client = app.agentClient()
      if (client === undefined) throw new Error(es.status.offline)
      return memoryApi(client).configure(params)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['memory'] }),
  }))

  const renewChoices = createMemo(() => {
    const current = status.data?.renewAtTokens
    const all: number[] = [...RENEW_CHOICES]
    if (current !== undefined && !all.includes(current)) all.push(current)
    return all.sort((a, b) => a - b)
  })

  return (
    <Show when={app.ui.memoryOpen()}>
      <div class="modal-backdrop">
        <div
          ref={dialog}
          class="modal memory-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={es.memory.title}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') app.ui.setMemoryOpen(false)
          }}
        >
          <header class="memory-head">
            <h2>{es.memory.title}</h2>
            <button type="button" class="text-button" onClick={() => app.ui.setMemoryOpen(false)}>
              {es.memory.close}
            </button>
          </header>

          <section class="memory-section" aria-label={es.memory.settings}>
            <label class="memory-switch">
              <input
                type="checkbox"
                checked={status.data?.enabled ?? false}
                disabled={status.data === undefined || configure.isPending}
                onChange={(e) => configure.mutate({ enabled: e.currentTarget.checked })}
              />
              <span>{es.memory.enabled}</span>
            </label>
            <p class="muted">{es.memory.enabledHint}</p>
            <Show when={status.data}>
              {(s) => (
                <>
                  <p class="muted" data-testid="memory-summarizer">
                    {s().summarizer === undefined
                      ? es.memory.noSummarizer
                      : format(es.memory.summarizer, { name: s().summarizer ?? '' })}
                    {'. '}
                    {es.memory.summarizerHint}
                  </p>
                  <Show when={s().pausedReason}>
                    {(reason) => (
                      <p class="memory-paused" role="status">
                        {format(es.memory.paused, { reason: reason() })}
                      </p>
                    )}
                  </Show>
                </>
              )}
            </Show>
            <label class="memory-renew">
              <span>{es.memory.renewLabel}</span>
              <select
                aria-label={es.memory.renewLabel}
                disabled={status.data === undefined || configure.isPending}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  configure.mutate({ renewAtTokens: v === '' ? null : Number(v) })
                }}
              >
                <option value="" selected={status.data?.renewAtTokens === undefined}>
                  {es.memory.renewOff}
                </option>
                <For each={renewChoices()}>
                  {(n) => (
                    <option value={String(n)} selected={status.data?.renewAtTokens === n}>
                      {format(es.memory.renewOption, { tokens: formatTokens(n) })}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <p class="muted">{es.memory.renewHint}</p>
            <Show when={configure.isError}>
              <p class="memory-error" role="alert">
                {format(es.memory.saveFailed, {
                  message: String(configure.error?.message ?? configure.error),
                })}
              </p>
            </Show>
          </section>

          <section class="memory-section" aria-label={es.memory.cost}>
            <h3>{es.memory.cost}</h3>
            <Show when={status.data?.roles} fallback={<p class="muted">{es.memory.loading}</p>}>
              {(roles) => (
                <table class="memory-cost">
                  <thead>
                    <tr>
                      <th />
                      <th scope="col">{es.memory.calls}</th>
                      <th scope="col">{es.memory.tokensIn}</th>
                      <th scope="col">{es.memory.tokensOut}</th>
                      <th scope="col">USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    <Cost label={es.memory.observer} usage={roles().observer} />
                    <Cost label={es.memory.reflector} usage={roles().reflector} />
                    <Cost
                      label={es.memory.total}
                      usage={totalUsage(roles().observer, roles().reflector)}
                    />
                    <Show when={status.data?.projectUsage}>
                      {(u) => <Cost label={es.memory.project} usage={u()} />}
                    </Show>
                  </tbody>
                </table>
              )}
            </Show>
          </section>

          <section class="memory-section" aria-label={es.memory.observations}>
            <Show when={cwd()} fallback={<p class="muted">{es.memory.noProject}</p>}>
              {(dir) => (
                <>
                  <p class="muted ellipsis" title={dir()}>
                    {format(es.memory.projectLabel, { cwd: dir() })}
                  </p>
                  <Show when={list.isPending}>
                    <p class="muted">{es.memory.loading}</p>
                  </Show>
                  <Show when={list.isError}>
                    <p class="memory-error" role="alert">
                      {format(es.memory.loadFailed, {
                        message: String(list.error?.message ?? list.error),
                      })}
                    </p>
                  </Show>
                  <Show when={list.data}>
                    {(data) => (
                      <>
                        <h3>{es.memory.reflectionTitle}</h3>
                        <Show
                          when={data().reflection}
                          fallback={<p class="muted">{es.memory.noReflection}</p>}
                        >
                          {(r) => (
                            <>
                              <p class="muted">
                                {format(es.memory.reflectionGeneration, {
                                  generation: r().generation,
                                })}
                              </p>
                              <pre class="memory-text memory-reflection">{r().text}</pre>
                            </>
                          )}
                        </Show>
                        <h3>{es.memory.observations}</h3>
                        <Show
                          when={data().observations.length > 0}
                          fallback={<p class="muted">{es.memory.noObservations}</p>}
                        >
                          <ul class="memory-list">
                            <For each={data().observations}>
                              {(o) => <ObservationItem observation={o} />}
                            </For>
                          </ul>
                        </Show>
                      </>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </section>
        </div>
      </div>
    </Show>
  )
}

/** Botón de la barra de estado que abre la ventana de memoria; indica si está activada. */
export function MemoryToggle() {
  const app = useModel()
  const status = useMemoryStatus(() => undefined)
  return (
    <button
      type="button"
      class="status-toggle memory-toggle"
      data-state={status.data?.enabled === true ? 'on' : 'off'}
      title={es.memory.openHint}
      aria-haspopup="dialog"
      onClick={() => app.ui.setMemoryOpen(true)}
    >
      {status.data === undefined
        ? es.memory.open
        : `${es.memory.open}: ${status.data.enabled ? es.memory.stateOn : es.memory.stateOff}`}
    </button>
  )
}
