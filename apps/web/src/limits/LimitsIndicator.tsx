import { limitsApi } from '@nexo/client'
import type { ProviderLimits } from '@nexo/contracts'
import { useQuery, useQueryClient } from '@tanstack/solid-query'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { useProviderNames } from '../history/queries.ts'
import { es, format } from '../i18n/es.ts'
import './limits.css'
import {
  formatPercent,
  formatRemaining,
  formatResetAt,
  type ProviderSummary,
  percentOf,
  replaceProvider,
  summarize,
  summaryText,
  windowDuration,
  windowName,
} from './view.ts'

const KEY = ['limits'] as const
const NOW_TICK_MS = 30_000

/** Límites de uso por proveedor; `limits.updated` sustituye lo que se tenía de ese proveedor. */
export function useLimits() {
  const app = useModel()
  const queryClient = useQueryClient()
  const query = useQuery(() => ({
    queryKey: KEY,
    queryFn: async (): Promise<ProviderLimits[]> => {
      const client = app.agentClient()
      if (client === undefined) throw new Error(es.status.offline)
      const r = await limitsApi(client).status({}, { timeoutMs: 30_000 })
      return Array.isArray(r?.providers) ? r.providers : []
    },
    enabled: app.status() === 'open',
    staleTime: 60_000,
    retry: false,
  }))
  createEffect(() => {
    const client = app.status() === 'open' ? app.agentClient() : undefined
    if (client === undefined) return
    const off = limitsApi(client).onUpdated((limits) => {
      queryClient.setQueryData<ProviderLimits[]>(KEY, (old) => replaceProvider(old ?? [], limits))
    })
    onCleanup(off)
  })
  const summaries = createMemo(() => summarize(query.data ?? []))
  return { query, summaries }
}

/** Indicador de la barra de estado: el peor porcentaje por proveedor, con color por umbral, y su detalle. */
export function LimitsIndicator() {
  const { summaries } = useLimits()
  const names = useProviderNames()
  const [open, setOpen] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  let root!: HTMLDivElement

  createEffect(() => {
    if (!open()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={summaries().length > 0}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: recoge Escape para cerrar el detalle */}
      <div
        ref={root}
        class="limits"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open()) {
            e.stopPropagation()
            setOpen(false)
            root.querySelector<HTMLButtonElement>('.limits-toggle')?.focus()
          }
        }}
      >
        <button
          type="button"
          class="status-toggle limits-toggle"
          aria-expanded={open()}
          aria-controls="limits-detail"
          aria-label={`${es.limits.label}: ${summaries()
            .map((s) => `${names.name(s.provider)} ${summaryText(s)}`)
            .join(', ')}`}
          onClick={() => setOpen(!open())}
        >
          <For each={summaries()}>
            {(s) => (
              <span
                class="limits-chip"
                data-provider={s.provider}
                data-level={s.unknown ? 'unknown' : s.level}
                data-reached={s.reached ? 'true' : undefined}
              >
                {s.provider} {summaryText(s)}
              </span>
            )}
          </For>
        </button>
        <Show when={open()}>
          <section id="limits-detail" class="limits-detail" aria-label={es.limits.detailTitle}>
            <h3>{es.limits.detailTitle}</h3>
            <For each={summaries()}>
              {(s) => <ProviderDetail summary={s} name={names.name(s.provider)} now={now()} />}
            </For>
            <RefreshButton />
          </section>
        </Show>
      </div>
    </Show>
  )
}

function ProviderDetail(props: { summary: ProviderSummary; name: string; now: number }) {
  const l = () => props.summary.limits
  return (
    <div class="limits-provider" data-provider={l().provider}>
      <h4>
        {props.name}
        <span class="limits-state">{es.limits.statuses[l().status]}</span>
      </h4>
      <Show when={props.summary.reached}>
        <p class="limits-reached" role="status">
          {es.limits.reached}
        </p>
      </Show>
      <Show when={l().windows.length > 0} fallback={<p class="muted">{es.limits.unknownHint}</p>}>
        <ul class="limits-windows">
          <For each={l().windows}>
            {(w) => {
              const pct = percentOf(w)
              const dur = windowDuration(w.windowMinutes)
              const remaining = formatRemaining(w.resetsAt, props.now)
              return (
                <li class="limits-window">
                  <span class="limits-window-name">
                    {format(es.limits.window, { name: windowName(w) })}
                    {dur === undefined ? '' : ` (${dur})`}
                  </span>
                  <span class="limits-bar" aria-hidden="true">
                    <span
                      class="limits-bar-fill"
                      data-level={pct === undefined ? 'unknown' : undefined}
                      style={{ width: `${pct ?? 0}%` }}
                    />
                  </span>
                  <span class="limits-window-pct">
                    {format(es.limits.percentUsed, { percent: formatPercent(pct) })}
                  </span>
                  <span class="limits-window-reset muted">
                    {w.resetsAt === undefined
                      ? es.limits.resetsUnknown
                      : format(es.limits.resets, { when: formatResetAt(w.resetsAt) })}
                    {remaining === undefined ? '' : ` (${remaining})`}
                  </span>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
      <p class="limits-meta muted">
        <Show when={l().fresh !== undefined}>
          <span>{l().fresh ? es.limits.fresh : es.limits.stale}</span>
        </Show>
        <Show when={l().observedAt !== undefined}>
          <span>{format(es.limits.observed, { when: formatResetAt(l().observedAt) })}</span>
        </Show>
        <Show when={l().source}>
          {(src) => <span>{format(es.limits.source, { source: es.limits.sources[src()] })}</span>}
        </Show>
        <Show when={l().reason}>
          {(r) => <span>{format(es.limits.reason, { reason: r() })}</span>}
        </Show>
      </p>
    </div>
  )
}

/** Refresca: pide `limits.status { refresh: true }` y deja el resultado en la caché. */
function RefreshButton() {
  const app = useModel()
  const queryClient = useQueryClient()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string | undefined>()
  const refresh = async () => {
    const client = app.agentClient()
    if (client === undefined || busy()) return
    setBusy(true)
    setFailure(undefined)
    try {
      const r = await limitsApi(client).refresh({}, { timeoutMs: 30_000 })
      if (Array.isArray(r?.providers)) queryClient.setQueryData<ProviderLimits[]>(KEY, r.providers)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="limits-actions">
      <button
        type="button"
        class="text-button"
        disabled={busy()}
        aria-busy={busy()}
        onClick={() => void refresh()}
      >
        {busy() ? es.limits.refreshing : es.limits.refresh}
      </button>
      <Show when={failure()}>
        {(f) => (
          <p class="limits-error" role="alert">
            {format(es.limits.refreshFailed, { message: f() })}
          </p>
        )}
      </Show>
    </div>
  )
}
