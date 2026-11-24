import {
  type Layout,
  LIMITS,
  type PaneId,
  type SplitDirection,
  type SplitNode,
} from '@atalaya/contracts'

/**
 * Operaciones puras e inmutables sobre el árbol de distribución.
 * `row`: los hijos van de izquierda a derecha; `column`: de arriba abajo.
 * Todas son iterativas (profundidad O(n) sin recursión), así que un árbol de miles de niveles
 * no desborda la pila.
 */

export const MIN_RATIO = 0.05

export type NodePath = readonly number[]
export type Direction = 'left' | 'right' | 'up' | 'down'

export type LayoutErrorCode = 'NOT_FOUND' | 'INVALID_PARAMS' | 'CONFLICT'

export class LayoutError extends Error {
  readonly code: LayoutErrorCode
  constructor(code: LayoutErrorCode, message: string) {
    super(message)
    this.name = 'LayoutError'
    this.code = code
  }
}

export function leaf(paneId: PaneId): Layout {
  return { type: 'leaf', paneId }
}

/** Hojas de izquierda a derecha / de arriba abajo. */
export function leaves(layout: Layout): PaneId[] {
  const out: PaneId[] = []
  const stack: Layout[] = [layout]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.type === 'leaf') out.push(node.paneId)
    else for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as Layout)
  }
  return out
}

/** Camino (índices de hijo desde la raíz) hasta la hoja `paneId`, o `null` si no está. */
export function pathOf(layout: Layout, paneId: PaneId): number[] | null {
  const stack: { node: Layout; path: number[] }[] = [{ node: layout, path: [] }]
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined) break
    if (item.node.type === 'leaf') {
      if (item.node.paneId === paneId) return item.path
    } else {
      for (let i = item.node.children.length - 1; i >= 0; i--) {
        stack.push({ node: item.node.children[i] as Layout, path: [...item.path, i] })
      }
    }
  }
  return null
}

function requirePath(layout: Layout, paneId: PaneId): number[] {
  const path = pathOf(layout, paneId)
  if (path === null) throw new LayoutError('NOT_FOUND', `panel inexistente: ${paneId}`)
  return path
}

export function nodeAt(layout: Layout, path: NodePath): Layout {
  let cur = layout
  for (const i of path) {
    const next = cur.type === 'split' ? cur.children[i] : undefined
    if (next === undefined) throw new LayoutError('NOT_FOUND', 'camino inexistente')
    cur = next
  }
  return cur
}

/** Reemplaza el nodo en `path` reconstruyendo solo los ancestros. */
function replaceAt(layout: Layout, path: NodePath, replacement: Layout | null): Layout | null {
  const ancestors: SplitNode[] = []
  let cur = layout
  for (const i of path) {
    if (cur.type !== 'split') throw new LayoutError('NOT_FOUND', 'camino inexistente')
    ancestors.push(cur)
    cur = cur.children[i] as Layout
  }
  let next = replacement
  for (let d = path.length - 1; d >= 0; d--) {
    const parent = ancestors[d] as SplitNode
    const index = path[d] as number
    if (next === null) {
      const children = parent.children.filter((_, k) => k !== index)
      const ratios = renormalize(parent.ratios.filter((_, k) => k !== index))
      const only = children[0]
      next = children.length === 1 && only !== undefined ? only : { ...parent, children, ratios }
    } else {
      const children = parent.children.slice()
      children[index] = next
      next = { ...parent, children, ratios: parent.ratios.slice() }
    }
  }
  return next
}

function renormalize(ratios: number[]): number[] {
  let sum = 0
  for (const r of ratios) sum += r
  return ratios.map((r) => r / sum)
}

function countLeaves(layout: Layout): number {
  return leaves(layout).length
}

/**
 * Divide el panel `paneId`: el nuevo panel ocupa `ratio` del espacio del original.
 * Si el padre ya divide en la misma dirección, el nuevo panel se inserta como hermano.
 */
export function split(
  layout: Layout,
  paneId: PaneId,
  direction: SplitDirection,
  newPaneId: PaneId,
  ratio = 0.5,
): Layout {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new LayoutError('INVALID_PARAMS', 'ratio debe estar en (0, 1)')
  }
  const path = requirePath(layout, paneId)
  if (pathOf(layout, newPaneId) !== null) {
    throw new LayoutError('CONFLICT', `el panel ya existe: ${newPaneId}`)
  }
  if (countLeaves(layout) + 1 > LIMITS.maxPanesPerTab) {
    throw new LayoutError('CONFLICT', 'demasiados paneles en la pestaña')
  }
  const parentPath = path.slice(0, -1)
  const parent = nodeAt(layout, parentPath)
  if (parent.type === 'split' && parent.direction === direction) {
    const index = path[path.length - 1] as number
    const t = parent.ratios[index] as number
    const children = parent.children.slice()
    children.splice(index + 1, 0, leaf(newPaneId))
    const ratios = parent.ratios.slice()
    ratios.splice(index, 1, t * (1 - ratio), t * ratio)
    return replaceAt(layout, parentPath, { ...parent, children, ratios }) as Layout
  }
  const node: Layout = {
    type: 'split',
    direction,
    children: [leaf(paneId), leaf(newPaneId)],
    ratios: [1 - ratio, ratio],
  }
  return replaceAt(layout, path, node) as Layout
}

/**
 * Cierra un panel. Los hermanos se reparten su espacio en proporción; los nodos que quedan con un
 * solo hijo se colapsan. Devuelve `null` si era el último panel.
 */
export function close(layout: Layout, paneId: PaneId): Layout | null {
  return replaceAt(layout, requirePath(layout, paneId), null)
}

/**
 * Mueve la frontera del panel (o del nodo en `target` si es un camino) con su vecino: delta > 0
 * agranda el panel. El vecino es el siguiente hermano (o el anterior si es el último). Ningún panel
 * baja de `MIN_RATIO` por culpa de este ajuste. `NaN` es un error; ±Infinity se acota.
 */
export function resize(layout: Layout, target: PaneId | NodePath, delta: number): Layout {
  if (Number.isNaN(delta)) throw new LayoutError('INVALID_PARAMS', 'delta no es un número')
  const path = typeof target === 'string' ? requirePath(layout, target) : target
  nodeAt(layout, path)
  if (path.length === 0) return layout
  const parentPath = path.slice(0, -1)
  const parent = nodeAt(layout, parentPath)
  if (parent.type !== 'split') throw new LayoutError('NOT_FOUND', 'camino inexistente')
  const i = path[path.length - 1] as number
  const j = i + 1 < parent.children.length ? i + 1 : i - 1
  const own = parent.ratios[i] as number
  const other = parent.ratios[j] as number
  const maxGrow = other - Math.min(MIN_RATIO, other)
  const maxShrink = own - Math.min(MIN_RATIO, own)
  const d = delta > 0 ? Math.min(delta, maxGrow) : Math.max(delta, -maxShrink)
  const ratios = parent.ratios.slice()
  ratios[i] = own + d
  ratios[j] = other - d
  return replaceAt(layout, parentPath, { ...parent, ratios: renormalize(ratios) }) as Layout
}

/** Intercambia la posición de dos paneles. */
export function swap(layout: Layout, a: PaneId, b: PaneId): Layout {
  const pa = requirePath(layout, a)
  const pb = requirePath(layout, b)
  if (a === b) return layout
  const first = replaceAt(layout, pa, leaf(b)) as Layout
  return replaceAt(first, pb, leaf(a)) as Layout
}

type Rect = { x: number; y: number; w: number; h: number }

function rects(layout: Layout): Map<PaneId, Rect> {
  const out = new Map<PaneId, Rect>()
  const stack: { node: Layout; rect: Rect }[] = [{ node: layout, rect: { x: 0, y: 0, w: 1, h: 1 } }]
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined) break
    const { node, rect } = item
    if (node.type === 'leaf') {
      out.set(node.paneId, rect)
      continue
    }
    let offset = 0
    node.children.forEach((child, i) => {
      const r = node.ratios[i] as number
      stack.push({
        node: child,
        rect:
          node.direction === 'row'
            ? { x: rect.x + offset * rect.w, y: rect.y, w: rect.w * r, h: rect.h }
            : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: rect.h * r },
      })
      offset += r
    })
  }
  return out
}

const EPS = 1e-9

/** Panel adyacente en la dirección dada (geométricamente), o `null` si no hay. */
export function focusNeighbor(layout: Layout, paneId: PaneId, direction: Direction): PaneId | null {
  const all = rects(layout)
  const cur = all.get(paneId)
  if (cur === undefined) throw new LayoutError('NOT_FOUND', `panel inexistente: ${paneId}`)
  const horizontal = direction === 'left' || direction === 'right'
  let best: { id: PaneId; gap: number; overlap: number } | null = null
  for (const id of leaves(layout)) {
    if (id === paneId) continue
    const r = all.get(id) as Rect
    const gap =
      direction === 'right'
        ? r.x - (cur.x + cur.w)
        : direction === 'left'
          ? cur.x - (r.x + r.w)
          : direction === 'down'
            ? r.y - (cur.y + cur.h)
            : cur.y - (r.y + r.h)
    if (gap < -EPS) continue
    const overlap = horizontal
      ? Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y)
      : Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x)
    if (overlap <= EPS) continue
    if (
      best === null ||
      gap < best.gap - EPS ||
      (Math.abs(gap - best.gap) <= EPS && overlap > best.overlap + EPS)
    ) {
      best = { id, gap, overlap }
    }
  }
  return best === null ? null : best.id
}
