import {
  AgentSessionId,
  Attention,
  Block,
  BlockRange,
  FileType,
  FsEncoding,
  fsMethods,
  HistoryProject,
  HistorySession,
  historyMethods,
  memoryMethods,
  PaneKind,
} from '@nexo/contracts'
import { z } from 'zod'

/**
 * Esquemas de la salida `--json` de la CLI. Son parte de su contrato estable: añadir campos opcionales
 * es compatible; quitar o renombrar, no.
 */
const Id = z.string().min(1)

export const LsOutput = z.strictObject({
  workspaces: z.array(
    z.strictObject({
      id: Id,
      name: z.string(),
      cwd: z.string().optional(),
      tabs: z.array(
        z.strictObject({
          id: Id,
          title: z.string(),
          active: z.boolean(),
          panes: z.array(
            z.strictObject({
              id: Id,
              title: z.string(),
              kind: PaneKind,
              terminalId: Id.optional(),
              attention: Attention,
              focused: z.boolean(),
            }),
          ),
        }),
      ),
    }),
  ),
})

export const NewOutput = z.strictObject({
  workspaceId: Id,
  tabId: Id,
  paneId: Id,
  terminalId: Id,
  createdWorkspace: z.boolean(),
})

export const OpenOutput = z.strictObject({
  paneId: Id,
  tabId: Id,
  path: z.string(),
  /** `true` si hubo que crear un panel de visor; `false` si se reutilizó uno. */
  created: z.boolean(),
})

export const SplitOutput = z.strictObject({ paneId: Id, terminalId: Id, sourcePaneId: Id })

export const SendOutput = z.strictObject({
  paneId: Id,
  terminalId: Id,
  bytes: z.int().nonnegative(),
  messages: z.int().nonnegative(),
})

export const ReadOutput = z.strictObject({
  paneId: Id,
  terminalId: Id,
  text: z.string(),
  offset: z.int().nonnegative(),
  truncated: z.boolean(),
  raw: z.boolean(),
})

/** Una línea por evento con `read --follow --json`. */
export const FollowLine = z.strictObject({
  paneId: Id,
  terminalId: Id,
  offset: z.int().nonnegative(),
  text: z.string(),
})

export const ActionOutput = z.strictObject({
  ok: z.literal(true),
  action: z.enum(['focus', 'kill', 'close', 'rename']),
  kind: z.enum(['workspace', 'tab', 'pane']),
  id: Id,
})

export const DaemonStatusOutput = z.strictObject({
  running: z.boolean(),
  stateDir: z.string(),
  version: z.string().optional(),
  protocol: z.number().optional(),
  pid: z.int().optional(),
  port: z.int().optional(),
  startedAt: z.string().optional(),
})

export const DaemonStopOutput = z.strictObject({ ok: z.literal(true), wasRunning: z.boolean() })

export const DaemonLogOutput = z.strictObject({ lines: z.array(z.string()) })

export const ErrorOutput = z.strictObject({
  error: z.strictObject({
    code: z.enum(['USAGE', 'NOT_FOUND', 'DAEMON_UNAVAILABLE', 'DAEMON_ERROR']),
    exit: z.int().min(1).max(4),
    message: z.string(),
  }),
})

const AgentSessionView = z.strictObject({
  id: Id,
  provider: z.string(),
  paneId: Id,
  status: Attention,
  turn: z.int().nonnegative(),
  cwd: z.string(),
  permissionMode: z.string(),
  title: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
})

export const AgentLsOutput = z.strictObject({ sessions: z.array(AgentSessionView) })

export const AgentNewOutput = z.strictObject({
  workspaceId: Id,
  tabId: Id,
  paneId: Id,
  sessionId: Id,
  provider: z.string(),
  createdWorkspace: z.boolean(),
})

export const AgentSendOutput = z.strictObject({
  sessionId: Id,
  blockId: Id,
  index: z.int().nonnegative(),
  turn: z.int().positive(),
})

export const AgentActionOutput = z.strictObject({
  ok: z.literal(true),
  action: z.enum(['interrupt', 'close', 'respond', 'renew']),
  sessionId: Id,
  blockId: Id.optional(),
})

/** Una línea por evento con `agent attach --json`: los bloques completos y los deltas de texto. */
export const AgentAttachLine = z.discriminatedUnion('event', [
  z.strictObject({ sessionId: Id, event: z.literal('block'), block: Block }),
  z.strictObject({
    sessionId: Id,
    event: z.literal('delta'),
    blockId: Id,
    field: z.enum(['text', 'output']),
    text: z.string(),
  }),
  z.strictObject({ sessionId: Id, event: z.literal('status'), status: Attention }),
  z.strictObject({ sessionId: Id, event: z.literal('removed') }),
])

// ---- memoria (F3.5.2): la salida es la de los métodos `memory.*` ----

export const MemoryStatusOutput = memoryMethods['memory.status'].result
export const MemoryConfigureOutput = memoryMethods['memory.configure'].result
export const MemoryListOutput = memoryMethods['memory.list'].result
export const MemorySearchOutput = memoryMethods['memory.search'].result
export const MemoryRecallOutput = z.strictObject({
  sessionId: AgentSessionId,
  range: BlockRange,
  ...memoryMethods['memory.recall'].result.shape,
})

// ---- archivos (F4.1) ----

export const FsStatOutput = fsMethods['fs.stat'].result
export const FsCatOutput = z.strictObject({
  path: z.string(),
  type: FileType,
  mime: z.string(),
  size: z.int().nonnegative(),
  encoding: FsEncoding,
  /** Bytes del archivo leídos. */
  bytes: z.int().nonnegative(),
  truncated: z.boolean(),
  data: z.string(),
})

// ---- historial (F4.3): la salida es la de los métodos `history.*` ----

/** Como `history.list`, pero sin el tope de una página por carpeta: `--all` junta las páginas. */
export const HistoryListOutput = z.strictObject({
  ...historyMethods['history.list'].result.shape,
  projects: z.array(HistoryProject.extend({ sessions: z.array(HistorySession).min(1) })),
})
export const HistoryReadOutput = historyMethods['history.read'].result
