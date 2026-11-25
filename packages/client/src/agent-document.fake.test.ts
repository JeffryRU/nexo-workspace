import type { AgentSession, Block } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import {
  AgentDocument,
  type AgentDocumentClient,
  type AgentDocumentEvent,
} from './agent-document.ts'
import { NexoClientError } from './errors.ts'
import { SID, session, textBlock } from './test-helpers.ts'

type Handler = (data: never) => void

/** Cliente mínimo: `call` lo decide la prueba (sin `onResult`, como un cliente que no lo soporta) y los eventos se empujan a mano. */
function fakeClient(
  snapshot: (from: number) => { blocks: Block[]; nextIndex: number | null; session?: AgentSession },
) {
  const handlers = new Map<string, Set<Handler>>()
  const calls: number[] = []
  let failNext: Error | undefined
  const client = {
    async call(_method: string, params: { fromIndex?: number }) {
      const from = params.fromIndex ?? 0
      calls.push(from)
      if (failNext !== undefined) {
        const e = failNext
        failNext = undefined
        throw e
      }
      const r = snapshot(from)
      return { session: r.session ?? session(), blocks: r.blocks, nextIndex: r.nextIndex }
    },
    on: (event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set<Handler>()
      handlers.set(event, set)
      set.add(handler)
      return () => set.delete(handler)
    },
  } as unknown as AgentDocumentClient
  const emit = (event: string, data: unknown) => {
    for (const h of [...(handlers.get(event) ?? [])]) h(data as never)
  }
  return {
    client,
    emit,
    calls,
    fail: (e: Error) => {
      failNext = e
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('AgentDocument con un cliente mínimo', () => {
  it('aplica la página aunque el cliente no soporte onResult', async () => {
    const f = fakeClient(() => ({ blocks: [textBlock(0, 'a')], nextIndex: null }))
    const doc = await AgentDocument.open(f.client, SID)
    expect(doc.blocks()).toHaveLength(1)
    expect(doc.block(textBlock(0).id)?.type).toBe('text')
    expect(doc.syncing).toBe(false)
  })

  it('un fallo en la primera sincronización rechaza open', async () => {
    const f = fakeClient(() => ({ blocks: [], nextIndex: null }))
    f.fail(new NexoClientError('NOT_FOUND', 'no existe'))
    await expect(AgentDocument.open(f.client, SID)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('un fallo posterior emite error y el siguiente resync recupera; CLOSED se calla', async () => {
    const f = fakeClient(() => ({ blocks: [textBlock(0, 'a')], nextIndex: null }))
    const doc = await AgentDocument.open(f.client, SID)
    const events: AgentDocumentEvent[] = []
    doc.subscribe((e) => events.push(e))
    f.fail(new Error('red caída'))
    f.emit('resync', {})
    await tick()
    expect(events.some((e) => e.type === 'error')).toBe(true)
    f.emit('resync', {})
    await doc.settled()
    expect(events.filter((e) => e.type === 'synced')).toHaveLength(1)
    const before = events.length
    f.fail(new NexoClientError('CLOSED', 'cerrado'))
    f.emit('resync', {})
    await tick()
    expect(events.slice(before).some((e) => e.type === 'error')).toBe(false)
  })

  it('un oyente que lanza no rompe al resto', async () => {
    const f = fakeClient(() => ({ blocks: [], nextIndex: null }))
    const doc = await AgentDocument.open(f.client, SID)
    let n = 0
    doc.subscribe(() => {
      throw new Error('mal oyente')
    })
    const off = doc.subscribe(() => n++)
    f.emit('agent.status', { sessionId: SID, status: 'working', updatedAt: 3 })
    expect(n).toBe(1)
    off()
    f.emit('agent.status', { sessionId: SID, status: 'idle', updatedAt: 4 })
    expect(n).toBe(1)
  })

  it('eventos de otra sesión, status con motivo y sesión nueva', async () => {
    const f = fakeClient(() => ({ blocks: [], nextIndex: null }))
    const doc = await AgentDocument.open(f.client, SID)
    const events: AgentDocumentEvent[] = []
    doc.subscribe((e) => events.push(e))
    const OTHER = 'agent-session-00000099'
    f.emit('agent.status', { sessionId: OTHER, status: 'working', updatedAt: 1 })
    f.emit('agent.session', { sessionId: OTHER, removed: true })
    f.emit('agent.session', { session: session({ id: OTHER as never }) })
    expect(events).toEqual([])
    f.emit('agent.status', { sessionId: SID, status: 'error', updatedAt: 9, reason: 'se rompió' })
    expect(events[0]).toEqual({ type: 'status', status: 'error', reason: 'se rompió' })
    f.emit('agent.session', { session: session({ title: 'nuevo' }) })
    expect(doc.session?.title).toBe('nuevo')
    expect(doc.removed).toBe(false)
  })

  it('pending devuelve permisos y preguntas sin resolver', async () => {
    const perm = {
      ...textBlock(0),
      type: 'permission',
      tool: 'Bash',
      title: 't',
      options: [{ id: 'a', label: 'A', kind: 'allow-once' }],
      state: 'pending',
    } as unknown as Block
    const f = fakeClient(() => ({
      blocks: [perm, { ...perm, id: 'block-00000001', index: 1, state: 'accepted' } as never],
      nextIndex: null,
    }))
    const doc = await AgentDocument.open(f.client, SID)
    expect(doc.pending().map((b) => b.index)).toEqual([0])
  })

  it('un delta inválido (bloque cerrado) pide el documento desde ese bloque', async () => {
    let truth = [textBlock(0, 'fin', { complete: true, seq: 1 })]
    const f = fakeClient(() => ({ blocks: truth, nextIndex: null }))
    const doc = await AgentDocument.open(f.client, SID)
    f.calls.length = 0
    f.emit('agent.delta', {
      sessionId: SID,
      blockId: truth[0]?.id,
      field: 'text',
      seq: 2,
      text: 'x',
    })
    await doc.settled()
    expect(f.calls).toEqual([0])
    truth = []
  })

  it('una petición durante una sincronización se encadena sin solaparse', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let first = true
    const handlers: Handler[] = []
    const calls: number[] = []
    const client = {
      async call(_m: string, params: { fromIndex?: number }) {
        calls.push(params.fromIndex ?? 0)
        if (first) {
          first = false
          await gate
        }
        return { session: session(), blocks: [textBlock(2, 'c')], nextIndex: null }
      },
      on: (event: string, handler: Handler) => {
        if (event === 'agent.block') handlers.push(handler)
        return () => {}
      },
    } as unknown as AgentDocumentClient
    const opening = AgentDocument.open(client, SID)
    await tick()
    // un bloque con hueco llega mientras se sincroniza: no dispara otra pasada...
    handlers[0]?.({ sessionId: SID, block: textBlock(5, 'x') } as never)
    release()
    const doc = await opening
    await doc.settled()
    expect(calls).toEqual([0])
    // ...pero resync() pedido a mano durante una sincronización se encadena
    expect(doc.syncing).toBe(false)
    await Promise.all([doc.resync(), doc.resync()])
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('tras removed no se sincroniza más', async () => {
    const f = fakeClient(() => ({ blocks: [], nextIndex: null }))
    const doc = await AgentDocument.open(f.client, SID)
    f.emit('agent.session', { sessionId: SID, removed: true })
    expect(doc.removed).toBe(true)
    f.calls.length = 0
    f.emit('resync', {})
    await tick()
    expect(f.calls).toEqual([])
  })
})
