import type { PaneId } from '@nexo/contracts'
import {
  createDispatcher,
  type IdPort,
  LayoutService,
  SnapshotService,
  TerminalService,
  type TerminalServiceConfig,
  WorkspaceService,
} from '@nexo/core'
import { FakeClock, FakePtyPort, RecordingEventBus, SequentialIds } from './fakes.ts'

export type HarnessOptions = {
  config?: TerminalServiceConfig
  pty?: FakePtyPort
  ids?: IdPort
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
  const workspaces = new WorkspaceService({ layout, terminals })
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
    subscribe: () => ({ seq: bus.events.length }),
    shutdown: () => {
      shutdowns.count++
    },
  })
  return { clock, bus, ids, pty, layout, terminals, workspaces, snapshot, dispatch, shutdowns }
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
