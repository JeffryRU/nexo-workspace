import type { PaneId } from '@nexo/contracts'
import type { AgentProviderPort, EventBusPort, LoggerPort, Unsubscribe } from '@nexo/core'

export type PaneLookup = {
  paneContext(
    paneId: PaneId,
  ): { pane: { kind: string; agentSessionId?: unknown }; cwd?: string } | undefined
}

const MAX_TRACKED = 4096

/**
 * Precalienta el proveedor cuando aparece un panel `agent` sin sesión: así el primer mensaje no espera al
 * arranque del proceso. Es silencioso y de mejor esfuerzo (un fallo solo se registra). Cada panel se
 * precalienta una vez. Solo toca el proveedor por omisión (el primero).
 */
export function watchAgentPanes(deps: {
  bus: EventBusPort
  panes: PaneLookup
  provider: AgentProviderPort | undefined
  logger: LoggerPort
}): Unsubscribe {
  const { provider } = deps
  if (provider?.warmUp === undefined) return () => {}
  const warm = provider.warmUp.bind(provider)
  const seen = new Set<PaneId>()
  return deps.bus.subscribe((event) => {
    if (event.event !== 'layout.changed') return
    for (const pane of event.data.panes) {
      if (pane.kind !== 'agent' || pane.agentSessionId !== undefined || seen.has(pane.id)) continue
      const cwd = deps.panes.paneContext(pane.id)?.cwd
      if (cwd === undefined) continue
      if (seen.size >= MAX_TRACKED) seen.clear()
      seen.add(pane.id)
      warm({ cwd }).catch((error: unknown) =>
        deps.logger.debug('precalentamiento del agente fallido', { provider: provider.id, error }),
      )
    }
  })
}
