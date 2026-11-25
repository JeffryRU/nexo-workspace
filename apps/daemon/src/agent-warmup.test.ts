import type { Pane } from '@nexo/contracts'
import type { AgentProviderPort, BusEvent } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { watchAgentPanes } from './agent-warmup.ts'

function setup(provider: Partial<AgentProviderPort> | undefined) {
  let listener: (e: BusEvent) => void = () => {}
  const bus = {
    publish: (e: BusEvent) => listener(e),
    subscribe: (l: (e: BusEvent) => void) => {
      listener = l
      return () => {
        listener = () => {}
      }
    },
  }
  const logs: string[] = []
  const logger = {
    debug: (m: string) => logs.push(m),
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  const cwds = new Map<string, string | undefined>()
  const off = watchAgentPanes({
    bus,
    panes: {
      paneContext: (id) => ({ pane: { kind: 'agent' }, cwd: cwds.get(id) }) as never,
    },
    provider: provider as AgentProviderPort | undefined,
    logger,
  })
  const publish = (panes: Partial<Pane>[]) =>
    bus.publish({
      event: 'layout.changed',
      data: { workspaceId: 'ws-1', tabId: 'tab-1', layout: null, focusedPaneId: null, panes },
    } as never)
  return { publish, cwds, logs, off }
}

describe('watchAgentPanes', () => {
  it('precalienta una vez por panel de agente sin sesión', () => {
    const warmed: string[] = []
    const t = setup({ id: 'p', warmUp: async ({ cwd }) => void warmed.push(cwd) })
    t.cwds.set('pane-a', '/a')
    t.cwds.set('pane-t', '/t')
    t.publish([
      { id: 'pane-a', kind: 'agent' },
      { id: 'pane-t', kind: 'terminal' },
    ] as never)
    t.publish([{ id: 'pane-a', kind: 'agent' }] as never)
    expect(warmed).toEqual(['/a'])
  })

  it('ignora paneles con sesión o sin carpeta', () => {
    const warmed: string[] = []
    const t = setup({ id: 'p', warmUp: async ({ cwd }) => void warmed.push(cwd) })
    t.cwds.set('pane-a', '/a')
    t.publish([{ id: 'pane-a', kind: 'agent', agentSessionId: 'agent-1' }] as never)
    t.publish([{ id: 'pane-b', kind: 'agent' }] as never)
    expect(warmed).toEqual([])
  })

  it('un fallo del proveedor solo se registra', async () => {
    const t = setup({
      id: 'p',
      warmUp: async () => {
        throw new Error('sin credenciales')
      },
    })
    t.cwds.set('pane-a', '/a')
    t.publish([{ id: 'pane-a', kind: 'agent' }] as never)
    await new Promise((r) => setTimeout(r, 5))
    expect(t.logs).toEqual(['precalentamiento del agente fallido'])
  })

  it('sin warmUp o sin proveedor no hace nada', () => {
    const none = setup(undefined)
    none.publish([{ id: 'pane-a', kind: 'agent' }] as never)
    const noWarm = setup({ id: 'p' })
    noWarm.publish([{ id: 'pane-a', kind: 'agent' }] as never)
    expect(noWarm.logs).toEqual([])
    noWarm.off()
  })
})
