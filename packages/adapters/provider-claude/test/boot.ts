import type { Block, PaneId } from '@nexo/contracts'
import {
  AgentService,
  type ClockPort,
  type EventBusPort,
  type IdPort,
  type LayoutService,
  type WorkspaceService,
} from '@nexo/core'
import { createClaudeProvider } from '../src/provider.ts'
import { FakeTransport } from './helpers.ts'

/** El servicio real de agentes de core conectado al adaptador Claude con un transporte falso. */
/** Lo que se usa de `createHarness()` del testkit (se pasa ya construido: el código fuera de *.test.ts no importa testkit). */
export type KitHarness = {
  bus: EventBusPort
  clock: ClockPort & { advance(ms: number): void }
  ids: IdPort
  layout: LayoutService
  workspaces: WorkspaceService
}

export async function bootClaude(
  h: KitHarness & Record<string, unknown>,
  transport = new FakeTransport(),
) {
  const provider = createClaudeProvider({ transport, env: {}, checkCwd: false })
  const service = new AgentService({
    providers: [provider],
    bus: h.bus,
    clock: h.clock,
    ids: h.ids,
    panes: h.layout,
  })
  const { workspace } = h.workspaces.create({ name: 'proyecto', cwd: '/work' })
  const { tab } = h.workspaces.createTab({ workspaceId: workspace.id })
  const first = tab.panes[0]?.id as PaneId
  const paneId = h.workspaces.split({ paneId: first, direction: 'row', kind: 'agent' }).pane.id
  const { session } = await service.create({ paneId, provider: 'claude' })
  const fake = transport.last
  const document = (): Block[] => service.snapshot({ sessionId: session.id, limit: 200 }).blocks
  /** Vacía los lotes de deltas (reloj falso) hasta que `done` se cumpla. */
  const until = async (done: () => boolean, ms = 3000) => {
    const start = Date.now()
    while (!done()) {
      if (Date.now() - start > ms) throw new Error('tiempo agotado')
      h.clock.advance(100)
      await new Promise((r) => setTimeout(r, 2))
    }
    h.clock.advance(1000)
  }
  const turnEnded = () => document().some((b) => b.type === 'usage')
  return {
    bus: h.bus,
    clock: h.clock,
    service,
    session,
    fake,
    document,
    until,
    turnEnded,
    transport,
  }
}
