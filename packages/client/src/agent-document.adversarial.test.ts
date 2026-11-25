import { afterEach, describe, expect, it } from 'vitest'
import { AgentDocument } from './agent-document.ts'
import { NexoClient } from './client.ts'
import { FakeServer, SID, session, snapshotServer, textBlock } from './test-helpers.ts'

const clients: NexoClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})
async function connect(server: FakeServer, reconnect = false) {
  const client = new NexoClient({
    transport: server.factory,
    reconnect: reconnect ? { baseMs: 1, maxMs: 2 } : false,
  })
  clients.push(client)
  await client.connect()
  await client.subscribe()
  return client
}
let seq = 0
const ev = (server: FakeServer, event: string, data: unknown) =>
  server.last.pushEvent(event, ++seq, data)

describe('AgentDocument: servidor y red hostiles', () => {
  it('páginas de un solo bloque (limit ignorado) siguen funcionando', async () => {
    seq = 0
    const server = new FakeServer()
    const all = Array.from({ length: 30 }, (_, n) => textBlock(n, `x${n}`))
    snapshotServer(server, () => all, 1)
    const doc = await AgentDocument.open(await connect(server), SID, { pageSize: 5 })
    expect(doc.blocks()).toHaveLength(30)
  })

  it('un nextIndex que no avanza rechaza sin bucle infinito', async () => {
    seq = 0
    const server = new FakeServer()
    server.handler = (req) =>
      req.method === 'agent.snapshot'
        ? { result: { session: session(), blocks: [textBlock(0)], nextIndex: 0 } }
        : undefined
    await expect(AgentDocument.open(await connect(server), SID)).rejects.toThrow(/avanza/)
  })

  it('un servidor que pagina sin fin se corta por maxPages', async () => {
    seq = 0
    const server = new FakeServer()
    let n = 0
    server.handler = (req) =>
      req.method === 'agent.snapshot'
        ? { result: { session: session(), blocks: [], nextIndex: ++n } }
        : undefined
    await expect(AgentDocument.open(await connect(server), SID, { maxPages: 5 })).rejects.toThrow(
      /no termina/,
    )
    expect(n).toBe(5)
  })

  it('bloques desordenados o de otra sesión en el snapshot rechazan', async () => {
    seq = 0
    const server = new FakeServer()
    server.handler = (req) =>
      req.method === 'agent.snapshot'
        ? {
            result: {
              session: session(),
              blocks: [textBlock(2), textBlock(1)],
              nextIndex: null,
            },
          }
        : undefined
    await expect(AgentDocument.open(await connect(server), SID)).rejects.toThrow(/desordenados/)

    const other = new FakeServer()
    other.handler = (req) =>
      req.method === 'agent.snapshot'
        ? {
            result: {
              session: session({ id: 'agent-session-00000077' as never }),
              blocks: [],
              nextIndex: null,
            },
          }
        : undefined
    await expect(AgentDocument.open(await connect(other), SID)).rejects.toThrow(/otra sesión/)
  })

  it('el servidor corta en medio de la paginación: open rechaza y el siguiente resync recupera', async () => {
    seq = 0
    const server = new FakeServer()
    const all = [0, 1, 2, 3].map((n) => textBlock(n, `t${n}`, { complete: true }))
    const reqs = snapshotServer(server, () => all, 2)
    const base = server.handler
    let cut = true
    server.handler = (req, t) => {
      if (req.method === 'agent.snapshot' && cut && reqs.length === 1) {
        reqs.push(req)
        t.drop()
        return 'silent'
      }
      return base(req, t)
    }
    const client = await connect(server, true)
    const opened = AgentDocument.open(client, SID)
    await expect(opened).rejects.toBeDefined()
    cut = false
    // un documento nuevo tras reconectar queda completo
    for (let i = 0; i < 100 && client.state !== 'open'; i++)
      await new Promise((r) => setTimeout(r, 5))
    const doc = await AgentDocument.open(client, SID)
    expect(doc.blocks()).toHaveLength(4)
  })

  it('deltas repetidos, adelantados y de bloque cerrado nunca corrompen el texto', async () => {
    seq = 0
    const server = new FakeServer()
    const truth = [textBlock(0, 'abc', { seq: 3 })]
    const reqs = snapshotServer(server, () => truth, 5)
    const doc = await AgentDocument.open(await connect(server), SID)
    const id = truth[0]?.id
    const d = (s: number, text: string) =>
      ev(server, 'agent.delta', { sessionId: SID, blockId: id, field: 'text', seq: s, text })
    d(3, 'c')
    d(2, 'b')
    d(1, 'a')
    expect(doc.blocks()[0]).toMatchObject({ text: 'abc', seq: 3 })
    expect(reqs).toHaveLength(1)
    d(9, 'zzz') // hueco
    await doc.settled()
    expect(doc.blocks()[0]).toMatchObject({ text: 'abc' })
  })

  it('avalancha de eventos con sincronización en curso no deja el documento a medias', async () => {
    seq = 0
    const server = new FakeServer()
    const truth = [textBlock(0, 'x'.repeat(5), { seq: 5 })]
    snapshotServer(server, () => truth, 5)
    const doc = await AgentDocument.open(await connect(server), SID)
    for (let i = 0; i < 200; i++) {
      ev(server, 'agent.delta', {
        sessionId: SID,
        blockId: truth[0]?.id,
        field: 'text',
        seq: 100 + i,
        text: 'q',
      })
    }
    await doc.settled()
    expect(doc.blocks()[0]).toMatchObject({ text: 'xxxxx', seq: 5 })
    expect(doc.syncing).toBe(false)
  })

  it('después de dispose no emite ni reacciona', async () => {
    seq = 0
    const server = new FakeServer()
    snapshotServer(server, () => [])
    const doc = await AgentDocument.open(await connect(server), SID)
    let n = 0
    doc.subscribe(() => n++)
    doc.dispose()
    ev(server, 'agent.block', { sessionId: SID, block: textBlock(0) })
    expect(n).toBe(0)
    expect(doc.blocks()).toHaveLength(0)
  })
})
