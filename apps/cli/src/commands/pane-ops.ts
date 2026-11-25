import { PaneId, TabId, TerminalId, WorkspaceId } from '@nexo/contracts'
import { expectPositionals, parseArgv, str } from '../args.ts'
import type { Ctx } from '../context.ts'
import { notFoundError, usageError } from '../errors.ts'
import { type Entity, KIND_ES, resolveRef, validateRef } from '../resolve.ts'
import { ActionOutput } from '../schemas.ts'

type Action = 'focus' | 'kill' | 'close' | 'rename'

function report(ctx: Ctx, action: Action, entity: Entity, message: string): void {
  ctx.emit(ActionOutput, { ok: true, action, kind: entity.kind, id: entity.id }, () => message)
}

async function lookup(ctx: Ctx, ref: string, kinds: Parameters<typeof resolveRef>[2]) {
  validateRef(ref)
  const client = await ctx.client()
  const { workspaces } = await client.call('workspace.list', {})
  return { client, entity: resolveRef(workspaces, ref, kinds) }
}

export async function focusCommand(ctx: Ctx, args: string[]): Promise<void> {
  const [ref] = expectPositionals(parseArgv(args), 1, 1, 'nexo focus <panel>') as [string]
  const { client, entity } = await lookup(ctx, ref, ['pane'])
  if (entity.tabId !== undefined)
    await client.call('tab.focus', { tabId: TabId.parse(entity.tabId) })
  await client.call('pane.focus', { paneId: PaneId.parse(entity.id) })
  report(ctx, 'focus', entity, `enfocado ${entity.id}`)
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'] as const

export async function killCommand(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { signal: { type: 'string' } })
  const [ref] = expectPositionals(parsed, 1, 1, 'nexo kill <panel> [--signal SIGKILL]') as [string]
  const signal = str(parsed, 'signal')
  if (signal !== undefined && !(SIGNALS as readonly string[]).includes(signal)) {
    throw usageError(`--signal debe ser una de: ${SIGNALS.join(', ')}`)
  }
  const { client, entity } = await lookup(ctx, ref, ['pane'])
  if (entity.terminalId === undefined) throw notFoundError('el panel no tiene terminal')
  await client.call('terminal.kill', {
    terminalId: TerminalId.parse(entity.terminalId),
    ...(signal === undefined ? {} : { signal: signal as (typeof SIGNALS)[number] }),
  })
  report(ctx, 'kill', entity, `terminal ${entity.terminalId} terminada`)
}

export async function closeCommand(ctx: Ctx, args: string[]): Promise<void> {
  const [ref] = expectPositionals(parseArgv(args), 1, 1, 'nexo close <panel|pestaña|espacio>') as [
    string,
  ]
  const { client, entity } = await lookup(ctx, ref, ['pane', 'tab', 'workspace'])
  if (entity.kind === 'pane') await client.call('pane.close', { paneId: PaneId.parse(entity.id) })
  else if (entity.kind === 'tab') await client.call('tab.close', { tabId: TabId.parse(entity.id) })
  else await client.call('workspace.close', { workspaceId: WorkspaceId.parse(entity.id) })
  report(ctx, 'close', entity, `cerrado ${KIND_ES[entity.kind]} ${entity.id}`)
}

export async function renameCommand(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  const [ref, ...words] = parsed.positionals
  const name = words.join(' ')
  if (ref === undefined || name === '')
    throw usageError('uso: nexo rename <pestaña|espacio> <nombre...>')
  const { client, entity } = await lookup(ctx, ref, ['tab', 'workspace'])
  if (entity.kind === 'tab') {
    await client.call('tab.rename', { tabId: TabId.parse(entity.id), title: name })
  } else {
    await client.call('workspace.rename', { workspaceId: WorkspaceId.parse(entity.id), name })
  }
  report(ctx, 'rename', entity, `renombrado ${KIND_ES[entity.kind]} ${entity.id}`)
}
