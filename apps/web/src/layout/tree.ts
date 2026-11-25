import type { Attention, Layout, PaneId, SplitDirection } from '@nexo/contracts'

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

export type DividerTarget = { paneId: PaneId; sign: 1 | -1 }

/**
 * `pane.resize` solo mueve la frontera de un panel con su hermano directo (el siguiente, o el anterior si
 * es el último). El divisor entre los hijos `i` e `i+1` se puede manejar si el hijo `i` es una hoja
 * (delta positivo agranda `i`) o si `i+1` es la última hoja (delta negativo agranda `i`). Si no, `undefined`.
 */
export function dividerTarget(
  children: readonly Layout[],
  index: number,
): DividerTarget | undefined {
  const left = children[index]
  const right = children[index + 1]
  if (left?.type === 'leaf') return { paneId: left.paneId, sign: 1 }
  if (right?.type === 'leaf' && index + 1 === children.length - 1) {
    return { paneId: right.paneId, sign: -1 }
  }
  return undefined
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
