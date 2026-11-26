import type { PaneId } from '@nexo/contracts'
import {
  type AgentMemorySource,
  AgentService,
  type AgentServiceConfig,
  createDispatcher,
  type IdPort,
  LayoutService,
  SnapshotService,
  TerminalService,
  type TerminalServiceConfig,
  WorkspaceService,
} from '@nexo/core'
import { FakeAgentProvider, type FakeAgentProviderOptions } from './fake-agent.ts'
import { FakeClock, FakePtyPort, RecordingEventBus, SequentialIds } from './fakes.ts'

export type HarnessOptions = {
  config?: TerminalServiceConfig
  pty?: FakePtyPort
  ids?: IdPort
  /** Con él se arma un `AgentService` con un `FakeAgentProvider` (id `fake`) sobre el reloj del arnés. */
  agents?: {
    config?: AgentServiceConfig
    provider?: Omit<FakeAgentProviderOptions, 'clock'>
    /** Memoria del proyecto (F3.5.3). */
    memory?: AgentMemorySource
  }
}

/** Todos los servicios de core conectados a los falsos, para pruebas de integración en memoria. */
export function createHarness(options: HarnessOptions = {}) {
  const clock = new FakeClock()
  const bus = new RecordingEventBus()
  const ids = options.ids ?? new SequentialIds()
  const pty = options.pty ?? new FakePtyPort()
  const layout = new LayoutService({ ids, bus })
  const terminals = new TerminalService({
    pty,
    bus,
    clock,
    ids,
    panes: layout,
    config: { defaultCommand: { cmd: 'sh' }, ...options.config },
  })
  const provider = new FakeAgentProvider('fake', { ...options.agents?.provider, clock })
  const agents =
    options.agents === undefined
      ? undefined
      : new AgentService({
          providers: [provider],
          bus,
          clock,
          ids,
          panes: layout,
          ...(options.agents.memory === undefined ? {} : { memory: options.agents.memory }),
          ...(options.agents.config === undefined ? {} : { config: options.agents.config }),
        })
  const workspaces = new WorkspaceService({
    layout,
    terminals,
    ...(agents === undefined ? {} : { agents }),
  })
  const snapshot = new SnapshotService({
    layout,
    identity: { version: '0.0.0-test', pid: 1, startedAt: '2026-01-01T00:00:00.000Z' },
    currentSeq: () => bus.events.length,
  })
  const shutdowns = { count: 0 }
  const dispatch = createDispatcher({
    workspaces,
    terminals,
    snapshot,
    ...(agents === undefined ? {} : { agents: agents.handlers }),
    subscribe: () => ({ seq: bus.events.length }),
    shutdown: () => {
      shutdowns.count++
    },
  })
  return {
    clock,
    bus,
    ids,
    pty,
    layout,
    terminals,
    workspaces,
    snapshot,
    dispatch,
    shutdowns,
    provider,
    agents,
  }
}

export type Harness = ReturnType<typeof createHarness>

/** Arnés con un espacio, una pestaña y un panel listos; `spawn` devuelve también el proceso falso. */
export async function bootHarness(options: HarnessOptions = {}) {
  const h = createHarness(options)
  const { workspace } = h.workspaces.create({ name: 'proyecto', cwd: '/work' })
  const { tab } = h.workspaces.createTab({ workspaceId: workspace.id })
  const paneId = tab.panes[0]?.id as PaneId
  const spawn = async (pane: PaneId = paneId) => {
    const { terminalId } = await h.terminals.spawn({ paneId: pane, cols: 80, rows: 24 })
    const proc = h.pty.processes[h.pty.processes.length - 1]
    if (proc === undefined) throw new Error('sin proceso')
    return { terminalId, proc }
  }
  return { ...h, workspace, tab, paneId, spawn }
}

/** Arnés con un servicio de agentes y un panel de agente listo (`paneId`); `create()` abre una sesión. */
export async function bootAgentHarness(agents: NonNullable<HarnessOptions['agents']> = {}) {
  const h = createHarness({ agents })
  const service = h.agents as AgentService
  const { workspace } = h.workspaces.create({ name: 'proyecto', cwd: '/work' })
  const { tab } = h.workspaces.createTab({ workspaceId: workspace.id })
  const first = tab.panes[0]?.id as PaneId
  const paneId = h.workspaces.split({ paneId: first, direction: 'row', kind: 'agent' }).pane.id
  const create = async (pane: PaneId = paneId) => {
    const { session } = await service.create({ paneId: pane, provider: 'fake' })
    const fake = h.provider.sessions[h.provider.sessions.length - 1]
    if (fake === undefined) throw new Error('sin sesión de proveedor')
    return { session, fake }
  }
  /** Avanza el reloj lo bastante para vaciar guiones con retardos y lotes de deltas. */
  const settle = (ms = 1000) => h.clock.advance(ms)
  return { ...h, service, workspace, tab, paneId, create, settle }
}
