import { Attention, PaneKind } from '@nexo/contracts'
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
