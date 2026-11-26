import { resolve } from 'node:path'
import {
  type BlockRange,
  LIMITS,
  MemoryPriority,
  MemoryScope,
  type MemoryUsageTotals,
  type Observation,
  type Reflection,
} from '@nexo/contracts'
import { AgentPrinter } from '../agent-render.ts'
import { expectPositionals, flag, intOption, parseArgv, str } from '../args.ts'
import type { Ctx } from '../context.ts'
import { usageError } from '../errors.ts'
import {
  MemoryConfigureOutput,
  MemoryListOutput,
  MemoryRecallOutput,
  MemorySearchOutput,
  MemoryStatusOutput,
} from '../schemas.ts'
import { sanitize } from '../text.ts'
import { resolveSession } from './agent.ts'

const SUBCOMMANDS = ['status', 'config', 'ls', 'search', 'recall'] as const

export async function memoryCommand(ctx: Ctx, args: string[]): Promise<void> {
  // Las opciones globales pueden ir antes del subcomando (`nexo memory --json ls`).
  const at = args.findIndex((a) => !a.startsWith('-'))
  const sub = at === -1 ? undefined : args[at]
  const rest = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 1)]
  switch (sub) {
    case 'status':
      return memoryStatus(ctx, rest)
    case 'config':
      return memoryConfig(ctx, rest)
    case 'ls':
      return memoryLs(ctx, rest)
    case 'search':
      return memorySearch(ctx, rest)
    case 'recall':
      return memoryRecall(ctx, rest)
    default:
      throw usageError(`uso: nexo memory ${SUBCOMMANDS.join('|')} (mira \`nexo memory --help\`)`)
  }
}

/** Carpeta del proyecto: `--cwd` o la carpeta actual. */
function projectCwd(ctx: Ctx, cwdOption: string | undefined): string {
  if (cwdOption === '') throw usageError('--cwd no puede estar vacío')
  return resolve(ctx.deps.cwd(), cwdOption ?? '.')
}

const fmtCost = (usd: number): string => `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`

function fmtUsage(u: MemoryUsageTotals): string {
  return `${u.calls} llamadas, ${u.inputTokens} tokens de entrada, ${u.outputTokens} de salida, ${fmtCost(u.costUsd)}`
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '?' : d.toISOString().slice(0, 16).replace('T', ' ')
}

const PRIORITY_LABEL = { high: 'alta', medium: 'media', low: 'baja' } as const

function observationLine(o: Observation): string {
  const scope = o.scope === 'project' ? 'proyecto' : 'sesión'
  return `#${o.seq} [${fmtDate(o.at)}] [${PRIORITY_LABEL[o.priority]}] [${scope}] (${sanitize(o.sessionId, 80)} #${o.range.from}-${o.range.to}) ${sanitize(o.text, 2000)}`
}

function reflectionText(r: Reflection): string {
  const body = r.text
    .split('\n')
    .map((l) => `  ${sanitize(l, 2000)}`)
    .join('\n')
  return `Reflexión (generación ${r.generation}, ${fmtDate(r.createdAt)}):\n${body}`
}

// ---- status ----

const STATUS_USAGE = 'nexo memory status [--cwd <ruta>]'

async function memoryStatus(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { cwd: { type: 'string' } })
  if (parsed.positionals.length > 0) throw usageError(`uso: ${STATUS_USAGE}`)
  const cwd = projectCwd(ctx, str(parsed, 'cwd'))
  const client = await ctx.client()
  const s = await client.call('memory.status', { cwd })
  ctx.emit(MemoryStatusOutput, s, () => {
    const lines = [
      `Memoria: ${s.enabled ? 'activada' : 'apagada (`nexo memory config --on` la activa)'}`,
      `Resumidor: ${s.summarizer === undefined ? '(ninguno)' : sanitize(s.summarizer, 256)}`,
    ]
    if (s.pausedReason !== undefined) lines.push(`En pausa: ${sanitize(s.pausedReason, 256)}`)
    lines.push(
      `Umbrales: Observador ${s.thresholds.observerBatchTokens} tokens, Reflector ${s.thresholds.reflectorTokens} tokens`,
      `Renovación automática: ${s.renewAtTokens === undefined ? 'apagada' : `a ~${s.renewAtTokens} tokens`}`,
      `Uso desde que arrancó el daemon: ${fmtUsage(s.usage)}`,
    )
    if (s.roles !== undefined) {
      lines.push(
        `  Observador: ${fmtUsage(s.roles.observer)}`,
        `  Reflector: ${fmtUsage(s.roles.reflector)}`,
      )
    }
    if (s.project !== undefined) {
      const p = s.project
      lines.push(
        `Proyecto ${sanitize(p.cwd, 200)}: ${p.observations} observaciones (~${p.observationTokens} tokens), reflexión ${p.generation === 0 ? 'ninguna' : `generación ${p.generation} (~${p.reflectionTokens} tokens)`}, ${p.sessions} sesiones`,
      )
    }
    if (s.projectUsage !== undefined)
      lines.push(`Uso acumulado del proyecto: ${fmtUsage(s.projectUsage)}`)
    return lines.join('\n')
  })
}

// ---- config ----

const CONFIG_USAGE = 'nexo memory config [--on|--off] [--renew-at N|off]'

async function memoryConfig(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, {
    on: { type: 'boolean' },
    off: { type: 'boolean' },
    'renew-at': { type: 'string' },
  })
  if (parsed.positionals.length > 0) throw usageError(`uso: ${CONFIG_USAGE}`)
  if (flag(parsed, 'on') && flag(parsed, 'off')) throw usageError('--on y --off se excluyen')
  const renewRaw = str(parsed, 'renew-at')
  let renewAtTokens: number | null | undefined
  if (renewRaw === 'off') renewAtTokens = null
  else if (renewRaw !== undefined) {
    renewAtTokens = intOption(parsed, 'renew-at', 0, 10_000, 5_000_000)
  }
  const enabled = flag(parsed, 'on') ? true : flag(parsed, 'off') ? false : undefined
  if (enabled === undefined && renewAtTokens === undefined) {
    throw usageError(`uso: ${CONFIG_USAGE}`)
  }
  const client = await ctx.client()
  const r = await client.call('memory.configure', {
    ...(enabled === undefined ? {} : { enabled }),
    ...(renewAtTokens === undefined ? {} : { renewAtTokens }),
  })
  ctx.emit(
    MemoryConfigureOutput,
    r,
    () =>
      `Memoria: ${r.enabled ? 'activada' : 'apagada'}. Renovación automática: ${r.renewAtTokens === undefined ? 'apagada' : `a ~${r.renewAtTokens} tokens`}`,
  )
}

// ---- ls ----

const LS_USAGE =
  'nexo memory ls [--cwd <ruta>] [--limit N] [--from SEQ] [--scope session|project] [--min-priority high|medium|low]'

async function memoryLs(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, {
    cwd: { type: 'string' },
    limit: { type: 'string' },
    from: { type: 'string' },
    scope: { type: 'string' },
    'min-priority': { type: 'string' },
  })
  if (parsed.positionals.length > 0) throw usageError(`uso: ${LS_USAGE}`)
  const cwd = projectCwd(ctx, str(parsed, 'cwd'))
  const limit = intOption(parsed, 'limit', 50, 1, LIMITS.maxMemoryPage)
  const fromSeq =
    str(parsed, 'from') === undefined ? undefined : intOption(parsed, 'from', 1, 1, 2_000_000_000)
  const scopeRaw = str(parsed, 'scope')
  const priorityRaw = str(parsed, 'min-priority')
  const scope = scopeRaw === undefined ? undefined : MemoryScope.safeParse(scopeRaw)
  if (scope !== undefined && !scope.success) throw usageError('--scope debe ser session o project')
  const minPriority = priorityRaw === undefined ? undefined : MemoryPriority.safeParse(priorityRaw)
  if (minPriority !== undefined && !minPriority.success) {
    throw usageError('--min-priority debe ser high, medium o low')
  }
  const client = await ctx.client()
  const r = await client.call('memory.list', {
    cwd,
    limit,
    ...(fromSeq === undefined ? {} : { fromSeq }),
    ...(scope?.success ? { scope: scope.data } : {}),
    ...(minPriority?.success ? { minPriority: minPriority.data } : {}),
  })
  ctx.emit(MemoryListOutput, r, () => {
    const parts: string[] = []
    if (r.reflection !== null) parts.push(reflectionText(r.reflection))
    if (r.observations.length === 0 && r.reflection === null) {
      return 'No hay observaciones en este proyecto. Activa la memoria con NEXO_MEMORY=on (mira el README).'
    }
    if (r.observations.length > 0) parts.push(r.observations.map(observationLine).join('\n'))
    if (r.nextSeq !== null) parts.push(`Hay más: sigue con --from ${r.nextSeq}`)
    return parts.join('\n\n')
  })
}

// ---- search ----

const SEARCH_USAGE = 'nexo memory search [--cwd <ruta>] [--limit N] <consulta...>'

async function memorySearch(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { cwd: { type: 'string' }, limit: { type: 'string' } })
  if (parsed.positionals.length === 0) throw usageError(`uso: ${SEARCH_USAGE}`)
  const query = parsed.positionals.join(' ').trim()
  if (query === '') throw usageError('la consulta está vacía')
  if (query.length > LIMITS.maxMemoryQueryChars) {
    throw usageError(`la consulta pasa de ${LIMITS.maxMemoryQueryChars} caracteres`)
  }
  const cwd = projectCwd(ctx, str(parsed, 'cwd'))
  const limit = intOption(parsed, 'limit', 20, 1, LIMITS.maxMemoryPage)
  const client = await ctx.client()
  const r = await client.call('memory.search', { cwd, query, limit })
  ctx.emit(MemorySearchOutput, r, () => {
    if (r.observations.length === 0) return 'Sin coincidencias.'
    const more = r.truncated ? '\nHay más coincidencias: acota la consulta o sube --limit.' : ''
    return `${r.observations.map(observationLine).join('\n')}${more}`
  })
}

// ---- recall ----

const RECALL_USAGE = 'nexo memory recall <sesión> <desde[-hasta]>'

/** `5`, `5-9`, `5..9` o `5:9` -> rango de bloques. */
export function parseBlockRange(text: string): BlockRange {
  const m = /^(\d{1,5})(?:(?:-|\.\.|:)(\d{1,5}))?$/.exec(text.trim())
  if (m === null) throw usageError(`rango no válido: usa 5, 5-9, 5..9 o 5:9 (${RECALL_USAGE})`)
  const from = Number(m[1])
  const to = m[2] === undefined ? from : Number(m[2])
  if (to < from)
    throw usageError('el rango va al revés: el primer número no puede pasar del segundo')
  if (to - from >= LIMITS.maxRecallBlocks) {
    throw usageError(`el rango pasa de ${LIMITS.maxRecallBlocks} bloques`)
  }
  if (to >= LIMITS.maxBlocksPerSession)
    throw usageError('el rango pasa del final posible del documento')
  return { from, to }
}

async function memoryRecall(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  const [ref, rangeText] = expectPositionals(parsed, 2, 2, RECALL_USAGE) as [string, string]
  const range = parseBlockRange(rangeText)
  const client = await ctx.client()
  const { sessions } = await client.call('agent.list', {})
  const session = resolveSession(sessions, ref)
  const r = await client.call('memory.recall', { sessionId: session.id, range })
  ctx.emit(MemoryRecallOutput, { sessionId: session.id, range, ...r }, () => {
    if (r.blocks.length === 0) return 'El rango no tiene bloques (la sesión es más corta).'
    const printer = new AgentPrinter()
    const out = r.blocks.map(
      (b) => `--- #${b.index} ${b.type} ---\n${printer.feed(b)}${printer.flush()}`,
    )
    if (r.truncated) out.push('(recortado: el rango pasa del tamaño máximo; pide un rango menor)')
    return out.join('\n')
  })
}
