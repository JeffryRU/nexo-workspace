import { agentApi } from '@nexo/client'
import { useQuery } from '@tanstack/solid-query'
import { createEffect, createMemo, Show, untrack } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es, format } from '../i18n/es.ts'
import { AgentModelContext, BlockView, estimateHeight } from './blocks.tsx'
import { Composer } from './Composer.tsx'
import { VirtualList, type VirtualListApi } from './VirtualList.tsx'
import './agent.css'

const PROVIDERS_TIMEOUT_MS = 60_000
const PROVIDERS_STALE_MS = 5 * 60_000

/** Panel de un agente: documento virtualizado, avisos de lo pendiente y redactor. */
export function AgentPanel(props: {
  paneId: string
  sessionId: string | undefined
  defaultCwd: string | undefined
  focused: boolean
}) {
  const app = useModel()
  const agent = app.agents.ensure(props.paneId)
  let root!: HTMLDivElement
  let list: VirtualListApi | undefined

  createEffect(() => {
    const client = app.status() === 'open' ? app.agentClient() : undefined
    const id = props.sessionId
    untrack(() => agent.bind(id, client))
  })

  // Los proveedores solo se piden mientras hace falta elegir (panel sin sesión) y sin bloquear nada:
  // Claude real puede tardar más de 10 s en responder.
  const providers = useQuery(() => ({
    queryKey: ['agent.providers'],
    queryFn: async () => {
      const client = app.agentClient()
      if (client === undefined) throw new Error(es.status.offline)
      return (await agentApi(client).providers({ timeoutMs: PROVIDERS_TIMEOUT_MS })).providers
    },
    enabled:
      app.status() === 'open' && props.sessionId === undefined && agent.sessionId === undefined,
    staleTime: PROVIDERS_STALE_MS,
  }))
  const providersState = createMemo(() => ({
    loading: providers.isPending && !providers.isError,
    error: providers.isError ? String(providers.error?.message ?? providers.error) : undefined,
    providers: providers.data ?? [],
    retry: () => void providers.refetch(),
  }))

  const pending = () => agent.pendingIds()
  const hasSession = () => props.sessionId !== undefined || agent.sessionId !== undefined

  const focusPending = (step: 1 | -1) => {
    const ids = pending()
    if (ids.length === 0) return
    const current = (document.activeElement as HTMLElement | null)
      ?.closest('[data-block-id]')
      ?.getAttribute('data-block-id')
    const at = current === null || current === undefined ? -1 : ids.indexOf(current)
    const next = at < 0 ? (step === 1 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length
    const id = ids[next] as string
    list?.scrollToIndex(Math.max(0, agent.ids().indexOf(id)))
    queueMicrotask(() => {
      const el = root.querySelector<HTMLElement>(
        `[data-block-id="${id}"] [data-autofocus], [data-block-id="${id}"] input, [data-block-id="${id}"] button`,
      )
      el?.focus()
    })
  }

  return (
    <AgentModelContext.Provider value={agent}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: recoge el atajo de navegación entre pendientes */}
      <div
        ref={root}
        class="agent-panel"
        data-status={agent.status()}
        onKeyDown={(e) => {
          if (e.altKey && e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            e.stopPropagation()
            focusPending(e.key === 'ArrowDown' ? 1 : -1)
          }
        }}
      >
        <div class="sr-only" role="status" aria-live="polite">
          {es.attention[agent.status()]}
        </div>
        <Show when={agent.docState() === 'failed'}>
          <div class="agent-banner error" role="alert">
            {format(es.agent.openFailed, { message: agent.docError() ?? '' })}{' '}
            <button type="button" class="text-button" onClick={() => agent.retry()}>
              {es.status.retry}
            </button>
          </div>
        </Show>
        <Show when={agent.removed()}>
          <div class="agent-banner" role="status">
            {es.agent.closed}
          </div>
        </Show>
        <div class="agent-doc">
          <Show
            when={hasSession()}
            fallback={
              <div class="agent-empty">
                <p class="agent-empty-title">{es.agent.emptyTitle}</p>
                <p class="muted">{es.agent.emptyHint}</p>
              </div>
            }
          >
            <VirtualList
              ids={agent.ids()}
              label={es.agent.document}
              busy={agent.syncing() || agent.docState() === 'opening'}
              estimate={(id) => untrack(() => estimateHeight(agent.block(id)()))}
              renderItem={(id) => <BlockView id={id} />}
              frame={app.frame}
              api={(a) => {
                list = a
              }}
            />
          </Show>
        </div>
        <Show when={pending().length > 0}>
          <div class="agent-banner pending" role="status">
            <span>{format(es.agent.pendingCount, { count: pending().length })}</span>
            <button type="button" class="text-button" onClick={() => focusPending(1)}>
              {es.agent.goToPending}
            </button>
            <kbd>Alt+Shift+↓</kbd>
          </div>
        </Show>
        <Composer model={agent} providers={providersState()} defaultCwd={props.defaultCwd} />
      </div>
    </AgentModelContext.Provider>
  )
}
