import { LayoutSchema, methods, type PaneId, type TabId, Workspace } from '@nexo/contracts'
import { bootHarness, createHarness } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { DomainError } from './errors.ts'

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'OK'
}

describe('WorkspaceService: espacios y pestañas', () => {
  it('crea, lista, renombra y cierra espacios', () => {
    const h = createHarness()
    const { workspace } = h.workspaces.create({ name: 'uno', cwd: '/x' })
    h.workspaces.create({ name: 'dos' })
    expect(h.workspaces.list().workspaces.map((w) => w.name)).toEqual(['uno', 'dos'])
    h.workspaces.rename({ workspaceId: workspace.id, name: 'UNO' })
    expect(h.workspaces.list().workspaces[0]).toMatchObject({ name: 'UNO', cwd: '/x' })
    h.workspaces.close({ workspaceId: workspace.id })
    expect(h.workspaces.list().workspaces.map((w) => w.name)).toEqual(['dos'])
    expect(code(() => h.workspaces.close({ workspaceId: workspace.id }))).toBe('NOT_FOUND')
    expect(code(() => h.workspaces.rename({ workspaceId: workspace.id, name: 'x' }))).toBe(
      'NOT_FOUND',
    )
  })

  it('crea, enfoca, renombra y cierra pestañas', () => {
    const h = createHarness()
    const { workspace } = h.workspaces.create({ name: 'p' })
    const a = h.workspaces.createTab({ workspaceId: workspace.id, title: 'a' }).tab
    const b = h.workspaces.createTab({ workspaceId: workspace.id }).tab
    expect(h.workspaces.list().workspaces[0]?.activeTabId).toBe(b.id)
    h.workspaces.focusTab({ tabId: a.id })
    expect(h.workspaces.list().workspaces[0]?.activeTabId).toBe(a.id)
    h.workspaces.renameTab({ tabId: b.id, title: 'build' })
    expect(h.workspaces.list().workspaces[0]?.tabs.map((t) => t.title)).toEqual(['a', 'build'])
    h.workspaces.closeTab({ tabId: a.id })
    expect(h.workspaces.list().workspaces[0]?.activeTabId).toBe(b.id)
    expect(code(() => h.workspaces.closeTab({ tabId: a.id }))).toBe('NOT_FOUND')
    expect(code(() => h.workspaces.focusTab({ tabId: a.id }))).toBe('NOT_FOUND')
    expect(code(() => h.workspaces.renameTab({ tabId: a.id, title: 'x' }))).toBe('NOT_FOUND')
    expect(code(() => h.workspaces.createTab({ workspaceId: 'no' as typeof workspace.id }))).toBe(
      'NOT_FOUND',
    )
  })

  it('mueve pestañas dentro de un espacio (índice acotado) y entre espacios', () => {
    const h = createHarness()
    const w1 = h.workspaces.create({ name: 'w1' }).workspace
    const w2 = h.workspaces.create({ name: 'w2' }).workspace
    const [a, b, c] = [1, 2, 3].map(
      (i) => h.workspaces.createTab({ workspaceId: w1.id, title: `t${i}` }).tab,
    )
    const order = () => h.workspaces.list().workspaces[0]?.tabs.map((t) => t.title)
    h.workspaces.moveTab({ tabId: (a as { id: TabId }).id, index: 2 })
    expect(order()).toEqual(['t2', 't3', 't1'])
    h.workspaces.moveTab({ tabId: (a as { id: TabId }).id, index: 0 })
    expect(order()).toEqual(['t1', 't2', 't3'])
    h.workspaces.moveTab({ tabId: (c as { id: TabId }).id, index: 1000 })
    expect(order()).toEqual(['t1', 't2', 't3'])
    h.workspaces.moveTab({ tabId: (b as { id: TabId }).id, workspaceId: w2.id, index: 5 })
    const [first, second] = h.workspaces.list().workspaces
    expect(first?.tabs.map((t) => t.title)).toEqual(['t1', 't3'])
    expect(second?.tabs.map((t) => t.title)).toEqual(['t2'])
    expect(second?.activeTabId).toBe((b as { id: TabId }).id)
    expect(first?.activeTabId).toBe((c as { id: TabId }).id)
    const last = h.bus.ofType('layout.changed').at(-1)
    expect(last).toMatchObject({ workspaceId: w2.id, tabId: (b as { id: TabId }).id })
    expect(
      code(() =>
        h.workspaces.moveTab({
          tabId: (a as { id: TabId }).id,
          workspaceId: 'no' as typeof w1.id,
          index: 0,
        }),
      ),
    ).toBe('NOT_FOUND')
  })
})

describe('WorkspaceService: paneles', () => {
  it('divide, enfoca, redimensiona e intercambia con el layout válido', async () => {
    const t = await bootHarness()
    const { pane, layout } = t.workspaces.split({ paneId: t.paneId, direction: 'row', ratio: 0.3 })
    expect(LayoutSchema.safeParse(layout).success).toBe(true)
    expect(pane.kind).toBe('terminal')
    t.workspaces.focusPane({ paneId: t.paneId })
    expect(t.layout.snapshot()[0]?.tabs[0]?.focusedPaneId).toBe(t.paneId)
    const resized = t.workspaces.resizePane({ paneId: t.paneId, delta: 0.1 }).layout
    expect(LayoutSchema.safeParse(resized).success).toBe(true)
    const swapped = t.workspaces.swapPanes({ paneId: t.paneId, otherPaneId: pane.id }).layout
    expect(swapped).toMatchObject({ children: [{ paneId: pane.id }, { paneId: t.paneId }] })
    expect(code(() => t.workspaces.split({ paneId: 'no' as PaneId, direction: 'row' }))).toBe(
      'NOT_FOUND',
    )
    expect(code(() => t.workspaces.split({ paneId: t.paneId, direction: 'row', ratio: 1.5 }))).toBe(
      'INVALID_PARAMS',
    )
  })

  it('cerrar un panel mata su terminal; cerrar el último panel cierra la pestaña', async () => {
    const t = await bootHarness()
    const second = t.workspaces.split({ paneId: t.paneId, direction: 'column' }).pane
    const a = await t.spawn()
    const b = await t.spawn(second.id)
    t.workspaces.closePane({ paneId: second.id })
    expect(b.proc.exited).toBeDefined()
    expect(a.proc.exited).toBeUndefined()
    t.workspaces.closePane({ paneId: t.paneId })
    expect(a.proc.exited).toBeDefined()
    expect(t.layout.snapshot()[0]?.tabs).toEqual([])
    expect(t.terminals.list()).toEqual([])
    expect(t.bus.ofType('layout.changed').at(-1)).toMatchObject({ layout: null, panes: [] })
  })

  it('cerrar una pestaña mata todas sus terminales', async () => {
    const t = await bootHarness()
    const second = t.workspaces.split({ paneId: t.paneId, direction: 'row' }).pane
    const a = await t.spawn()
    const b = await t.spawn(second.id)
    t.workspaces.closeTab({ tabId: t.tab.id })
    expect(a.proc.exited && b.proc.exited).toBeTruthy()
    expect(t.terminals.list()).toEqual([])
  })

  it('cerrar un espacio mata las terminales de todas sus pestañas y emite un cierre por pestaña', async () => {
    const t = await bootHarness()
    const other = t.workspaces.createTab({ workspaceId: t.workspace.id }).tab
    const a = await t.spawn()
    const b = await t.spawn(other.panes[0]?.id)
    const before = t.bus.ofType('layout.changed').length
    t.workspaces.close({ workspaceId: t.workspace.id })
    expect(a.proc.exited && b.proc.exited).toBeTruthy()
    const closes = t.bus.ofType('layout.changed').slice(before)
    expect(closes.map((e) => e.layout)).toEqual([null, null])
    expect(t.terminals.list()).toEqual([])
  })

  it('el estado completo siempre valida con el esquema', async () => {
    const t = await bootHarness()
    t.workspaces.split({ paneId: t.paneId, direction: 'row' })
    await t.spawn()
    expect(Workspace.array().safeParse(t.workspaces.list().workspaces).success).toBe(true)
    expect(methods.snapshot.result.safeParse(t.snapshot.snapshot()).success).toBe(true)
  })
})
