import { resolve } from 'node:path'
import { PaneId } from '@nexo/contracts'
import { expectPositionals, flag, parseArgv, splitDashDash, str } from '../args.ts'
import type { Ctx } from '../context.ts'
import { classifyError, usageError } from '../errors.ts'
import { resolveRef, validateRef } from '../resolve.ts'
import { SplitOutput } from '../schemas.ts'
import { commandToRun, terminalSize } from './new.ts'

const USAGE = 'nexo split <panel> --right|--down [-- <cmd> [args...]]'

export async function splitCommand(ctx: Ctx, args: string[]): Promise<void> {
  const { before, after } = splitDashDash(args)
  const parsed = parseArgv(before, {
    right: { type: 'boolean' },
    down: { type: 'boolean' },
    cwd: { type: 'string' },
  })
  const [ref] = expectPositionals(parsed, 1, 1, USAGE) as [string]
  const right = flag(parsed, 'right')
  const down = flag(parsed, 'down')
  if (right === down) throw usageError(`indica exactamente una de --right o --down (uso: ${USAGE})`)
  const cwdOption = str(parsed, 'cwd')
  if (cwdOption === '') throw usageError('--cwd no puede estar vacío')
  const run = commandToRun(ctx, after)

  validateRef(ref)
  const client = await ctx.client()
  const { workspaces } = await client.call('workspace.list', {})
  const source = resolveRef(workspaces, ref, ['pane'])
  const sourceId = PaneId.parse(source.id)
  const { pane } = await client.call('pane.split', {
    paneId: sourceId,
    direction: right ? 'row' : 'column',
  })
  try {
    const { terminalId } = await client.call('terminal.spawn', {
      paneId: pane.id,
      cmd: run.cmd,
      args: run.args,
      ...(cwdOption === undefined ? {} : { cwd: resolve(ctx.deps.cwd(), cwdOption) }),
      ...terminalSize(ctx),
    })
    ctx.emit(
      SplitOutput,
      { paneId: pane.id, terminalId, sourcePaneId: source.id },
      () => `creado panel ${pane.id} (terminal ${terminalId})`,
    )
  } catch (error) {
    try {
      await client.call('pane.close', { paneId: pane.id })
    } catch {
      // el error original es el que importa
    }
    throw classifyError(error)
  }
}
