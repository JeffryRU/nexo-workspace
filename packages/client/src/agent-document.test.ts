import { BlockId } from '@nexo/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { agentApi } from './agent-api.ts'
import { AgentDocument, type AgentDocumentEvent } from './agent-document.ts'
import { NexoClient } from './client.ts'
import { FakeServer, SID, snapshotServer, textBlock } from './test-helpers.ts'

const clients: NexoClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})
async function connect(server: FakeServer) {
  const client = new NexoClient({ transport: server.factory, reconnect: { baseMs: 1, maxMs: 2 } })
  clients.push(client)
  await client.connect()
  await client.subscribe()
  return client
}
let seq = 0
const ev = (server: FakeServer, event: string, data: unknown) =>
  server.last.pushEvent(event, ++seq, data)
const fromOf = (r: { params: unknown } | undefined): number | undefined =>
  (r?.params as { fromIndex?: number } | undefined)?.fromIndex

describe('AgentDocument', () => {
  it('carga el documento paginado hasta nextIndex null', async () => {
    seq = 0
    const server = new FakeServer()
    const all = [0, 1, 2, 3, 4].map((n) => textBlock(n, `t${n}`))
    const reqs = snapshotServer(server, () => all, 2)
    const doc = await AgentDocument.open(await connect(server), SID)
    expect(doc.blocks().map((b) => b.index)).toEqual([0, 1, 2, 3, 4])
    expect(reqs.map(fromOf)).toEqual([0, 2, 4])
    expect(doc.session?.id).toBe(SID)
  })

  it('aplica agent.block como upsert y agent.delta en orden; ignora repetidos', async () => {
    seq = 0
    const server = new FakeServer()
    snapshotServer(server, () => [])
    const doc = await AgentDocument.open(await connect(server), SID)
    const events: AgentDocumentEvent[] = []
    doc.subscribe((e) => events.push(e))
    const b = textBlock(0)
    ev(server, 'agent.block', { sessionId: SID, block: b })
    const d = (s: number, text: string) =>
      ev(server, 'agent.delta', { sessionId: SID, blockId: b.id, field: 'text', seq: s, text })
    d(1, 'Ho')
    d(1, 'Ho')
    d(2, 'la')
    expect(doc.blocks()[0]).toMatchObject({ text: 'Hola', seq: 2 })
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(2)
    ev(server, 'agent.block', {
      sessionId: SID,
      block: { ...b, text: 'Hola', seq: 2, complete: true },
    })
    expect(doc.blocks()[0]).toMatchObject({ complete: true })
  })

  it('un hueco de seq pide agent.snapshot desde el index del bloque', async () => {
    seq = 0
    const server = new FakeServer()
    const truth = [textBlock(0, 'a', { complete: true }), textBlock(1, 'xyz', { seq: 3 })]
    const reqs = snapshotServer(server, () => truth, 10)
    const doc = await AgentDocument.open(await connect(server), SID)
    reqs.length = 0
    ev(server, 'agent.block', { sessionId: SID, block: textBlock(1, '') })
    ev(server, 'agent.delta', {
      sessionId: SID,
      blockId: truth[1]?.id,
      field: 'text',
      seq: 3,
      text: 'z',
    })
    await doc.settled()
    expect(fromOf(reqs[0])).toBe(1)
    expect(doc.blocks()[1]).toMatchObject({ text: 'xyz', seq: 3 })
  })

  it('un hueco de index resincroniza desde el primer índice que falta', async () => {
    seq = 0
    const server = new FakeServer()
    const truth = [textBlock(0, 'a', { complete: true }), textBlock(1, 'b', { complete: true })]
    const reqs = snapshotServer(server, () => truth, 10)
    const doc = await AgentDocument.open(await connect(server), SID)
    reqs.length = 0
    ev(server, 'agent.block', { sessionId: SID, block: textBlock(3, 'd', { complete: true }) })
    await doc.settled()
    expect(fromOf(reqs[0])).toBe(2)
  })

  it('tras reconectar sincroniza otra vez y el documento coincide con el snapshot', async () => {
    seq = 0
    const server = new FakeServer()
    let truth = [textBlock(0, 'ho', { seq: 1 })]
    const reqs = snapshotServer(server, () => truth, 10)
    const doc = await AgentDocument.open(await connect(server), SID)
    truth = [
      textBlock(0, 'hola mundo', { seq: 4, complete: true }),
      textBlock(1, 'fin', { complete: true }),
    ]
    server.last.drop()
    for (let i = 0; i < 100 && reqs.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
    await doc.settled()
    expect(doc.blocks().map((b) => b.type === 'text' && b.text)).toEqual(['hola mundo', 'fin'])
  })

  it('agent.session removed marca el documento; agent.status actualiza la sesión', async () => {
    seq = 0
    const server = new FakeServer()
    snapshotServer(server, () => [])
    const doc = await AgentDocument.open(await connect(server), SID)
    ev(server, 'agent.status', { sessionId: SID, status: 'working', updatedAt: 5 })
    expect(doc.session?.status).toBe('working')
    ev(server, 'agent.session', { sessionId: SID, removed: true })
    expect(doc.removed).toBe(true)
    ev(server, 'agent.block', { sessionId: SID, block: textBlock(0) })
    expect(doc.blocks()).toHaveLength(0)
  })

  it('ignora eventos de otra sesión', async () => {
    seq = 0
    const server = new FakeServer()
    snapshotServer(server, () => [])
    const doc = await AgentDocument.open(await connect(server), SID)
    ev(server, 'agent.block', {
      sessionId: 'agent-session-00000099',
      block: textBlock(0),
    })
    ev(server, 'agent.delta', {
      sessionId: 'agent-session-00000099',
      blockId: BlockId.parse('block-00000000'),
      field: 'text',
      seq: 1,
      text: 'x',
    })
    expect(doc.blocks()).toHaveLength(0)
  })

  it('agentApi llama a los métodos agent.*', async () => {
    seq = 0
    const server = new FakeServer()
    const seen: string[] = []
    server.handler = (req) => {
      seen.push(req.method)
      if (req.method === 'agent.list') return { result: { sessions: [] } }
      return undefined
    }
    const api = agentApi(await connect(server))
    expect(await api.list()).toEqual({ sessions: [] })
    expect(seen).toContain('agent.list')
  })
})
