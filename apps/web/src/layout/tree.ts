import {
  type Attention,
  type Layout,
  LIMITS,
  type PaneId,
  type SplitDirection,
} from '@nexo/contracts'

export type Rect = { x: number; y: number; w: number; h: number }
export type Direction = 'left' | 'right' | 'up' | 'down'

/** Paneles del árbol en orden de lectura (iterativo: no desborda la pila con árboles profundos). */
export function paneIdsOf(layout: Layout | null): PaneId[] {
  if (layout === null) return []
  const out: PaneId[] = []
  const stack: Layout[] = [layout]
  while (stack.length > 0) {
    const node = stack.pop() as Layout
    if (node.type === 'leaf') out.push(node.paneId)
    else for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as Layout)
  }
  return out
}

/** Rectángulos (en la unidad) de cada panel según las proporciones del árbol. */
export function paneRects(layout: Layout | null): Map<PaneId, Rect> {
  const rects = new Map<PaneId, Rect>()
  if (layout === null) return rects
  const stack: { node: Layout; rect: Rect }[] = [{ node: layout, rect: { x: 0, y: 0, w: 1, h: 1 } }]
  while (stack.length > 0) {
    const { node, rect } = stack.pop() as { node: Layout; rect: Rect }
    if (node.type === 'leaf') {
      rects.set(node.paneId, rect)
      continue
    }
    let offset = 0
    node.children.forEach((child, i) => {
      const r = node.ratios[i] ?? 0
      stack.push({
        node: child,
        rect:
          node.direction === 'row'
            ? { x: rect.x + offset * rect.w, y: rect.y, w: r * rect.w, h: rect.h }
            : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: r * rect.h },
      })
      offset += r
    })
  }
  return rects
}

const EPS = 1e-9

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

/** Panel vecino en una dirección: el contiguo con mayor solape; `undefined` si no hay. */
export function neighborPane(
  layout: Layout | null,
  from: PaneId,
  direction: Direction,
): PaneId | undefined {
  const rects = paneRects(layout)
  const a = rects.get(from)
  if (a === undefined) return undefined
  let best: { id: PaneId; gap: number; shared: number } | undefined
  for (const id of paneIdsOf(layout)) {
    const b = rects.get(id)
    if (id === from || b === undefined) continue
    let gap: number
    let shared: number
    if (direction === 'left') {
      gap = a.x - (b.x + b.w)
      shared = overlap(a.y, a.y + a.h, b.y, b.y + b.h)
    } else if (direction === 'right') {
      gap = b.x - (a.x + a.w)
      shared = overlap(a.y, a.y + a.h, b.y, b.y + b.h)
    } else if (direction === 'up') {
      gap = a.y - (b.y + b.h)
      shared = overlap(a.x, a.x + a.w, b.x, b.x + b.w)
    } else {
      gap = b.y - (a.y + a.h)
      shared = overlap(a.x, a.x + a.w, b.x, b.x + b.w)
    }
    if (gap < -EPS || shared <= EPS) continue
    if (
      best === undefined ||
      gap < best.gap - EPS ||
      (Math.abs(gap - best.gap) <= EPS && shared > best.shared)
    ) {
      best = { id, gap, shared }
    }
  }
  return best?.id
}

/** Divisor identificado por camino de nodo: la frontera entre los hijos `index` e `index + 1` del split en `path`. */
export type DividerAddress = { path: number[]; index: number }

/**
 * Dirección que se envía a `pane.resize` para el divisor `index` del split en `path`. Todo divisor del árbol
 * es direccionable (entre hojas o entre subárboles); `undefined` solo si el camino pasa del límite del protocolo.
 */
export function dividerAddress(path: readonly number[], index: number): DividerAddress | undefined {
  if (path.length > LIMITS.maxLayoutPathDepth || index < 0) return undefined
  return { path: [...path], index }
}

/** Todos los divisores del árbol (un split de n hijos tiene n-1), en orden de lectura. */
export function dividersOf(layout: Layout | null): DividerAddress[] {
  const out: DividerAddress[] = []
  if (layout === null) return out
  const stack: { node: Layout; path: number[] }[] = [{ node: layout, path: [] }]
  while (stack.length > 0) {
    const { node, path } = stack.pop() as { node: Layout; path: number[] }
    if (node.type !== 'split') continue
    for (let i = 0; i < node.children.length - 1; i++) out.push({ path, index: i })
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i] as Layout, path: [...path, i] })
    }
  }
  return out
}

/** Posición (en %) del divisor `index`: lo que ocupan los hijos hasta él, dentro de su split. */
export function dividerPercent(ratios: readonly number[], index: number): number {
  let sum = 0
  for (let i = 0; i <= index; i++) sum += ratios[i] ?? 0
  return Math.round(sum * 100)
}

const ATTENTION_RANK: Record<Attention, number> = {
  idle: 0,
  done: 1,
  working: 2,
  'needs-input': 3,
  error: 4,
}

/** La atención más urgente de un conjunto de paneles. */
export function aggregateAttention(items: readonly { attention: Attention }[]): Attention {
  let best: Attention = 'idle'
  for (const p of items) if (ATTENTION_RANK[p.attention] > ATTENTION_RANK[best]) best = p.attention
  return best
}

export function isRow(direction: SplitDirection): boolean {
  return direction === 'row'
}
