import {
  methods,
  type PaneId,
  type TabId,
  type TerminalId,
  type WorkspaceId,
} from '@nexo/contracts'
import { bootHarness, createHarness, SequentialIds } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { DomainError } from './errors.ts'
import type { IdPort } from './ports/misc.ts'

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'OK'
}

/** Ids que repiten el valor `n` veces antes de avanzar. */
function repeatingIds(kind: 'workspace' | 'tab' | 'pane'): IdPort {
  const base = new SequentialIds()
  const fixed = {
    workspace: 'ws-fijo' as WorkspaceId,
    tab: 'tab-fijo' as TabId,
    pane: 'pane-fijo' as PaneId,
  }
  return {
    workspace: () => (kind === 'workspace' ? fixed.workspace : base.workspace()),
    tab: () => (kind === 'tab' ? fixed.tab : base.tab()),
    pane: () => (kind === 'pane' ? fixed.pane : base.pane()),
    terminal: () => base.terminal(),
    agentSession: () => base.agentSession(),
    block: () => base.block(),
  }
}

describe('WorkspaceService (adversarial): últimos elementos', () => {
  it('cerrar el último panel cierra la pestaña y deja el espacio vacío y válido', async () => {
    const t = await bootHarness()
    await t.spawn()
    t.workspaces.closePane({ paneId: t.paneId })
    const [ws] = t.snapshot.snapshot().workspaces
    expect(ws?.tabs).toEqual([])
    expect(ws?.activeTabId).toBeUndefined()
    expect(methods.snapshot.result.safeParse(t.snapshot.snapshot()).success).toBe(true)
    expect(code(() => t.workspaces.closePane({ paneId: t.paneId }))).toBe('NOT_FOUND')
    // El espacio sigue vivo y admite una pestaña nueva.
    expect(code(() => t.workspaces.createTab({ workspaceId: t.workspace.id }))).toBe('OK')
  })

  it('cerrar la última pestaña y el último espacio no deja terminales', async () => {
    const t = await bootHarness()
    const a = await t.spawn()
    t.workspaces.closeTab({ tabId: t.tab.id })
    expect(a.proc.exited).toBeDefined()
    expect(t.terminals.list()).toEqual([])
    t.workspaces.close({ workspaceId: t.workspace.id })
    expect(t.snapshot.snapshot().workspaces).toEqual([])
    expect(code(() => t.workspaces.closeTab({ tabId: t.tab.id }))).toBe('NOT_FOUND')
  })

  it('cerrar dos veces lo mismo en secuencia rápida solo falla la segunda', async () => {
    const t = await bootHarness()
    const outcomes = [
      code(() => t.workspaces.close({ workspaceId: t.workspace.id })),
      code(() => t.workspaces.close({ workspaceId: t.workspace.id })),
    ]
    expect(outcomes).toEqual(['OK', 'NOT_FOUND'])
  })

  it('ids hostiles dan NOT_FOUND sin tocar el estado', async () => {
    const t = await bootHarness()
    const before = JSON.stringify(t.snapshot.snapshot())
    for (const id of ['__proto__', 'constructor', '', 'x'.repeat(5000)]) {
      expect(code(() => t.workspaces.close({ workspaceId: id as WorkspaceId }))).toBe('NOT_FOUND')
      expect(code(() => t.workspaces.closeTab({ tabId: id as TabId }))).toBe('NOT_FOUND')
      expect(code(() => t.workspaces.closePane({ paneId: id as PaneId }))).toBe('NOT_FOUND')
      expect(code(() => t.workspaces.focusPane({ paneId: id as PaneId }))).toBe('NOT_FOUND')
      expect(
        code(() => t.workspaces.swapPanes({ paneId: t.paneId, otherPaneId: id as PaneId })),
      ).toBe('NOT_FOUND')
    }
    expect(JSON.stringify(t.snapshot.snapshot())).toBe(before)
  })

  it('intercambiar paneles de pestañas distintas falla y no cambia nada', async () => {
    const t = await bootHarness()
    const other = t.workspaces.createTab({ workspaceId: t.workspace.id }).tab
    const before = JSON.stringify(t.snapshot.snapshot())
    expect(
      code(() =>
        t.workspaces.swapPanes({ paneId: t.paneId, otherPaneId: other.panes[0]?.id as PaneId }),
      ),
    ).not.toBe('OK')
    expect(JSON.stringify(t.snapshot.snapshot())).toBe(before)
  })
})

describe('WorkspaceService (adversarial): ids repetidos y límites', () => {
  it('un IdPort que repite id de espacio, de pestaña o de panel da CONFLICT', () => {
    const ws = createHarness({ ids: repeatingIds('workspace') })
    ws.workspaces.create({ name: 'a' })
    expect(code(() => ws.workspaces.create({ name: 'b' }))).toBe('CONFLICT')
    expect(ws.snapshot.snapshot().workspaces).toHaveLength(1)

    const tab = createHarness({ ids: repeatingIds('tab') })
    const w = tab.workspaces.create({ name: 'a' }).workspace
    tab.workspaces.createTab({ workspaceId: w.id })
    expect(code(() => tab.workspaces.createTab({ workspaceId: w.id }))).toBe('CONFLICT')
    expect(tab.snapshot.snapshot().workspaces[0]?.tabs).toHaveLength(1)

    const pane = createHarness({ ids: repeatingIds('pane') })
    const pw = pane.workspaces.create({ name: 'a' }).workspace
    const first = pane.workspaces.createTab({ workspaceId: pw.id }).tab
    expect(code(() => pane.workspaces.createTab({ workspaceId: pw.id }))).toBe('CONFLICT')
    expect(
      code(() => pane.workspaces.split({ paneId: first.panes[0]?.id as PaneId, direction: 'row' })),
    ).toBe('CONFLICT')
    expect(pane.snapshot.snapshot().workspaces[0]?.tabs[0]?.panes).toHaveLength(1)
  })

  it('el máximo de espacios y de pestañas mantiene el snapshot válido', () => {
    const h = createHarness()
    let last = '' as WorkspaceId
    for (let i = 0; i < 1024; i++) last = h.workspaces.create({ name: 'w' }).workspace.id
    expect(code(() => h.workspaces.create({ name: 'extra' }))).toBe('CONFLICT')
    for (let i = 0; i < 1024; i++) h.workspaces.createTab({ workspaceId: last })
    expect(code(() => h.workspaces.createTab({ workspaceId: last }))).toBe('CONFLICT')
    expect(methods.snapshot.result.safeParse(h.snapshot.snapshot()).success).toBe(true)
    // Mover una pestaña a un espacio lleno falla y no la pierde.
    const first = h.layout.snapshot()[0]?.id as WorkspaceId
    const tab = h.workspaces.createTab({ workspaceId: first }).tab
    expect(code(() => h.workspaces.moveTab({ tabId: tab.id, workspaceId: last, index: 0 }))).toBe(
      'CONFLICT',
    )
    expect(h.layout.snapshot()[0]?.tabs.map((t) => t.id)).toEqual([tab.id])
  })

  it('el máximo de paneles por pestaña da CONFLICT sin matar terminales', async () => {
    const t = await bootHarness()
    const { proc } = await t.spawn()
    let pane = t.paneId
    for (let i = 1; i < 1024; i++)
      pane = t.workspaces.split({ paneId: pane, direction: 'row' }).pane.id
    expect(code(() => t.workspaces.split({ paneId: pane, direction: 'row' }))).toBe('CONFLICT')
    expect(proc.exited).toBeUndefined()
    expect(methods.snapshot.result.safeParse(t.snapshot.snapshot()).success).toBe(true)
    t.workspaces.closeTab({ tabId: t.tab.id })
    expect(proc.exited).toBeDefined()
  })

  it('un terminalId repetido de un IdPort malo no deja terminales sin panel', async () => {
    const base = new SequentialIds()
    const ids: IdPort = {
      workspace: () => base.workspace(),
      tab: () => base.tab(),
      pane: () => base.pane(),
      terminal: () => 'igual' as TerminalId,
      agentSession: () => base.agentSession(),
      block: () => base.block(),
    }
    const t = await bootHarness({ ids })
    const second = t.workspaces.split({ paneId: t.paneId, direction: 'row' }).pane
    await t.spawn()
    await t.terminals.spawn({ paneId: second.id, cols: 80, rows: 24 }).catch(() => {})
    t.workspaces.closePane({ paneId: t.paneId })
    expect(t.terminals.list()).toEqual([])
  })
})
