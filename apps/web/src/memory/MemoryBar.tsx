import { createSignal, Show } from 'solid-js'
import type { AgentPaneModel } from '../agent/pane-model.ts'
import { es, format } from '../i18n/es.ts'
import { useMemoryStatus } from './queries.ts'
import { formatTokens } from './view.ts'

/**
 * Franja del panel de agente (F3.5.4): avisa de que la sesión recibió memoria del proyecto y ofrece renovarla a
 * mano. No ocupa sitio si la sesión no recibió memoria y la memoria está apagada.
 */
export function MemoryBar(props: { model: AgentPaneModel }) {
  const m = props.model
  const status = useMemoryStatus(() => undefined)
  const [renewing, setRenewing] = createSignal(false)
  const info = () => m.session()?.memory
  const enabled = () => status.data?.enabled === true
  const busy = () => renewing() || info()?.renewing === true
  // Solo entre turnos y con la sesión viva (el daemon lo vuelve a comprobar).
  const canRenew = () => enabled() && m.sessionId !== undefined && m.canSend && !busy()

  const renew = async () => {
    if (!canRenew()) return
    setRenewing(true)
    try {
      await m.renew()
    } finally {
      setRenewing(false)
    }
  }

  return (
    <Show when={info() !== undefined || (enabled() && m.sessionId !== undefined)}>
      <div class="memory-bar">
        <Show when={info()}>
          {(i) => (
            <span
              class="memory-badge"
              data-testid="memory-badge"
              title={format(es.memory.badgeTitle, { tokens: formatTokens(i().seedTokens) })}
            >
              {es.memory.badge}
              <Show when={i().renewals > 0}>
                {` · ${format(es.memory.badgeRenewals, { count: i().renewals })}`}
              </Show>
            </span>
          )}
        </Show>
        <Show when={enabled() && m.sessionId !== undefined}>
          <button
            type="button"
            class="text-button"
            title={es.memory.renewTitle}
            disabled={!canRenew()}
            aria-busy={busy()}
            onClick={() => void renew()}
          >
            {busy() ? es.memory.renewing : es.memory.renew}
          </button>
        </Show>
      </div>
    </Show>
  )
}
