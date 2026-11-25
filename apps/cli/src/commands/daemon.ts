import { DiscoveryError } from '@nexo/client/node'
import { expectPositionals, intOption, parseArgv } from '../args.ts'
import type { Ctx } from '../context.ts'
import { CliError, EXIT, notFoundError, usageError } from '../errors.ts'
import { DaemonLogOutput, DaemonStatusOutput, DaemonStopOutput } from '../schemas.ts'
import { sanitize } from '../text.ts'

const STOP_WAIT_MS = 8000

async function isRunning(ctx: Ctx): Promise<boolean> {
  try {
    await ctx.deps.daemon.locate()
    return true
  } catch (error) {
    if (error instanceof DiscoveryError) return false
    throw error
  }
}

async function status(ctx: Ctx): Promise<void> {
  const stateDir = ctx.deps.daemon.stateDir()
  if (!(await isRunning(ctx))) {
    ctx.emit(
      DaemonStatusOutput,
      { running: false, stateDir },
      () => `Nexo no está corriendo (estado en ${sanitize(stateDir)})`,
    )
    // Informa y devuelve "daemon no disponible" para que sirva en scripts.
    ctx.exitCode = EXIT.unavailable
    return
  }
  const client = await ctx.open(false)
  const info = await client.call('daemon.info', {})
  const location = await ctx.deps.daemon.locate()
  ctx.emit(
    DaemonStatusOutput,
    {
      running: true,
      stateDir,
      version: info.version,
      protocol: info.protocol,
      pid: info.pid,
      port: location.port,
      startedAt: info.startedAt,
    },
    () =>
      [
        'Nexo está corriendo',
        `  versión:  ${sanitize(info.version)}`,
        `  pid:      ${info.pid}`,
        `  puerto:   ${location.port}`,
        `  desde:    ${sanitize(info.startedAt)}`,
        `  estado:   ${sanitize(stateDir)}`,
      ].join('\n'),
  )
}

async function stop(ctx: Ctx): Promise<void> {
  if (!(await isRunning(ctx))) {
    ctx.emit(DaemonStopOutput, { ok: true, wasRunning: false }, () => 'Nexo ya estaba detenido')
    return
  }
  const client = await ctx.open(false)
  await client.call('daemon.shutdown', {})
  const deadline = Date.now() + STOP_WAIT_MS
  while (Date.now() < deadline && !ctx.signal.aborted) {
    if (!(await isRunning(ctx))) {
      ctx.emit(DaemonStopOutput, { ok: true, wasRunning: true }, () => 'Nexo detenido')
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new CliError('DAEMON_ERROR', 'el daemon aceptó apagarse pero sigue respondiendo')
}

async function log(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { lines: { type: 'string', short: 'n' } })
  expectPositionals(parsed, 0, 0, 'nexo daemon log [-n N]')
  const lines = intOption(parsed, 'lines', 50, 1, 100_000)
  const text = await ctx.deps.daemon.readLog(
    Math.min(4 * 1024 * 1024, Math.max(16 * 1024, lines * 400)),
  )
  if (text === undefined) {
    throw notFoundError('no hay registro del daemon (solo existe si lo arrancó la CLI)')
  }
  const all = text.split('\n')
  if (all[all.length - 1] === '') all.pop()
  const tail = all.slice(-lines).map((l) => sanitize(l, 2000))
  ctx.emit(DaemonLogOutput, { lines: tail }, () => tail.join('\n'))
}

export async function daemonCommand(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'status':
      expectPositionals(parseArgv(rest), 0, 0, 'nexo daemon status')
      return status(ctx)
    case 'stop':
      expectPositionals(parseArgv(rest), 0, 0, 'nexo daemon stop')
      return stop(ctx)
    case 'log':
      return log(ctx, rest)
    default:
      throw usageError('uso: nexo daemon status|stop|log')
  }
}
