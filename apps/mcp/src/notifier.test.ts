import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkEvent } from './link.ts'
import { ChangeNotifier } from './notifier.ts'
import { SESSION_ID, session } from './test-helpers.ts'
import { agentStatusUri, URI } from './views.ts'

function make(over: Partial<ConstructorParameters<typeof ChangeNotifier>[0]> = {}) {
  const updated: string[] = []
  const lists = { count: 0 }
  const logs: string[] = []
  const notifier = new ChangeNotifier({
    sendUpdated: async (uri) => {
      updated.push(uri)
    },
    sendListChanged: async () => {
      lists.count++
    },
    logger: (m) => logs.push(m),
    flushMs: 100,
    ...over,
  })
  return { notifier, updated, lists, logs }
}

const status = (id = SESSION_ID): LinkEvent =>
  ({
    name: 'agent.status',
    data: { sessionId: id, status: 'working', updatedAt: 1 },
  }) as LinkEvent

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ChangeNotifier', () => {
  it('solo avisa de las URIs suscritas', async () => {
    const { notifier, updated } = make()
    notifier.subscribe(URI.attention)
    notifier.handle(status())
    await vi.advanceTimersByTimeAsync(150)
    expect(updated).toEqual([URI.attention])
  })

  it('junta una avalancha de eventos en un aviso por URI', async () => {
    const { notifier, updated } = make()
    notifier.subscribe(URI.attention)
    notifier.subscribe(agentStatusUri(SESSION_ID))
    for (let i = 0; i < 10_000; i++) notifier.handle(status())
    await vi.advanceTimersByTimeAsync(150)
    expect(updated.sort()).toEqual([URI.attention, agentStatusUri(SESSION_ID)].sort())
    // pasado el plazo, un evento nuevo vuelve a avisar
    notifier.handle(status())
    await vi.advanceTimersByTimeAsync(150)
    expect(updated).toHaveLength(4)
  })

  it('unsubscribe cancela lo pendiente', async () => {
    const { notifier, updated } = make()
    notifier.subscribe(URI.attention)
    notifier.handle(status())
    notifier.unsubscribe(URI.attention)
    await vi.advanceTimersByTimeAsync(150)
    expect(updated).toEqual([])
  })

  it('respeta el tope de suscripciones y rechaza URIs inválidas', () => {
    const { notifier } = make({ maxSubscriptions: 2 })
    expect(notifier.subscribe('nexo://a')).toBe(true)
    expect(notifier.subscribe('nexo://b')).toBe(true)
    expect(notifier.subscribe('nexo://c')).toBe(false)
    expect(notifier.subscribe('nexo://a')).toBe(true)
    expect(notifier.subscribe('no es uri')).toBe(false)
    expect(notifier.subscriptionCount).toBe(2)
    notifier.unsubscribe('no es uri')
  })

  it('avisa del cambio de la lista con sesiones nuevas aunque nadie se suscriba', async () => {
    const { notifier, lists } = make()
    notifier.handle({
      name: 'agent.session',
      data: { session: session({ id: 'agent-nueva' }) },
    } as LinkEvent)
    await vi.advanceTimersByTimeAsync(150)
    expect(lists.count).toBe(1)
    // ya conocida: no vuelve a avisar
    notifier.handle({
      name: 'agent.session',
      data: { session: session({ id: 'agent-nueva' }) },
    } as LinkEvent)
    await vi.advanceTimersByTimeAsync(150)
    expect(lists.count).toBe(1)
    notifier.handle({
      name: 'agent.session',
      data: { sessionId: 'agent-nueva', removed: true },
    } as LinkEvent)
    await vi.advanceTimersByTimeAsync(150)
    expect(lists.count).toBe(2)
  })

  it('un resync o una reconexión marcan todo lo suscrito', async () => {
    const { notifier, updated } = make()
    notifier.subscribe(URI.limits)
    notifier.subscribe(agentStatusUri(SESSION_ID))
    notifier.handle({ name: 'resync' })
    await vi.advanceTimersByTimeAsync(150)
    expect(updated.sort()).toEqual([URI.limits, agentStatusUri(SESSION_ID)].sort())
    notifier.markAllSubscribed()
    await vi.advanceTimersByTimeAsync(150)
    expect(updated).toHaveLength(4)
  })

  it('un envío fallido se registra y no corta los demás', async () => {
    const sent: string[] = []
    const { notifier, logs } = make({
      sendUpdated: async (uri) => {
        if (uri === URI.attention) throw new Error('canal cerrado')
        sent.push(uri)
      },
      sendListChanged: async () => {
        throw new Error('lista')
      },
    })
    notifier.subscribe(URI.attention)
    notifier.subscribe(URI.workspaces)
    notifier.handle({ name: 'pane.attention', data: {} } as LinkEvent)
    notifier.handle({ name: 'resync' })
    await vi.advanceTimersByTimeAsync(150)
    expect(sent).toContain(URI.workspaces)
    expect(logs.some((l) => l.includes('canal cerrado'))).toBe(true)
    expect(logs.some((l) => l.includes('lista'))).toBe(true)
  })

  it('tras dispose no avisa nada', async () => {
    const { notifier, updated } = make()
    notifier.subscribe(URI.attention)
    notifier.handle(status())
    notifier.dispose()
    notifier.handle(status())
    notifier.markAllSubscribed()
    await vi.advanceTimersByTimeAsync(500)
    expect(updated).toEqual([])
  })

  it('acota la memoria de sesiones conocidas', () => {
    const { notifier } = make()
    const ids = Array.from({ length: 3000 }, (_, i) => `agent-${i}`)
    expect(() => notifier.rememberAgents(ids)).not.toThrow()
  })
})
