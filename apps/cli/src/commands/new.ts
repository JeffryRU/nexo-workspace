import { basename, resolve } from 'node:path'
import { TabId, WorkspaceId } from '@nexo/contracts'
import { parseArgv, splitDashDash, str } from '../args.ts'
import type { ClientLike, Ctx } from '../context.ts'
import { CliError, classifyError, usageError } from '../errors.ts'
import { resolveRef } from '../resolve.ts'
import { NewOutput } from '../schemas.ts'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

export function terminalSize(ctx: Ctx): { cols: number; rows: number } {
  const clamp = (n: number | undefined, fallback: number) =>
    n !== undefined && Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback
  return { cols: clamp(ctx.io.columns, DEFAULT_COLS), rows: clamp(ctx.io.rows, DEFAULT_ROWS) }
}

/** Comando a lanzar: lo que va tras `--`; sin él el daemon elige el shell por omisión. */
export function commandToRun(after: readonly string[]): { cmd?: string; args?: string[] } {
  const [cmd, ...args] = after
  return cmd === undefined ? {} : { cmd, args }
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export async function newCommand(ctx: Ctx, args: string[]): Promise<void> {
  const { before, after } = splitDashDash(args)
  const parsed = parseArgv(before, {
    workspace: { type: 'string' },
    cwd: { type: 'string' },
    name: { type: 'string' },
  })
  if (parsed.positionals.length > 0) {
    throw usageError(
      'uso: nexo new [--workspace <nombre|id>] [--cwd <ruta>] [--name <título>] [-- <cmd> [args...]]',
    )
  }
  const cwdOption = str(parsed, 'cwd')
  if (cwdOption === '') throw usageError('--cwd no puede estar vacío')
  const cwd = resolve(ctx.deps.cwd(), cwdOption ?? '.')
  const name = str(parsed, 'name')
  const wsRef = str(parsed, 'workspace')
  const run = commandToRun(after)

  const client = await ctx.client()
  const { workspaces } = await client.call('workspace.list', {})

  let workspaceId: string | undefined
  let createdWorkspace = false
  if (wsRef !== undefined) {
    try {
      workspaceId = resolveRef(workspaces, wsRef, ['workspace']).id
    } catch (error) {
      if (!(error instanceof CliError) || error.kind !== 'NOT_FOUND') throw error
    }
  } else {
    workspaceId = workspaces.find(
      (w) => w.cwd !== undefined && samePath(w.cwd, cwd, ctx.deps.platform),
    )?.id
  }
  if (workspaceId === undefined) {
    const wsName = wsRef ?? (basename(cwd) || cwd)
    const created = await client.call('workspace.create', { name: wsName, cwd })
    workspaceId = created.workspace.id
    createdWorkspace = true
  }

  const created: { workspaceId: string; tabId?: string } = { workspaceId }
  try {
    const { tab } = await client.call('tab.create', {
      workspaceId: WorkspaceId.parse(workspaceId),
      ...(name === undefined ? {} : { title: name }),
      cwd,
    })
    created.tabId = tab.id
    const pane = tab.panes[0]
    if (pane === undefined)
      throw new CliError('DAEMON_ERROR', 'el daemon creó una pestaña sin paneles')
    const { terminalId } = await client.call('terminal.spawn', {
      paneId: pane.id,
      ...run,
      cwd,
      ...terminalSize(ctx),
    })
    ctx.emit(
      NewOutput,
      { workspaceId, tabId: tab.id, paneId: pane.id, terminalId, createdWorkspace },
      () => `creado panel ${pane.id} (terminal ${terminalId}) en la pestaña ${tab.id}`,
    )
  } catch (error) {
    await rollback(client, created, createdWorkspace)
    throw classifyError(error)
  }
}

/** Deshace lo creado si la terminal no arrancó (mejor esfuerzo). */
async function rollback(
  client: ClientLike,
  created: { workspaceId: string; tabId?: string },
  createdWorkspace: boolean,
): Promise<void> {
  try {
    if (createdWorkspace) {
      await client.call('workspace.close', { workspaceId: WorkspaceId.parse(created.workspaceId) })
    } else if (created.tabId !== undefined) {
      await client.call('tab.close', { tabId: TabId.parse(created.tabId) })
    }
  } catch {
    // el error original es el que importa
  }
}
