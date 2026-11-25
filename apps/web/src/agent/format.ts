import type { TurnUsage } from '@nexo/contracts'

const nf = new Intl.NumberFormat('es', { maximumFractionDigits: 1 })

/** 1 234 → «1,2 k»; solo para tokens. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${nf.format(n / 1_000_000)} M`
  if (n >= 1000) return `${nf.format(n / 1000)} k`
  return String(n)
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${nf.format(s)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s - m * 60)} s`
}

/** Piezas legibles de las métricas de un turno, en orden fijo; las que faltan se omiten. */
export function usageParts(
  usage: TurnUsage,
  labels: { input: string; output: string; cache: string },
): string[] {
  const parts: string[] = []
  if (usage.inputTokens !== undefined)
    parts.push(`${labels.input} ${formatTokens(usage.inputTokens)}`)
  if (usage.outputTokens !== undefined)
    parts.push(`${labels.output} ${formatTokens(usage.outputTokens)}`)
  const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  if (cache > 0) parts.push(`${labels.cache} ${formatTokens(cache)}`)
  if (usage.costUsd !== undefined) parts.push(formatCost(usage.costUsd))
  if (usage.durationMs !== undefined) parts.push(formatDuration(usage.durationMs))
  return parts
}
