import type { MethodResult } from '@nexo/contracts'
import { expectPositionals, parseArgv } from '../args.ts'
import type { Ctx } from '../context.ts'
import { usageError } from '../errors.ts'
import {
  CompanionGetOutput,
  CompanionListOutput,
  CompanionSelectOutput,
  CompanionStateOutput,
} from '../schemas.ts'
import { sanitize } from '../text.ts'

const SUBCOMMANDS = ['list', 'get', 'select', 'none', 'state'] as const

export async function companionCommand(ctx: Ctx, args: string[]): Promise<void> {
  // Las opciones globales pueden ir antes del subcomando (`nexo companion --json list`).
  const at = args.findIndex((a) => !a.startsWith('-'))
  const sub = at === -1 ? undefined : args[at]
  const rest = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 1)]
  switch (sub) {
    case 'list':
      return companionList(ctx, rest)
    case 'get':
      return companionGet(ctx, rest)
    case 'select':
      return companionSelect(ctx, rest)
    case 'none':
      return companionNone(ctx, rest)
    case 'state':
      return companionState(ctx, rest)
    default:
      throw usageError(
        `uso: nexo companion ${SUBCOMMANDS.join('|')} (mira \`nexo companion --help\`)`,
      )
  }
}

const when = (ms: number): string => {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '?' : d.toISOString().slice(0, 19).replace('T', ' ')
}

async function companionList(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  expectPositionals(parsed, 0, 0, 'nexo companion list')
  const client = await ctx.client()
  const result: MethodResult<'companion.list'> = await client.call('companion.list', {})
  ctx.emit(CompanionListOutput, result, () => {
    const lines: string[] = [
      result.selected === null
        ? 'sin mascota (ninguna elegida)'
        : `elegida: ${sanitize(result.selected, 64)}`,
    ]
    for (const c of result.companions) {
      const mark = c.id === result.selected ? '*' : ' '
      const who = `${sanitize(c.author, 80)} · ${sanitize(c.license, 64)}`
      lines.push(
        `${mark} ${sanitize(c.id, 48)}  ${sanitize(c.name, 80)} ${sanitize(c.version, 24)} · ${who}`,
      )
    }
    for (const bad of result.invalid) {
      lines.push(`! ${sanitize(bad.id, 64)}  no válido: ${sanitize(bad.reason, 200)}`)
    }
    if (result.companions.length === 0 && result.invalid.length === 0) {
      lines.push('no hay paquetes en <estado>/companions')
    }
    return lines.join('\n')
  })
}

async function companionGet(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  const [id] = expectPositionals(parsed, 1, 1, 'nexo companion get <id>')
  const client = await ctx.client()
  const result: MethodResult<'companion.get'> = await client.call('companion.get', {
    id: id as string,
  })
  ctx.emit(CompanionGetOutput, result, () => {
    const { manifest: m, assets, totalBytes } = result.companion
    const lines = [
      `${sanitize(m.name, 80)} (${sanitize(m.id, 48)}) ${sanitize(m.version, 24)}`,
      `autor: ${sanitize(m.author.name, 80)} · licencia: ${sanitize(m.license, 64)}`,
    ]
    if (m.description !== undefined) lines.push(sanitize(m.description, 256))
    for (const [state, asset] of Object.entries(m.states)) {
      if (asset === undefined) continue
      const sheet = asset.sheet === undefined ? '' : ` (hoja de ${asset.sheet.frames} cuadros)`
      lines.push(`  ${state}: ${sanitize(asset.src, 128)}${sheet}`)
    }
    lines.push(`${assets.length} recursos, ${totalBytes} bytes`)
    return lines.join('\n')
  })
}

async function select(ctx: Ctx, id: string | null): Promise<void> {
  const client = await ctx.client()
  const result: MethodResult<'companion.select'> = await client.call('companion.select', { id })
  ctx.emit(CompanionSelectOutput, result, () =>
    result.selected === null
      ? 'sin mascota'
      : `compañero elegido: ${sanitize(result.selected, 64)}`,
  )
}

async function companionSelect(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  const [id] = expectPositionals(parsed, 1, 1, 'nexo companion select <id>')
  return select(ctx, id as string)
}

async function companionNone(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  expectPositionals(parsed, 0, 0, 'nexo companion none')
  return select(ctx, null)
}

async function companionState(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  expectPositionals(parsed, 0, 0, 'nexo companion state')
  const client = await ctx.client()
  const result: MethodResult<'companion.state'> = await client.call('companion.state', {})
  const who =
    result.selected === null ? 'sin mascota' : `compañero: ${sanitize(result.selected, 64)}`
  ctx.emit(
    CompanionStateOutput,
    result,
    () => `${result.state} desde ${when(result.since)} UTC · ${who}`,
  )
}
