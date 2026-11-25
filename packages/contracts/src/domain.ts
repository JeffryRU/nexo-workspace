import { z } from 'zod'
import { LIMITS } from './limits.ts'
import { DisplayText } from './text.ts'

const idSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxIdLength)
  .regex(/^[A-Za-z0-9_-]+$/)

export const WorkspaceId = idSchema.brand<'WorkspaceId'>()
export const TabId = idSchema.brand<'TabId'>()
export const PaneId = idSchema.brand<'PaneId'>()
export const TerminalId = idSchema.brand<'TerminalId'>()
export type WorkspaceId = z.infer<typeof WorkspaceId>
export type TabId = z.infer<typeof TabId>
export type PaneId = z.infer<typeof PaneId>
export type TerminalId = z.infer<typeof TerminalId>

export const SplitDirection = z.enum(['row', 'column'])
export type SplitDirection = z.infer<typeof SplitDirection>

export const Attention = z.enum(['idle', 'working', 'needs-input', 'done', 'error'])
export type Attention = z.infer<typeof Attention>

export const PaneKind = z.enum(['terminal', 'agent'])
export type PaneKind = z.infer<typeof PaneKind>

export type LeafNode = { type: 'leaf'; paneId: PaneId }
export type SplitNode = {
  type: 'split'
  direction: SplitDirection
  children: Layout[]
  /** Proporción de cada hijo; misma longitud que `children`, cada una > 0, suma 1 ±1e-6. */
  ratios: number[]
}
export type Layout = LeafNode | SplitNode

const LeafShape = z.strictObject({ type: z.literal('leaf'), paneId: PaneId })
const SplitShape = z.strictObject({
  type: z.literal('split'),
  direction: SplitDirection,
  children: z.array(z.unknown()).min(2).max(LIMITS.maxPanesPerTab),
  ratios: z.array(z.number().gt(0).lte(1)).min(2).max(LIMITS.maxPanesPerTab),
})

export type LayoutIssue = { path: (string | number)[]; message: string }

/**
 * Valida un árbol de distribución sin recursión (no desborda la pila con árboles profundos):
 * forma de cada nodo, hijos >= 2, proporciones que suman 1 ±1e-6, ids de panel únicos y
 * como máximo `maxPanesPerTab` hojas.
 */
export function validateLayout(input: unknown): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const seen = new Set<string>()
  const stack: { node: unknown; path: (string | number)[] }[] = [{ node: input, path: [] }]
  let leaves = 0
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined) break
    const { node, path } = item
    const type = typeof node === 'object' && node !== null ? Reflect.get(node, 'type') : undefined
    if (type === 'leaf') {
      const r = LeafShape.safeParse(node)
      if (!r.success) {
        issues.push({ path, message: 'hoja inválida' })
        continue
      }
      leaves++
      if (seen.has(r.data.paneId)) issues.push({ path, message: 'paneId duplicado' })
      seen.add(r.data.paneId)
      if (leaves > LIMITS.maxPanesPerTab) {
        issues.push({ path, message: 'demasiados paneles' })
        break
      }
    } else if (type === 'split') {
      const r = SplitShape.safeParse(node)
      if (!r.success) {
        issues.push({ path, message: 'división inválida' })
        continue
      }
      const { children, ratios } = r.data
      if (children.length !== ratios.length) {
        issues.push({ path, message: 'children y ratios difieren en longitud' })
        continue
      }
      let sum = 0
      for (const x of ratios) sum += x
      if (Math.abs(sum - 1) > LIMITS.ratioTolerance) {
        issues.push({ path, message: 'las proporciones no suman 1' })
      }
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i], path: [...path, i] })
      }
    } else {
      issues.push({ path, message: 'nodo desconocido' })
    }
  }
  return issues
}

/** Esquema zod de `Layout`; la validación es iterativa (ver `validateLayout`). */
export const LayoutSchema: z.ZodType<Layout> = z.custom<Layout>(
  (v) => validateLayout(v).length === 0,
  { message: 'Layout inválido' },
)

export const Pane = z.strictObject({
  id: PaneId,
  kind: PaneKind,
  title: DisplayText,
  terminalId: TerminalId.optional(),
  attention: Attention,
})
export type Pane = z.infer<typeof Pane>

export const Tab = z.strictObject({
  id: TabId,
  title: DisplayText,
  layout: LayoutSchema,
  panes: z.array(Pane).min(1).max(LIMITS.maxPanesPerTab),
  focusedPaneId: PaneId,
})
export type Tab = z.infer<typeof Tab>

export const Workspace = z.strictObject({
  id: WorkspaceId,
  name: DisplayText,
  cwd: z.string().min(1).max(LIMITS.maxPathLength).optional(),
  tabs: z.array(Tab).max(1024),
  activeTabId: TabId.optional(),
})
export type Workspace = z.infer<typeof Workspace>
