import { NexoClientError } from '@nexo/client'
import { LIMITS, TerminalId } from '@nexo/contracts'
import { flag, parseArgv } from '../args.ts'
import type { ClientLike, Ctx } from '../context.ts'
import { notFoundError, usageError } from '../errors.ts'
import { resolveRef, validateRef } from '../resolve.ts'
import { SendOutput } from '../schemas.ts'
import { chunkText } from '../text.ts'

const USAGE = 'nexo send <panel> [--enter] [--stdin] [--] <texto...>'
/** Tope de lo que se lee de la entrada estándar. */
export const MAX_STDIN_BYTES = 64 * 1024 * 1024
const RATE_LIMIT_DEADLINE_MS = 60_000

export async function readStdin(ctx: Ctx): Promise<string> {
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let bytes = 0
  for await (const chunk of ctx.io.stdin()) {
    if (ctx.signal.aborted) break
    if (typeof chunk === 'string') {
      bytes += Buffer.byteLength(chunk, 'utf8')
      text += chunk
    } else {
      bytes += chunk.byteLength
      text += decoder.decode(chunk, { stream: true })
    }
    if (bytes > MAX_STDIN_BYTES) {
      throw usageError(`la entrada estándar supera ${MAX_STDIN_BYTES / (1024 * 1024)} MiB`)
    }
  }
  return text + decoder.decode()
}

async function sleep(ctx: Ctx, ms: number): Promise<void> {
  if (ctx.deps.sleep !== undefined) return ctx.deps.sleep(ms, ctx.signal)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    ctx.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** Escribe un trozo; si el daemon limita la frecuencia (RATE_LIMITED) espera y reintenta. */
async function writeChunk(
  ctx: Ctx,
  client: ClientLike,
  terminalId: TerminalId,
  data: string,
): Promise<void> {
  const deadline = Date.now() + RATE_LIMIT_DEADLINE_MS
  for (;;) {
    try {
      await client.call('terminal.write', { terminalId, data })
      return
    } catch (error) {
      if (
        !(error instanceof NexoClientError) ||
        error.code !== 'RATE_LIMITED' ||
        Date.now() > deadline ||
        ctx.signal.aborted
      ) {
        throw error
      }
      const hint = (error.data as { retryAfterMs?: unknown } | undefined)?.retryAfterMs
      await sleep(ctx, typeof hint === 'number' ? Math.min(2000, Math.max(5, hint)) : 50)
    }
  }
}

export async function sendCommand(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { enter: { type: 'boolean' }, stdin: { type: 'boolean' } })
  const [ref, ...words] = parsed.positionals
  if (ref === undefined) throw usageError(`uso: ${USAGE}`)
  const useStdin = flag(parsed, 'stdin')
  const enter = flag(parsed, 'enter')
  if (useStdin && words.length > 0) {
    throw usageError('usa el texto como argumentos o --stdin, no ambos')
  }
  if (!useStdin && words.length === 0 && !enter) {
    throw usageError(`falta el texto a enviar (uso: ${USAGE})`)
  }
  let text = useStdin ? await readStdin(ctx) : words.join(' ')
  if (enter) text += '\r'

  validateRef(ref)
  const client = await ctx.client()
  const { workspaces } = await client.call('workspace.list', {})
  const pane = resolveRef(workspaces, ref, ['pane'])
  if (pane.terminalId === undefined) throw notFoundError('el panel no tiene terminal')
  const terminalId = TerminalId.parse(pane.terminalId)

  const chunks = chunkText(text, LIMITS.maxWriteBytes)
  for (const chunk of chunks) {
    if (ctx.signal.aborted) break
    await writeChunk(ctx, client, terminalId, chunk)
  }
  ctx.emit(
    SendOutput,
    {
      paneId: pane.id,
      terminalId,
      bytes: Buffer.byteLength(text, 'utf8'),
      messages: chunks.length,
    },
    () => '',
  )
}
