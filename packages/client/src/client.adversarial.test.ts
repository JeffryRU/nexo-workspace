import type { PaneId } from '@nexo/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backoffDelay } from './backoff.ts'
import { NexoClient } from './client.ts'
import type { NexoClientError } from './errors.ts'
import { FakeServer, tick } from './test-helpers.ts'

const clients: NexoClient[] = []
function make(
  server: FakeServer,
  options: Partial<ConstructorParameters<typeof NexoClient>[0]> = {},
) {
  const client = new NexoClient({ transport: server.factory, ...options })
  clients.push(client)
  return client
}
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
  vi.useRealTimers()
})

const delaysFrom = (sink: number[]) => (_level: string, message: string) => {
  const hit = /reconectando en (\d+) ms/.exec(message)
  if (hit) sink.push(Number(hit[1]))
}

describe('cliente frente a un servidor hostil', () => {
  it('sobrevive a JSON roto, mensajes no objeto y claves reservadas', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    const errors: NexoClientError[] = []
    client.on('error', (e) => errors.push(e))
    for (const raw of [
      '{',
      'null',
      '42',
      '[]',
      '"x"',
      '{"__proto__":{"a":1},"v":1}',
      '',
      '\u0000',
    ]) {
      server.last.push(raw)
    }
    expect(errors.length).toBeGreaterThan(0)
    expect((await client.call('daemon.info', {})).protocol).toBe(1)
  })

  it('ignora respuestas con ids desconocidos, repetidos o de otro tipo', async () => {
    const server = new FakeServer()
    server.handler = (req) => (req.method === 'snapshot' ? 'silent' : undefined)
    const client = make(server)
    await client.connect()
    const p = client.call('snapshot', {})
    const id = server.last.sent.at(-1)?.id
    server.last.push({ v: 1, id: 'fantasma', ok: true, result: {} })
    server.last.push({ v: 1, id: 7, ok: true, result: {} })
    server.last.push({ v: 1, id, ok: true, result: { seq: 1, workspaces: [] } })
    server.last.push({ v: 1, id, ok: false, error: { code: 'INTERNAL', message: 'duplicada' } })
    expect((await p).seq).toBe(1)
  })

  it('un result que no cumple el esquema nunca llega al llamador', async () => {
    const server = new FakeServer()
    const bad = [
      {},
      null,
      { seq: -1, workspaces: [] },
      { seq: 1.5, workspaces: [] },
      { seq: 1, workspaces: 'x' },
      { seq: 1, workspaces: [{ id: 1 }] },
      { seq: 1 },
    ]
    let i = 0
    server.handler = (req) =>
      req.method === 'snapshot' ? { result: bad[i++ % bad.length] } : undefined
    const client = make(server)
    await client.connect()
    for (let n = 0; n < bad.length; n++) {
      await expect(client.call('snapshot', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  })

  it('códigos de error desconocidos del servidor no llegan como errores válidos', async () => {
    const server = new FakeServer()
    server.handler = () => ({ error: { code: 'INVENTADO', message: 'x' } })
    const client = make(server)
    await client.connect()
    await expect(client.call('snapshot', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('eventos con seq desordenados, repetidos, negativos o no enteros no se entregan dos veces', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    await client.subscribe()
    const seqs: number[] = []
    client.on('pane.title', (_d, s) => seqs.push(s))
    const data = { paneId: 'p', title: 't' }
    for (const seq of [3, 2, 3, 1, 4, -1, 1.5, '5', null, 4, 5]) {
      server.last.pushEvent('pane.title', seq as number, data)
    }
    expect(seqs).toEqual([3, 4, 5])
  })

  it('un hueco enorme de seq produce un único resync y sigue funcionando', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    await client.subscribe()
    const resyncs: unknown[] = []
    client.on('resync', (i) => resyncs.push(i))
    const seqs: number[] = []
    client.on('pane.title', (_d, s) => seqs.push(s))
    const data = { paneId: 'p', title: 't' }
    server.last.pushEvent('pane.title', Number.MAX_SAFE_INTEGER - 1, data)
    server.last.pushEvent('pane.title', Number.MAX_SAFE_INTEGER, data)
    await tick()
    expect(resyncs).toHaveLength(1)
    expect(seqs).toHaveLength(2)
  })

  it('una inundación de eventos se procesa en orden', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    await client.subscribe()
    let count = 0
    let last = 0
    let ordered = true
    client.on('terminal.output', (_d, s) => {
      count++
      if (s <= last) ordered = false
      last = s
    })
    for (let seq = 1; seq <= 50_000; seq++) {
      server.last.pushEvent('terminal.output', seq, { terminalId: 't', offset: seq, data: 'x' })
    }
    expect(count).toBe(50_000)
    expect(ordered).toBe(true)
  })

  it('mensajes de más de 1 MiB se descartan', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    await client.subscribe()
    const errors: NexoClientError[] = []
    client.on('error', (e) => errors.push(e))
    let delivered = 0
    client.on('terminal.output', () => delivered++)
    server.last.pushEvent('terminal.output', 1, {
      terminalId: 't',
      offset: 1,
      data: 'x'.repeat(2 * 1024 * 1024),
    })
    expect(delivered).toBe(0)
    expect(errors).toHaveLength(1)
  })

  it('el servidor cierra en mitad de varias llamadas: DISCONNECTED y el cliente reconecta', async () => {
    vi.useFakeTimers()
    const server = new FakeServer()
    server.handler = (req) => (req.method === 'snapshot' ? 'silent' : undefined)
    const client = make(server, { random: () => 0 })
    await client.connect()
    const settled = Promise.allSettled(Array.from({ length: 5 }, () => client.call('snapshot', {})))
    server.last.drop(1011)
    const results = await settled
    expect(
      results.every(
        (r) => r.status === 'rejected' && (r.reason as NexoClientError).code === 'DISCONNECTED',
      ),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(client.state).toBe('open')
  })

  it('un cierre en pleno handshake en la conexión inicial deja el cliente cerrado', async () => {
    const server = new FakeServer()
    server.token = 'tok-tok-tok-tok-tok-tok'
    server.authMode = 'message'
    server.handler = (req, transport) => {
      if (req.method === 'auth') queueMicrotask(() => transport.drop(1008))
      return 'silent'
    }
    const client = make(server)
    await expect(client.connect()).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(client.state).toBe('closed')
  })

  it('reconexiones en bucle: el retardo nunca baja del mínimo ni pasa del tope', async () => {
    vi.useFakeTimers()
    const server = new FakeServer()
    const delays: number[] = []
    const client = make(server, {
      reconnect: { baseMs: 100, maxMs: 800, stableMs: 1_000_000 },
      logger: delaysFrom(delays),
    })
    await client.connect()
    for (let i = 0; i < 40; i++) {
      server.last.drop()
      await vi.advanceTimersByTimeAsync(1000)
      expect(client.state).toBe('open')
    }
    expect(delays).toHaveLength(40)
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(100)
      expect(d).toBeLessThanOrEqual(800)
    }
    expect(Math.max(...delays)).toBeGreaterThan(400)
  })

  it('10 000 llamadas concurrentes se resuelven cada una con su respuesta', async () => {
    const server = new FakeServer()
    server.handler = (req) => ({
      result: { terminalId: `t-${(req.params as { paneId: string }).paneId}` },
    })
    const client = make(server)
    await client.connect()
    const results = await Promise.all(
      Array.from({ length: 10_000 }, (_, i) =>
        client.call('terminal.spawn', { paneId: `p${i}` as PaneId, cols: 80, rows: 24 }),
      ),
    )
    expect(results.map((r) => r.terminalId)).toEqual(
      Array.from({ length: 10_000 }, (_, i) => `t-p${i}`),
    )
  })

  it('10 000 llamadas sin respuesta vencen por timeout sin dejar timers', async () => {
    vi.useFakeTimers()
    const server = new FakeServer()
    server.handler = (req) => (req.method === 'snapshot' ? 'silent' : undefined)
    const client = make(server, { callTimeoutMs: 500 })
    await client.connect()
    const calls = Array.from({ length: 10_000 }, () =>
      client.call('snapshot', {}).catch((e: NexoClientError) => e.code),
    )
    await vi.advanceTimersByTimeAsync(501)
    expect((await Promise.all(calls)).every((c) => c === 'TIMEOUT')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('parámetros hostiles se rechazan antes de enviar', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    const sent = server.last.sent.length
    const hostile: unknown[] = [
      { terminalId: 't', data: 'x'.repeat(100_000) },
      { terminalId: '', data: 'a' },
      { terminalId: 't', data: 'a', extra: 1 },
      JSON.parse('{"terminalId":"t","data":"a","__proto__":{"x":1}}'),
      null,
      'texto',
    ]
    for (const params of hostile) {
      await expect(client.call('terminal.write', params as never)).rejects.toMatchObject({
        code: expect.stringMatching(/INVALID_PARAMS|PAYLOAD_TOO_LARGE/),
      })
    }
    expect(server.last.sent.length).toBe(sent)
  })

  it('ids de respuesta con nombres de Object.prototype no se confunden con pendientes', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      server.last.push({ v: 1, id, ok: true, result: {} })
    }
    expect((await client.call('daemon.info', {})).protocol).toBe(1)
  })
})

describe('backoffDelay con entradas extremas', () => {
  it('siempre queda dentro de [base, tope]', () => {
    const o = { baseMs: 50, maxMs: 5000 }
    for (const attempt of [-1, 0, 1, 5, 29, 30, 31, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const r of [-5, 0, 0.3, 1, 9, Number.NaN]) {
        const d = backoffDelay(attempt, o, () => r)
        expect(d).toBeGreaterThanOrEqual(50)
        expect(d).toBeLessThanOrEqual(5000)
      }
    }
  })
})
