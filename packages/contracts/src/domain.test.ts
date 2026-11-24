import { describe, expect, it } from 'vitest'
import {
  Attention,
  type Layout,
  LayoutSchema,
  LIMITS,
  Pane,
  PaneId,
  Tab,
  validateLayout,
  Workspace,
} from './index.ts'

const leaf = (id: string): Layout => ({ type: 'leaf', paneId: PaneId.parse(id) })
const row = (children: Layout[], ratios: number[]): Layout => ({
  type: 'split',
  direction: 'row',
  children,
  ratios,
})

describe('Layout', () => {
  it('acepta una hoja y divisiones anidadas', () => {
    expect(LayoutSchema.safeParse(leaf('a')).success).toBe(true)
    const tree = row([leaf('a'), row([leaf('b'), leaf('c')], [0.25, 0.75])], [0.5, 0.5])
    expect(LayoutSchema.safeParse(tree).success).toBe(true)
  })

  it('rechaza menos de 2 hijos, ratios que no suman 1, longitudes distintas y ratios <= 0', () => {
    const cases: unknown[] = [
      row([leaf('a')], [1]),
      row([leaf('a'), leaf('b')], [0.5, 0.6]),
      row([leaf('a'), leaf('b')], [1]),
      row([leaf('a'), leaf('b')], [0, 1]),
      row([leaf('a'), leaf('b')], [-0.5, 1.5]),
      row([leaf('a'), leaf('b')], [Number.NaN, 0.5]),
    ]
    for (const c of cases) expect(LayoutSchema.safeParse(c).success).toBe(false)
  })

  it('tolera suma 1 ±1e-6 y rechaza fuera de la tolerancia', () => {
    expect(validateLayout(row([leaf('a'), leaf('b')], [0.5, 0.5 + 9e-7]))).toEqual([])
    expect(validateLayout(row([leaf('a'), leaf('b')], [0.5, 0.5 + 2e-6]))).not.toEqual([])
  })

  it('rechaza ids duplicados, nodos desconocidos y claves extra', () => {
    expect(validateLayout(row([leaf('a'), leaf('a')], [0.5, 0.5]))[0]?.message).toContain(
      'duplicado',
    )
    expect(validateLayout({ type: 'otro' })).not.toEqual([])
    expect(validateLayout(null)).not.toEqual([])
    expect(validateLayout({ ...leaf('a'), extra: 1 })).not.toEqual([])
    expect(validateLayout({ type: 'leaf', paneId: '' })).not.toEqual([])
    expect(
      validateLayout({ type: 'split', direction: 'diag', children: [], ratios: [] }),
    ).not.toEqual([])
  })

  it('valida árboles de 1000 niveles sin desbordar la pila y limita el número de paneles', () => {
    let tree: Layout = leaf('p0')
    for (let i = 1; i <= 1000; i++) tree = row([tree, leaf(`p${i}`)], [0.5, 0.5])
    expect(validateLayout(tree)).toEqual([])
    const wide = row(
      Array.from({ length: LIMITS.maxPanesPerTab + 1 }, (_, i) => leaf(`w${i}`)),
      Array.from({ length: LIMITS.maxPanesPerTab + 1 }, () => 1 / (LIMITS.maxPanesPerTab + 1)),
    )
    expect(validateLayout(wide)).not.toEqual([])
    const manyLeaves = row(
      [
        row(
          Array.from({ length: 600 }, (_, i) => leaf(`a${i}`)),
          Array.from({ length: 600 }, () => 1 / 600),
        ),
        row(
          Array.from({ length: 600 }, (_, i) => leaf(`b${i}`)),
          Array.from({ length: 600 }, () => 1 / 600),
        ),
      ],
      [0.5, 0.5],
    )
    expect(validateLayout(manyLeaves).some((i) => i.message === 'demasiados paneles')).toBe(true)
  })
})

describe('Pane, Tab, Workspace, Attention', () => {
  const pane = { id: 'p1', kind: 'terminal', title: 'Terminal', attention: 'idle' }

  it('Pane: kind terminal|agent y attention válidos', () => {
    expect(Pane.safeParse(pane).success).toBe(true)
    expect(Pane.safeParse({ ...pane, kind: 'viewer' }).success).toBe(false)
    expect(Pane.safeParse({ ...pane, attention: 'sleeping' }).success).toBe(false)
    expect(Pane.safeParse({ ...pane, terminalId: 't1' }).success).toBe(true)
    for (const a of ['idle', 'working', 'needs-input', 'done', 'error']) {
      expect(Attention.safeParse(a).success).toBe(true)
    }
  })

  it('Tab y Workspace anidan correctamente', () => {
    const tab = {
      id: 't1',
      title: 'Pestaña 1',
      layout: leaf('p1'),
      panes: [pane],
      focusedPaneId: 'p1',
    }
    expect(Tab.safeParse(tab).success).toBe(true)
    expect(Tab.safeParse({ ...tab, panes: [] }).success).toBe(false)
    const ws = { id: 'w1', name: 'proyecto', cwd: '/home/x', tabs: [tab], activeTabId: 't1' }
    expect(Workspace.safeParse(ws).success).toBe(true)
    expect(Workspace.safeParse({ ...ws, cwd: '' }).success).toBe(false)
  })
})
