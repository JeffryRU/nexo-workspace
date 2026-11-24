import { LayoutSchema, PaneId, Tab, TabId, WorkspaceId } from '@atalaya/contracts'
import { RecordingEventBus, SequentialIds } from '@atalaya/testkit'
import { describe, expect, it } from 'vitest'
import { LayoutError } from './layout.ts'
import { LayoutService } from './layout-service.ts'

function setup() {
  const bus = new RecordingEventBus()
  const service = new LayoutService({ ids: new SequentialIds(), bus })
  const ws = service.createWorkspace('proyecto', '/work')
  return { bus, service, ws }
}

describe('LayoutService', () => {
  it('crea una pestaña con un panel de terminal y emite layout.changed', () => {
    const { bus, service, ws } = setup()
    const tab = service.createTab(ws.id)
    expect(tab.panes).toHaveLength(1)
    expect(tab.panes[0]?.kind).toBe('terminal')
    expect(tab.title).toBe('Pestaña 1')
    expect(Tab.safeParse(tab).success).toBe(true)
    const events = bus.ofType('layout.changed')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      workspaceId: ws.id,
      tabId: tab.id,
      focusedPaneId: tab.focusedPaneId,
    })
    expect(service.snapshot()[0]?.activeTabId).toBe(tab.id)
  })

  it('acepta un título propio y numera las pestañas por omisión', () => {
    const { service, ws } = setup()
    expect(service.createTab(ws.id, 'build').title).toBe('build')
    expect(service.createTab(ws.id).title).toBe('Pestaña 2')
  })

  it('divide un panel: nuevo panel con foco, layout válido y evento', () => {
    const { bus, service, ws } = setup()
    const tab = service.createTab(ws.id)
    const first = tab.focusedPaneId
    const pane = service.split(first, 'row', 'agent', 0.3)
    expect(pane.kind).toBe('agent')
    const current = service.snapshot()[0]?.tabs[0]
    expect(current?.panes.map((p) => p.id)).toEqual([first, pane.id])
    expect(current?.focusedPaneId).toBe(pane.id)
    expect(LayoutSchema.safeParse(current?.layout).success).toBe(true)
    const last = bus.ofType('layout.changed').at(-1)
    expect(last?.layout).toEqual(current?.layout)
    expect(last?.panes).toHaveLength(2)
  })

  it('cerrar un panel mueve el foco y emite; cerrar el último cierra la pestaña', () => {
    const { bus, service, ws } = setup()
    const tab = service.createTab(ws.id)
    const first = tab.focusedPaneId
    const second = service.split(first, 'row')
    service.closePane(second.id)
    expect(service.snapshot()[0]?.tabs[0]?.focusedPaneId).toBe(first)
    expect(service.snapshot()[0]?.tabs[0]?.layout).toEqual({ type: 'leaf', paneId: first })
    service.closePane(first)
    expect(service.snapshot()[0]?.tabs).toEqual([])
    expect(service.snapshot()[0]?.activeTabId).toBeUndefined()
    expect(bus.ofType('layout.changed').at(-1)).toMatchObject({
      layout: null,
      panes: [],
      focusedPaneId: null,
    })
  })

  it('cerrar un panel no enfocado conserva el foco', () => {
    const { service, ws } = setup()
    const first = service.createTab(ws.id).focusedPaneId
    const second = service.split(first, 'row')
    const third = service.split(second.id, 'column')
    service.focusPane(first)
    service.closePane(third.id)
    expect(service.snapshot()[0]?.tabs[0]?.focusedPaneId).toBe(first)
  })

  it('cerrar el panel enfocado del principio pasa el foco al siguiente', () => {
    const { service, ws } = setup()
    const first = service.createTab(ws.id).focusedPaneId
    const second = service.split(first, 'row')
    service.focusPane(first)
    service.closePane(first)
    expect(service.snapshot()[0]?.tabs[0]?.focusedPaneId).toBe(second.id)
  })

  it('enfoca paneles y pestañas', () => {
    const { bus, service, ws } = setup()
    const t1 = service.createTab(ws.id)
    const t2 = service.createTab(ws.id)
    const second = service.split(t1.focusedPaneId, 'row')
    service.focusPane(t1.focusedPaneId)
    expect(service.snapshot()[0]?.tabs[0]?.focusedPaneId).toBe(t1.focusedPaneId)
    service.focusTab(t1.id)
    expect(service.snapshot()[0]?.activeTabId).toBe(t1.id)
    const before = bus.events.length
    service.focusTab(t2.id)
    expect(bus.events.length).toBe(before + 1)
    expect(second.kind).toBe('terminal')
  })

  it('cerrar una pestaña activa activa la vecina', () => {
    const { service, ws } = setup()
    const t1 = service.createTab(ws.id)
    const t2 = service.createTab(ws.id)
    const t3 = service.createTab(ws.id)
    service.focusTab(t2.id)
    service.closeTab(t2.id)
    expect(service.snapshot()[0]?.activeTabId).toBe(t3.id)
    service.closeTab(t3.id)
    expect(service.snapshot()[0]?.activeTabId).toBe(t1.id)
    service.createTab(ws.id)
    service.closeTab(t1.id)
    expect(service.snapshot()[0]?.tabs).toHaveLength(1)
  })

  it('cerrar una pestaña no activa conserva la activa', () => {
    const { service, ws } = setup()
    const t1 = service.createTab(ws.id)
    const t2 = service.createTab(ws.id)
    service.closeTab(t1.id)
    expect(service.snapshot()[0]?.activeTabId).toBe(t2.id)
  })

  it('resize y swap actualizan el layout y emiten', () => {
    const { bus, service, ws } = setup()
    const first = service.createTab(ws.id).focusedPaneId
    const second = service.split(first, 'row')
    const resized = service.resizePane(first, 0.2)
    expect(resized.type === 'split' && resized.ratios[0]).toBeCloseTo(0.7)
    const swapped = service.swapPanes(first, second.id)
    expect(swapped.type === 'split' && swapped.children[0]).toEqual({
      type: 'leaf',
      paneId: second.id,
    })
    expect(bus.ofType('layout.changed').length).toBeGreaterThanOrEqual(4)
  })

  it('un suscriptor recibe los eventos en orden', () => {
    const { bus, service, ws } = setup()
    const seen: string[] = []
    bus.subscribe((e) => seen.push(e.event))
    const tab = service.createTab(ws.id)
    service.split(tab.focusedPaneId, 'column')
    expect(seen).toEqual(['layout.changed', 'layout.changed'])
  })
})

describe('LayoutService adversarial', () => {
  it('ids inexistentes lanzan LayoutError NOT_FOUND y no emiten', () => {
    const { bus, service, ws } = setup()
    service.createTab(ws.id)
    const before = bus.events.length
    const ghostPane = PaneId.parse('fantasma')
    const ghostTab = TabId.parse('fantasma')
    const ghostWs = WorkspaceId.parse('fantasma')
    const calls = [
      () => service.createTab(ghostWs),
      () => service.split(ghostPane, 'row'),
      () => service.closePane(ghostPane),
      () => service.closeTab(ghostTab),
      () => service.focusPane(ghostPane),
      () => service.focusTab(ghostTab),
      () => service.resizePane(ghostPane, 0.1),
      () => service.swapPanes(ghostPane, ghostPane),
    ]
    for (const call of calls) {
      expect(call).toThrow(LayoutError)
    }
    expect(bus.events.length).toBe(before)
  })

  it('ratio y delta inválidos no alteran el estado', () => {
    const { bus, service, ws } = setup()
    const first = service.createTab(ws.id).focusedPaneId
    const snapshot = JSON.stringify(service.snapshot())
    const before = bus.events.length
    expect(() => service.split(first, 'row', 'terminal', 2)).toThrow(LayoutError)
    expect(() => service.split(first, 'row', 'terminal', Number.NaN)).toThrow(LayoutError)
    expect(() => service.resizePane(first, Number.NaN)).toThrow(LayoutError)
    expect(JSON.stringify(service.snapshot())).toBe(snapshot)
    expect(bus.events.length).toBe(before)
  })

  it('cerrar el mismo panel dos veces: la segunda falla sin dañar el estado', () => {
    const { service, ws } = setup()
    const first = service.createTab(ws.id).focusedPaneId
    const second = service.split(first, 'row')
    service.closePane(second.id)
    expect(() => service.closePane(second.id)).toThrow(LayoutError)
    expect(service.snapshot()[0]?.tabs[0]?.panes).toHaveLength(1)
  })

  it('muchas divisiones y cierres alternados mantienen los paneles y el layout consistentes', () => {
    const { service, ws } = setup()
    let focused = service.createTab(ws.id).focusedPaneId
    for (let i = 0; i < 200; i++) {
      focused = service.split(focused, i % 2 ? 'row' : 'column').id
    }
    const panes = service.snapshot()[0]?.tabs[0]?.panes ?? []
    expect(panes).toHaveLength(201)
    for (const pane of panes.filter((_, i) => i % 2 === 0)) service.closePane(pane.id)
    const tab = service.snapshot()[0]?.tabs[0]
    expect(tab?.panes).toHaveLength(100)
    expect(Tab.safeParse(tab).success).toBe(true)
  })
})
