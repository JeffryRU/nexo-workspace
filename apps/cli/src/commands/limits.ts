import type { MethodResult, UsageWindow } from '@nexo/contracts'
import { flag, parseArgv, str } from '../args.ts'
import type { Ctx } from '../context.ts'
import { usageError } from '../errors.ts'
import { LimitsOutput } from '../schemas.ts'
import { sanitize } from '../text.ts'

const USAGE = 'nexo limits [--provider <id>] [--refresh] [--json]'

const when = (ms: number): string => {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '?' : d.toISOString().slice(0, 16).replace('T', ' ')
}

const duration = (minutes: number): string =>
  minutes % 1440 === 0
    ? `${minutes / 1440} d`
    : minutes % 60 === 0
      ? `${minutes / 60} h`
      : `${minutes} min`

function windowLine(w: UsageWindow): string {
  const name = sanitize(w.label ?? `${w.bucket === undefined ? '' : `${w.bucket} `}${w.id}`, 80)
  const parts = [`${name}: ${Math.round(w.usedPercent)} % usado`]
  if (w.windowMinutes !== undefined) parts.push(`ventana ${duration(w.windowMinutes)}`)
  if (w.resetsAt !== undefined) parts.push(`se reinicia ${when(w.resetsAt)} UTC`)
  if (w.state === 'limit') parts.push('LÍMITE ALCANZADO')
  else if (w.state === 'warning') parts.push('aviso')
  return `  ${parts.join(' · ')}`
}

const SOURCES = {
  query: 'consulta directa',
  notification: 'aviso del proveedor',
  session: 'evento de una sesión',
} as const

export async function limitsCommand(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { provider: { type: 'string' }, refresh: { type: 'boolean' } })
  if (parsed.positionals.length > 0) throw usageError(`uso: ${USAGE}`)
  const provider = str(parsed, 'provider')
  const client = await ctx.client()
  const result: MethodResult<'limits.status'> = await client.call('limits.status', {
    ...(provider === undefined ? {} : { provider }),
    ...(flag(parsed, 'refresh') ? { refresh: true } : {}),
  })
  ctx.emit(LimitsOutput, result, () => {
    const lines: string[] = []
    for (const p of result.providers) {
      lines.push(sanitize(p.provider, 32))
      if (p.status === 'ok' || p.windows.length > 0) {
        for (const w of p.windows) lines.push(windowLine(w))
        const origin = p.source === undefined ? '' : SOURCES[p.source]
        const seen = p.observedAt === undefined ? '' : ` el ${when(p.observedAt)} UTC`
        const stale = p.fresh === false ? ' (puede estar desactualizado)' : ''
        if (origin !== '') lines.push(`  origen: ${origin}${seen}${stale}`)
      } else {
        lines.push(`  ${p.status === 'unknown' ? 'desconocido' : p.status}`)
      }
      if (p.reason !== undefined) lines.push(`  ${sanitize(p.reason, 300)}`)
    }
    if (lines.length === 0) lines.push('no hay proveedores')
    return lines.join('\n')
  })
}
