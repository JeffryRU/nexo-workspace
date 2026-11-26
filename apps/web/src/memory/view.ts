import type { Block, MemoryUsageTotals } from '@nexo/contracts'

/** Funciones puras de la vista de memoria (F3.5.4): formato de cifras y de rangos, y salto al bloque de origen. */

/** Costo con la precisión justa: los céntimos de un Observador barato se pierden con dos decimales. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`
}

/** `950` -> `950`; `12 345` -> `12,3 k`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  return `${(n / 1000).toFixed(1).replace('.', ',')} k`
}

/** `bloque 5` o `bloques 5 a 9` (los índices del protocolo cuentan desde 0; se muestra el mismo número). */
export function rangeLabel(range: { from: number; to: number }): string {
  return range.from === range.to ? `bloque ${range.from}` : `bloques ${range.from} a ${range.to}`
}

/** Fecha y hora UTC a minutos; `?` si el valor no es una fecha. */
export function formatWhen(ms: number): string {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '?' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function totalUsage(a: MemoryUsageTotals, b: MemoryUsageTotals): MemoryUsageTotals {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  }
}

/**
 * Posición, dentro de los `index` de bloques de un documento (en orden creciente), a la que saltar para ver el
 * origen de una observación: el primer bloque del rango `[from, to]` o, si el rango ya no está (se recortó el
 * documento), el primero posterior. `undefined` si no hay ninguno.
 */
export function locateBlock(
  indexes: readonly (number | undefined)[],
  range: { from: number; to: number },
): number | undefined {
  for (let i = 0; i < indexes.length; i++) {
    const index = indexes[i]
    if (index !== undefined && index >= range.from) return i
  }
  return undefined
}

/**
 * Texto plano de un bloque para mostrar el origen de una observación. Nunca HTML ni Markdown: la interfaz lo
 * pinta como texto, así que lo que haya dentro (etiquetas, órdenes, enlaces) no se interpreta ni se ejecuta.
 */
export function blockPlainText(block: Block): { label: string; text: string } {
  switch (block.type) {
    case 'user':
      return { label: 'usuario', text: block.text }
    case 'text':
      return { label: 'agente', text: block.text }
    case 'reasoning':
      return { label: 'razonamiento', text: block.text }
    case 'action':
      return {
        label: 'acción',
        text: [block.title, block.input, block.output].filter((x) => x !== undefined).join('\n'),
      }
    case 'error':
      return { label: 'error', text: block.message }
    default:
      return { label: block.type, text: '' }
  }
}
