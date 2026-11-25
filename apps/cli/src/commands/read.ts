import { TerminalId } from '@nexo/contracts'
import { expectPositionals, flag, intOption, parseArgv } from '../args.ts'
import type { Ctx } from '../context.ts'
import { CliError, notFoundError, unavailableError } from '../errors.ts'
import { resolveRef, validateRef } from '../resolve.ts'
import { FollowLine, ReadOutput } from '../schemas.ts'
import { cleanOutput, lastLines, StreamCleaner } from '../text.ts'

const USAGE = 'nexo read <panel> [--lines N] [--follow] [--raw]'
const MAX_LINES = 100_000

export async function readCommand(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, {
    lines: { type: 'string', short: 'n' },
    follow: { type: 'boolean', short: 'f' },
    raw: { type: 'boolean' },
  })
  const [ref] = expectPositionals(parsed, 1, 1, USAGE) as [string]
  const lines = intOption(parsed, 'lines', 50, 1, MAX_LINES)
  const follow = flag(parsed, 'follow')
  const raw = flag(parsed, 'raw')

  validateRef(ref)
  const client = await ctx.client()
  const { workspaces } = await client.call('workspace.list', {})
  const pane = resolveRef(workspaces, ref, ['pane'])
  if (pane.terminalId === undefined) throw notFoundError('el panel no tiene terminal')
  const terminalId = TerminalId.parse(pane.terminalId)

  const maxBytes = Math.min(256 * 1024, Math.max(16 * 1024, lines * 400))
  const first = await client.call('terminal.read', { terminalId, maxBytes })
  const shown = lastLines(raw ? first.data : cleanOutput(first.data), lines)
  ctx.emit(
    ReadOutput,
    {
      paneId: pane.id,
      terminalId,
      text: shown,
      offset: first.offset,
      truncated: first.truncated === true,
      raw,
    },
    () => shown,
  )
  if (!follow) return

  await followOutput(ctx, pane.id, terminalId, first.offset, raw)
}

function followOutput(
  ctx: Ctx,
  paneId: string,
  terminalId: TerminalId,
  startOffset: number,
  raw: boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void (async () => {
      const client = await ctx.client()
      const cleaner = new StreamCleaner()
      let offset = startOffset
      let done = false
      let ready = false
      const pending: { offset: number; data: string }[] = []
      const apply = (end: number, text: string) => {
        if (end <= offset) return
        offset = end
        print(text, end)
      }
      const offs: (() => void)[] = []
      const finish = (error?: Error) => {
        if (done) return
        done = true
        for (const off of offs) off()
        ctx.signal.removeEventListener('abort', onAbort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onAbort = () => finish()
      const print = (text: string, end: number) => {
        const body = raw ? text : cleaner.feed(text)
        if (body === '') return
        if (ctx.json) {
          const parsed = FollowLine.parse({ paneId, terminalId, offset: end, text: body })
          ctx.out(`${JSON.stringify(parsed)}\n`)
        } else ctx.out(body)
      }

      offs.push(
        client.on('terminal.output', (data) => {
          if (data.terminalId !== terminalId) return
          if (ready) apply(data.offset, data.data)
          else pending.push({ offset: data.offset, data: data.data })
        }),
        client.on('terminal.exit', (data) => {
          if (data.terminalId !== terminalId) return
          ctx.io.stderr.write('[la terminal terminó]\n')
          finish()
        }),
        client.on('state', (state) => {
          if (state === 'closed' && !ctx.signal.aborted) {
            finish(unavailableError('se perdió la conexión con el daemon'))
          }
        }),
        // El daemon descartó salida por contrapresión: se recupera desde el último offset.
        client.on('resync', () => {
          void client
            .call('terminal.read', { terminalId, fromOffset: offset })
            .then((r) => {
              apply(r.offset, r.data)
            })
            .catch(() => {})
        }),
      )
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal.aborted) return finish()
      try {
        await client.subscribe(['terminal.output', 'terminal.exit'])
        // Lo emitido entre la lectura inicial y la suscripción.
        const gap = await client.call('terminal.read', { terminalId, fromOffset: offset })
        apply(gap.offset, gap.data)
        ready = true
        for (const p of pending.splice(0)) apply(p.offset, p.data)
      } catch (error) {
        finish(error instanceof CliError ? error : (error as Error))
      }
    })().catch((error: unknown) => reject(error))
  })
}
