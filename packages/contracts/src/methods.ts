import { z } from 'zod'
import {
  LayoutSchema,
  Pane,
  PaneId,
  PaneKind,
  SplitDirection,
  Tab,
  TabId,
  TerminalId,
  Workspace,
  WorkspaceId,
} from './domain.ts'
import { EventNameSchema } from './events.ts'
import { LIMITS } from './limits.ts'
import { boundedBytes, DisplayText, FORBIDDEN_KEYS } from './text.ts'

const Empty = z.strictObject({})
const Ok = z.strictObject({})
const Path = z.string().min(1).max(LIMITS.maxPathLength)
const Cols = z.int().min(LIMITS.minTerminalSize).max(LIMITS.maxTerminalSize)
const Rows = Cols

const EnvName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine((k) => !FORBIDDEN_KEYS.has(k), { message: 'nombre reservado' })
const Env = z
  .record(EnvName, z.string().max(LIMITS.maxEnvValueLength))
  .refine((o) => Object.keys(o).length <= LIMITS.maxEnvEntries, { message: 'demasiadas variables' })

const Signal = z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'])

/**
 * Registro de métodos de la F1: nombre -> { params, result }.
 * El servidor y el cliente se derivan de este registro.
 */
export const methods = {
  'daemon.info': {
    params: Empty,
    result: z.strictObject({
      version: z.string().min(1).max(64),
      protocol: z.literal(1),
      pid: z.int().nonnegative(),
      startedAt: z.string().max(40),
    }),
  },
  snapshot: {
    params: Empty,
    result: z.strictObject({
      /** `seq` del último evento incluido en el estado. */
      seq: z.int().nonnegative(),
      workspaces: z.array(Workspace).max(1024),
    }),
  },
  'events.subscribe': {
    params: z.strictObject({ events: z.array(EventNameSchema).max(32).optional() }),
    result: z.strictObject({ seq: z.int().nonnegative() }),
  },
  'workspace.list': { params: Empty, result: z.strictObject({ workspaces: z.array(Workspace) }) },
  'workspace.create': {
    params: z.strictObject({ name: DisplayText, cwd: Path.optional() }),
    result: z.strictObject({ workspace: Workspace }),
  },
  'workspace.rename': {
    params: z.strictObject({ workspaceId: WorkspaceId, name: DisplayText }),
    result: Ok,
  },
  'workspace.close': { params: z.strictObject({ workspaceId: WorkspaceId }), result: Ok },
  'tab.create': {
    params: z.strictObject({
      workspaceId: WorkspaceId,
      title: DisplayText.optional(),
      cwd: Path.optional(),
    }),
    result: z.strictObject({ tab: Tab }),
  },
  'tab.close': { params: z.strictObject({ tabId: TabId }), result: Ok },
  'tab.focus': { params: z.strictObject({ tabId: TabId }), result: Ok },
  'tab.move': {
    params: z.strictObject({
      tabId: TabId,
      workspaceId: WorkspaceId.optional(),
      index: z.int().nonnegative().max(1023),
    }),
    result: Ok,
  },
  'tab.rename': { params: z.strictObject({ tabId: TabId, title: DisplayText }), result: Ok },
  'pane.split': {
    params: z.strictObject({
      paneId: PaneId,
      direction: SplitDirection,
      kind: PaneKind.optional(),
      ratio: z.number().gt(0).lt(1).optional(),
    }),
    result: z.strictObject({ pane: Pane, layout: LayoutSchema }),
  },
  'pane.close': { params: z.strictObject({ paneId: PaneId }), result: Ok },
  'pane.focus': { params: z.strictObject({ paneId: PaneId }), result: Ok },
  'pane.resize': {
    params: z.strictObject({ paneId: PaneId, delta: z.number().min(-1).max(1) }),
    result: z.strictObject({ layout: LayoutSchema }),
  },
  'pane.swap': {
    params: z.strictObject({ paneId: PaneId, otherPaneId: PaneId }),
    result: z.strictObject({ layout: LayoutSchema }),
  },
  'terminal.spawn': {
    params: z.strictObject({
      paneId: PaneId,
      cmd: z.string().min(1).max(LIMITS.maxPathLength).optional(),
      args: z.array(z.string().max(LIMITS.maxArgLength)).max(LIMITS.maxArgs).optional(),
      cwd: Path.optional(),
      env: Env.optional(),
      cols: Cols,
      rows: Rows,
    }),
    result: z.strictObject({ terminalId: TerminalId }),
  },
  'terminal.write': {
    params: z.strictObject({ terminalId: TerminalId, data: boundedBytes(LIMITS.maxWriteBytes) }),
    result: Ok,
  },
  'terminal.resize': {
    params: z.strictObject({ terminalId: TerminalId, cols: Cols, rows: Rows }),
    result: Ok,
  },
  'terminal.read': {
    params: z.strictObject({
      terminalId: TerminalId,
      maxBytes: z.int().min(1).max(LIMITS.maxReadBytes).optional(),
    }),
    result: z.strictObject({
      data: z.string().max(LIMITS.maxMessageBytes),
      offset: z.int().nonnegative(),
    }),
  },
  'terminal.kill': {
    params: z.strictObject({ terminalId: TerminalId, signal: Signal.optional() }),
    result: Ok,
  },
} as const

export type MethodName = keyof typeof methods
export const METHOD_NAMES = Object.keys(methods) as MethodName[]
export type MethodParams<M extends MethodName> = z.infer<(typeof methods)[M]['params']>
export type MethodResult<M extends MethodName> = z.infer<(typeof methods)[M]['result']>

/** Petición ya tipada: unión discriminada por `method`. */
export type TypedRequest = {
  [M in MethodName]: { v: 1; id: string; method: M; params: MethodParams<M> }
}[MethodName]
