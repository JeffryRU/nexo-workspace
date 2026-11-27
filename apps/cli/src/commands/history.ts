import { resolve } from 'node:path'
import { type Block, BlockId, type HistoryBlock, LIMITS, type MethodResult } from '@nexo/contracts'
import { AgentPrinter } from '../agent-render.ts'
import { expectPositionals, flag, intOption, parseArgv, str } from '../args.ts'
import type { Ctx } from '../context.ts'
import { usageError } from '../errors.ts'
import { HistoryListOutput, HistoryReadOutput } from '../schemas.ts'
import { sanitize } from '../text.ts'

const SUBCOMMANDS = ['ls', 'show'] as const
const LS_USAGE =
  'nexo history ls [--provider <id>] [--cwd <ruta>] [--limit N] [--cursor <cursor>] [--all]'
const SHOW_USAGE =
  'nexo history show <proveedor> <sesión> [--cwd <ruta>] [--limit N] [--cursor <cursor>] [--all]'
/** Tope de `--all`: las sesiones o bloques que se siguen pidiendo antes de parar. */
const ALL_SESSIONS = 2000
const ALL_BLOCKS = LIMITS.maxHistoryBlocks

export async function historyCommand(ctx: Ctx, args: string[]): Promise<void> {
  // Las opciones globales pueden ir antes del subcomando (`nexo history --json ls`).
  const at = args.findIndex((a) => !a.startsWith('-'))
  const sub = at === -1 ? undefined : args[at]
  const rest = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 1)]
  switch (sub) {
    case 'ls':
      return historyLs(ctx, rest)
    case 'show':
      return historyShow(ctx, rest)
    default:
      throw usageError(`uso: nexo history ${SUBCOMMANDS.join('|')} (mira \`nexo history --help\`)`)
  }
}

const when = (ms: number): string => {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '?' : d.toISOString().slice(0, 16).replace('T', ' ')
}

async function historyLs(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, {
    provider: { type: 'string' },
    cwd: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    all: { type: 'boolean' },
  })
  if (parsed.positionals.length > 0) throw usageError(`uso: ${LS_USAGE}`)
  const provider = str(parsed, 'provider')
  const cwdOption = str(parsed, 'cwd')
  if (cwdOption === '') throw usageError('--cwd no puede estar vacío')
  const limit = intOption(parsed, 'limit', 50, 1, LIMITS.maxHistoryPage)
  const cursor = str(parsed, 'cursor')
  const all = flag(parsed, 'all')
  if (all && cursor !== undefined) throw usageError('--all y --cursor no se combinan')
  const base = {
    ...(provider === undefined ? {} : { provider }),
    ...(cwdOption === undefined ? {} : { cwd: resolve(ctx.deps.cwd(), cwdOption) }),
    limit,
  }
  const client = await ctx.client()
  let page: MethodResult<'history.list'> = await client.call('history.list', {
    ...base,
    ...(cursor === undefined ? {} : { cursor }),
  })
  if (all) {
    // Se juntan las páginas; una carpeta partida entre dos se une por su ruta.
    const folders = new Map<string, MethodResult<'history.list'>['projects'][number]>()
    let count = 0
    for (;;) {
      for (const p of page.projects) {
        const key = p.cwd ?? '\u0000'
        const known = folders.get(key)
        if (known === undefined) folders.set(key, { ...p, sessions: [...p.sessions] })
        else known.sessions.push(...p.sessions)
        count += p.sessions.length
      }
      if (page.nextCursor === null || count >= ALL_SESSIONS) break
      page = await client.call('history.list', { ...base, cursor: page.nextCursor })
    }
    page = {
      projects: [...folders.values()],
      nextCursor: page.nextCursor,
      providers: page.providers,
    }
  }
  ctx.emit(HistoryListOutput, page, () => {
    const lines: string[] = []
    for (const p of page.projects) {
      lines.push(`${sanitize(p.cwd ?? p.name, 300)}`)
      for (const s of p.sessions) {
        const marks = `${s.resumable ? '' : ' (no reanudable)'}${s.readable ? '' : ' (solo lista)'}`
        lines.push(
          `  ${sanitize(s.provider, 32)}  ${sanitize(s.sessionId, 80)}  ${when(s.updatedAt)}  ${sanitize(s.title ?? '(sin título)', 80)}${marks}`,
        )
      }
    }
    if (lines.length === 0) lines.push('no hay sesiones en el historial')
    for (const st of page.providers) {
      if (st.status !== 'ok') {
        lines.push(
          `! ${sanitize(st.provider, 32)}: ${st.status}${st.reason === undefined ? '' : ` (${sanitize(st.reason, 200)})`}`,
        )
      }
    }
    if (page.nextCursor !== null) lines.push(`más: --cursor ${page.nextCursor} (o --all)`)
    return lines.join('\n')
  })
}

/** Los bloques del historial no tienen id propio: se les da uno estable para reutilizar el impresor del agente. */
function asBlock(h: HistoryBlock): Block {
  return {
    ...h.block,
    id: BlockId.parse(`h${h.index}`),
    index: Math.min(h.index, LIMITS.maxBlocksPerSession - 1),
    turn: h.turn,
    seq: 0,
    createdAt: 0,
  } as Block
}

async function historyShow(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, {
    cwd: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    all: { type: 'boolean' },
  })
  const [provider, sessionId] = expectPositionals(parsed, 2, 2, SHOW_USAGE) as [string, string]
  const cwdOption = str(parsed, 'cwd')
  if (cwdOption === '') throw usageError('--cwd no puede estar vacío')
  const limit = intOption(parsed, 'limit', 50, 1, LIMITS.maxHistoryBlocksPage)
  const cursor = str(parsed, 'cursor')
  const all = flag(parsed, 'all')
  if (all && cursor !== undefined) throw usageError('--all y --cursor no se combinan')
  const base = {
    provider,
    sessionId,
    limit,
    ...(cwdOption === undefined ? {} : { cwd: resolve(ctx.deps.cwd(), cwdOption) }),
  }
  const client = await ctx.client()
  let page = await client.call('history.read', {
    ...base,
    ...(cursor === undefined ? {} : { cursor }),
  })
  if (all) {
    const blocks = [...page.blocks]
    while (page.nextCursor !== null && blocks.length < ALL_BLOCKS) {
      page = await client.call('history.read', { ...base, cursor: page.nextCursor })
      blocks.push(...page.blocks)
    }
    page = { ...page, blocks }
  }
  ctx.emit(HistoryReadOutput, page, () => {
    const printer = new AgentPrinter()
    const out = page.blocks.map((b) => printer.feed(asBlock(b))).join('')
    const tail = [printer.flush()]
    if (page.truncated) tail.push('[la transcripción se recortó o se omitió contenido]\n')
    if (page.nextCursor !== null) {
      tail.push(
        `[sigue: ${page.blocks.length} de ${page.total}; --cursor ${page.nextCursor} (o --all)]\n`,
      )
    }
    return `${out}${tail.join('')}`.trimEnd()
  })
}
