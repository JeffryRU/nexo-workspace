import type { PaneId, TabId, TerminalId } from '@nexo/contracts'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { backoffDelay } from './backoff.ts'
import { type ClientState, NexoClient } from './client.ts'
import { NexoClientError } from './errors.ts'
import { FakeServer, type Request, tick } from './test-helpers.ts'

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

async function rejection(promise: Promise<unknown>): Promise<NexoClientError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof NexoClientError) return error
    throw error
  }
  throw new Error('se esperaba un rechazo')
}

describe('NexoClient: llamadas', () => {
  it('correlaciona respuestas por id aunque lleguen en otro orden', async () => {
    const server = new FakeServer()
    const held: Request[] = []
    server.handler = (req) => {
      if (req.method === 'daemon.info' || req.method === 'snapshot') {
        held.push(req)
        return 'silent'
      }
      return undefined
    }
    const client = make(server)
    await client.connect()
    const a = client.call('daemon.info', {})
    const b = client.call('snapshot', {})
    const [first, second] = held
    server.last.push({
      v: 1,
      id: second?.id,
      ok: true,
      result: { seq: 7, workspaces: [] },
    })
    server.last.push({
      v: 1,
      id: first?.id,
      ok: true,
      result: { version: 'x', protocol: 1, pid: 3, startedAt: 'ahora' },
    })
    expect((await b).seq).toBe(7)
    expect((await a).pid).toBe(3)
  })

  it('tipa params y result desde el registro', async () => {
    const server = new FakeServer()
    server.handler = () => ({ result: { terminalId: 't1' } })
    const client = make(server)
    await client.connect()
    const out = await client.call('terminal.spawn', { paneId: 'p1' as PaneId, cols: 80, rows: 24 })
    expectTypeOf(out.terminalId).toBeString()
    expect(out.terminalId).toBe('t1')
    // @ts-expect-error params inválidos para el método
    await rejection(client.call('terminal.resize', { terminalId: 't1' }))
  })

  it('valida params antes de enviar', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    const before = server.last.sent.length
    const error = await rejection(
      client.call('terminal.resize', { terminalId: 't' as TerminalId, cols: 0, rows: 24 }),
    )
    expect(error.code).toBe('INVALID_PARAMS')
    expect(server.last.sent.length).toBe(before)
  })

  it('rechaza peticiones que superan el tamaño máximo', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    const env: Record<string, string> = {}
    for (let i = 0; i < 40; i++) env[`V${i}`] = 'x'.repeat(30_000)
    const error = await rejection(
      client.call('terminal.spawn', { paneId: 'p' as PaneId, cols: 1, rows: 1, env }),
    )
    expect(['PAYLOAD_TOO_LARGE', 'INVALID_PARAMS']).toContain(error.code)
  })

  it('valida el result contra el esquema del método', async () => {
    const server = new FakeServer()
    server.handler = () => ({ result: { seq: 'no-es-numero' } })
    const client = make(server)
    await client.connect()
    expect((await rejection(client.call('snapshot', {}))).code).toBe('INVALID_RESPONSE')
  })

  it('propaga errores del servidor con su código y datos', async () => {
    const server = new FakeServer()
    server.handler = () => ({ error: { code: 'NOT_FOUND', message: 'no existe' } })
    const client = make(server)
    await client.connect()
    const error = await rejection(client.call('tab.close', { tabId: 't' as TabId }))
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toBe('no existe')
  })

  it('una respuesta con forma inválida pero id conocido falla esa llamada', async () => {
    const server = new FakeServer()
    server.handler = () => 'silent'
    const client = make(server)
    await client.connect()
    const p = client.call('snapshot', {})
    const id = server.last.sent.at(-1)?.id
    server.last.push({ v: 1, id, ok: 'quizá' })
    expect((await rejection(p)).code).toBe('INVALID_RESPONSE')
  })

  it('timeout por llamada con error tipado TIMEOUT', async () => {
    vi.useFakeTimers()
    const server = new FakeServer()
    server.handler = (req) => (req.method === 'snapshot' ? 'silent' : undefined)
    const client = make(server, { callTimeoutMs: 1000 })
    await client.connect()
    const p = rejection(client.call('snapshot', {}))
    await vi.advanceTimersByTimeAsync(1001)
    expect((await p).code).toBe('TIMEOUT')
    const q = rejection(client.call('snapshot', {}, { timeoutMs: 50 }))
    await vi.advanceTimersByTimeAsync(51)
    expect((await q).code).toBe('TIMEOUT')
  })

  it('una respuesta tardía tras el timeout se ignora', async () => {
    vi.useFakeTimers()
    const server = new FakeServer()
    server.handler = (req) => (req.method === 'snapshot' ? 'silent' : undefined)
    const client = make(server, { callTimeoutMs: 10 })
    await client.connect()
    const p = rejection(client.call('snapshot', {}))
    await vi.advanceTimersByTimeAsync(20)
    await p
    const id = server.last.sent.at(-1)?.id
    expect(() =>
      server.last.push({ v: 1, id, ok: true, result: { seq: 1, workspaces: [] } }),
    ).not.toThrow()
  })

  it('cancela con AbortSignal (antes y durante la llamada)', async () => {
    const server = new FakeServer()
    server.handler = (req) => (req.method === 'snapshot' ? 'silent' : undefined)
    const client = make(server)
    await client.connect()
    const pre = new AbortController()
    pre.abort()
    const sentBefore = server.last.sent.length
    expect((await rejection(client.call('snapshot', {}, { signal: pre.signal }))).code).toBe(
      'ABORTED',
    )
    expect(server.last.sent.length).toBe(sentBefore)
    const live = new AbortController()
    const p = rejection(client.call('snapshot', {}, { signal: live.signal }))
    live.abort()
    expect((await p).code).toBe('ABORTED')
  })

  it('llamar sin conexión o tras close falla con DISCONNECTED / CLOSED', async () => {
    const server = new FakeServer()
    const client = make(server)
    expect((await rejection(client.call('snapshot', {}))).code).toBe('DISCONNECTED')
    await client.connect()
    client.close()
    expect((await rejection(client.call('snapshot', {}))).code).toBe('CLOSED')
  })

  it('si send lanza, la llamada falla con DISCONNECTED', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    server.last.closed = true
    expect((await rejection(client.call('snapshot', {}))).code).toBe('DISCONNECTED')
  })
})

describe('NexoClient: eventos, seq y resync', () => {
  it('on() entrega eventos tipados y devuelve la baja', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    await client.subscribe(['terminal.output'])
    const seen: string[] = []
    const off = client.on('terminal.output', (data, seq) =>
      seen.push(`${data.terminalId}:${data.data}:${seq}`),
    )
    server.last.pushEvent('terminal.output', 1, { terminalId: 't', offset: 2, data: 'hi' })
    off()
    server.last.pushEvent('terminal.output', 2, { terminalId: 't', offset: 4, data: 'yo' })
    expect(seen).toEqual(['t:hi:1'])
    const sub = server.last.sent.find((r) => r.method === 'events.subscribe')
    expect(sub?.params).toEqual({ events: ['terminal.output'] })
  })

  it('subscribe sin lista suscribe a todo', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    await client.subscribe()
    expect(server.last.sent.at(-1)?.params).toEqual({})
  })

  it('ignora eventos con seq repetido o desordenado', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    await client.subscribe()
    const seqs: number[] = []
    client.on('pane.title', (_d, seq) => seqs.push(seq))
    for (const seq of [1, 2, 2, 1, 3])
      server.last.pushEvent('pane.title', seq, { paneId: 'p', title: 't' })
    expect(seqs).toEqual([1, 2, 3])
  })

  it('un hueco de seq emite resync y, con autoResync, entrega el snapshot', async () => {
    const server = new FakeServer()
    server.handler = (req) =>
      req.method === 'snapshot' ? { result: { seq: 9, workspaces: [] } } : undefined
    const snapshots: number[] = []
    const client = make(server, { autoResync: true, onSnapshot: (s) => snapshots.push(s.seq) })
    await client.connect()
    await client.subscribe()
    const infos: unknown[] = []
    client.on('resync', (i) => infos.push(i))
    server.last.pushEvent('pane.title', 1, { paneId: 'p', title: 't' })
    server.last.pushEvent('pane.title', 5, { paneId: 'p', title: 't' })
    await tick()
    expect(infos).toEqual([{ reason: 'gap', expected: 2, got: 5 }])
    expect(snapshots).toEqual([9])
    // tras el snapshot, 10 es el siguiente seq esperado: no hay otro hueco
    server.last.pushEvent('pane.title', 10, { paneId: 'p', title: 't' })
    await tick()
    expect(infos).toHaveLength(1)
  })

  it('sin autoResync solo emite el evento local', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    await client.subscribe()
    const infos: unknown[] = []
    client.on('resync', (i) => infos.push(i))
    server.last.pushEvent('pane.title', 3, { paneId: 'p', title: 't' })
    await tick()
    expect(infos).toHaveLength(1)
    expect(server.last.sent.some((r) => r.method === 'snapshot')).toBe(false)
  })

  it('client.resync del daemon dispara resync por contrapresión', async () => {
    const server = new FakeServer()
    const snapshots: unknown[] = []
    const client = make(server, {
      autoResync: true,
      onSnapshot: (s, i) => snapshots.push([s.seq, i.reason]),
    })
    await client.connect()
    await client.subscribe()
    const delivered: number[] = []
    client.on('client.resync', (d) => delivered.push(d.dropped))
    server.last.pushEvent('client.resync', 1, { reason: 'backpressure', dropped: 4 })
    await tick()
    expect(delivered).toEqual([4])
    expect(snapshots).toEqual([[0, 'backpressure']])
  })

  it('no lanza un segundo snapshot mientras otro está en curso', async () => {
    const server = new FakeServer()
    server.handler = (req) => (req.method === 'snapshot' ? 'silent' : undefined)
    const client = make(server, { autoResync: true })
    await client.connect()
    await client.subscribe()
    server.last.pushEvent('pane.title', 5, { paneId: 'p', title: 't' })
    server.last.pushEvent('pane.title', 9, { paneId: 'p', title: 't' })
    await tick()
    expect(server.last.sent.filter((r) => r.method === 'snapshot')).toHaveLength(1)
  })

  it('un manejador que lanza no rompe a los demás ni al cliente', async () => {
    const server = new FakeServer()
    const logs: string[] = []
    const client = make(server, { logger: (_l, m) => logs.push(m) })
    await client.connect()
    await client.subscribe()
    const ok: number[] = []
    client.on('pane.title', () => {
      throw new Error('boom')
    })
    client.on('pane.title', (_d, s) => ok.push(s))
    server.last.pushEvent('pane.title', 1, { paneId: 'p', title: 't' })
    expect(ok).toEqual([1])
    expect(logs.some((m) => m.includes('boom'))).toBe(true)
  })

  it('ignora eventos desconocidos (daemon más nuevo) sin reportar error', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    const errors: NexoClientError[] = []
    client.on('error', (e) => errors.push(e))
    server.last.pushEvent('evento.nuevo', 1, {})
    expect(errors).toEqual([])
  })

  it('reporta mensajes inválidos por el evento error', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    const errors: NexoClientError[] = []
    client.on('error', (e) => errors.push(e))
    server.last.push('{no es json')
    server.last.push({ v: 1, id: 'desconocido', ok: true, result: {} })
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('INVALID_RESPONSE')
  })
})

describe('NexoClient: estados y reconexión', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  const states = (client: NexoClient): ClientState[] => {
    const seen: ClientState[] = [client.state]
    client.on('state', (s) => seen.push(s))
    return seen
  }

  it('connecting -> open -> reconnecting -> open -> closed', async () => {
    const server = new FakeServer()
    const client = make(server, { random: () => 0 })
    const seen = states(client)
    await client.connect()
    server.last.drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(300)
    expect(client.state).toBe('open')
    client.close()
    expect(seen).toEqual(['connecting', 'open', 'reconnecting', 'open', 'closed'])
  })

  it('las llamadas pendientes al caerse fallan con DISCONNECTED', async () => {
    const server = new FakeServer()
    server.handler = (req) => (req.method === 'snapshot' ? 'silent' : undefined)
    const client = make(server)
    await client.connect()
    const p = rejection(client.call('snapshot', {}))
    server.last.drop()
    expect((await p).code).toBe('DISCONNECTED')
    expect((await rejection(client.call('snapshot', {}))).code).toBe('DISCONNECTED')
  })

  it('al reconectar re-suscribe, reinicia seq y emite resync (con snapshot si autoResync)', async () => {
    const server = new FakeServer()
    const snaps: string[] = []
    const client = make(server, {
      random: () => 0,
      autoResync: true,
      onSnapshot: (_s, i) => snaps.push(i.reason),
    })
    await client.connect()
    await client.subscribe(['pane.title'])
    const resyncs: string[] = []
    client.on('resync', (i) => resyncs.push(i.reason))
    const titles: number[] = []
    client.on('pane.title', (_d, s) => titles.push(s))
    server.last.pushEvent('pane.title', 1, { paneId: 'p', title: 'a' })
    server.last.drop()
    await vi.advanceTimersByTimeAsync(300)
    const resub = server.last.sent.filter((r) => r.method === 'events.subscribe')
    expect(resub).toHaveLength(1)
    expect(resub[0]?.params).toEqual({ events: ['pane.title'] })
    // el seq empieza de nuevo en la conexión nueva y no se confunde con repetido
    server.last.pushEvent('pane.title', 1, { paneId: 'p', title: 'b' })
    expect(titles).toEqual([1, 1])
    expect(resyncs).toEqual(['reconnect'])
    expect(snaps).toEqual(['reconnect'])
  })

  it('re-autentica con el mensaje auth en cada reconexión', async () => {
    const server = new FakeServer()
    server.token = 'tok-tok-tok-tok-tok-tok'
    server.authMode = 'message'
    const client = make(server, { random: () => 0 })
    await client.connect()
    expect(server.last.sent[0]).toMatchObject({ method: 'auth', params: { token: server.token } })
    server.last.drop()
    await vi.advanceTimersByTimeAsync(300)
    expect(server.transports).toHaveLength(2)
    expect(server.last.sent[0]?.method).toBe('auth')
  })

  it('con auth rechazada la conexión no queda abierta', async () => {
    const server = new FakeServer()
    server.token = 'tok-tok-tok-tok-tok-tok'
    server.authMode = 'message'
    server.handler = () => ({ error: { code: 'UNAUTHORIZED', message: 'no' } })
    const client = make(server)
    const error = await rejection(client.connect())
    expect(error.code).toBe('UNAUTHORIZED')
    expect(client.state).toBe('closed')
  })

  it('reintenta con backoff creciente hasta lograrlo', async () => {
    const server = new FakeServer()
    const delays: number[] = []
    const client = make(server, {
      random: () => 1,
      reconnect: { baseMs: 100, maxMs: 1000 },
      logger: (_l, m) => {
        const hit = /reconectando en (\d+) ms/.exec(m)
        if (hit) delays.push(Number(hit[1]))
      },
    })
    await client.connect()
    server.failConnects = 3
    server.last.drop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(delays).toEqual([100, 200, 400, 800])
    expect(client.state).toBe('open')
  })

  it('una conexión estable reinicia el backoff', async () => {
    const server = new FakeServer()
    const delays: number[] = []
    const client = make(server, {
      random: () => 1,
      reconnect: { baseMs: 100, maxMs: 1000, stableMs: 1000 },
      logger: (_l, m) => {
        const hit = /reconectando en (\d+) ms/.exec(m)
        if (hit) delays.push(Number(hit[1]))
      },
    })
    await client.connect()
    server.last.drop()
    await vi.advanceTimersByTimeAsync(150)
    await vi.advanceTimersByTimeAsync(5000)
    server.last.drop()
    await vi.advanceTimersByTimeAsync(150)
    expect(delays).toEqual([100, 100])
  })

  it('close() durante la espera detiene la reconexión para siempre', async () => {
    const server = new FakeServer()
    const client = make(server)
    await client.connect()
    server.last.drop()
    await vi.advanceTimersByTimeAsync(0)
    client.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.transports).toHaveLength(1)
    expect(client.state).toBe('closed')
  })

  it('close() durante un intento en curso no deja el transporte abierto', async () => {
    const server = new FakeServer()
    const client = make(server, { random: () => 0 })
    await client.connect()
    let release: () => void = () => {}
    server.connectGate = new Promise<void>((r) => {
      release = r
    })
    server.last.drop()
    await vi.advanceTimersByTimeAsync(300)
    client.close()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(server.last.closed).toBe(true)
    expect(client.state).toBe('closed')
  })

  it('con reconnect:false una caída cierra el cliente', async () => {
    const server = new FakeServer()
    const client = make(server, { reconnect: false })
    await client.connect()
    server.last.drop()
    expect(client.state).toBe('closed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.transports).toHaveLength(1)
  })

  it('maxAttempts cierra el cliente tras demasiados fallos', async () => {
    const server = new FakeServer()
    const client = make(server, { reconnect: { baseMs: 10, maxMs: 20, maxAttempts: 2 } })
    await client.connect()
    server.failConnects = 99
    server.last.drop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.state).toBe('closed')
    expect(server.transports).toHaveLength(3)
  })

  it('la conexión inicial fallida rechaza y deja el cliente cerrado', async () => {
    const server = new FakeServer()
    server.failConnects = 1
    const client = make(server)
    expect((await rejection(client.connect())).code).toBe('DISCONNECTED')
    expect(client.state).toBe('closed')
  })

  it('si la fábrica de transporte falla en la primera conexión, rechaza', async () => {
    const client = make(new FakeServer(), {
      transport: () => {
        throw new Error('descubrimiento fallido')
      },
    })
    expect((await rejection(client.connect())).code).toBe('DISCONNECTED')
  })

  it('un cierre del transporte durante el handshake rechaza connect()', async () => {
    const server = new FakeServer()
    server.connectGate = new Promise(() => {})
    const client = make(server)
    const p = rejection(client.connect())
    await vi.advanceTimersByTimeAsync(0)
    server.last.drop()
    expect((await p).code).toBe('DISCONNECTED')
  })

  it('connect() es idempotente', async () => {
    const server = new FakeServer()
    const client = make(server)
    await Promise.all([client.connect(), client.connect()])
    expect(server.transports).toHaveLength(1)
  })

  it('el transporte viejo ya no puede inyectar mensajes tras reconectar', async () => {
    const server = new FakeServer()
    const client = make(server, { random: () => 0 })
    await client.connect()
    await client.subscribe()
    const old = server.last
    const titles: number[] = []
    client.on('pane.title', (_d, s) => titles.push(s))
    old.drop()
    await vi.advanceTimersByTimeAsync(300)
    old.pushEvent('pane.title', 1, { paneId: 'p', title: 'viejo' })
    expect(titles).toEqual([])
  })
})

describe('NexoClient: secretos en logs', () => {
  it('ningún log contiene el token', async () => {
    const token = 'SECRETO-1234567890-abcdef'
    const server = new FakeServer()
    server.token = token
    server.authMode = 'message'
    const logs: string[] = []
    server.handler = (req) =>
      req.method === 'snapshot'
        ? { error: { code: 'INTERNAL', message: `fallo con ${token} y nexo.token.${token}` } }
        : undefined
    const client = make(server, { logger: (_l, m) => logs.push(m), autoResync: true })
    await client.connect()
    await client.subscribe()
    client.on('error', () => {})
    server.last.pushEvent('pane.title', 4, { paneId: 'p', title: 't' })
    await tick()
    server.last.push(`{roto ${token}`)
    server.last.drop()
    await tick()
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(token)
  })
})

describe('backoffDelay', () => {
  it('crece, se acota y respeta el mínimo', () => {
    const o = { baseMs: 100, maxMs: 1000 }
    expect(backoffDelay(0, o, () => 1)).toBe(100)
    expect(backoffDelay(0, o, () => 0)).toBe(100)
    expect(backoffDelay(3, o, () => 1)).toBe(800)
    expect(backoffDelay(3, o, () => 0)).toBe(400)
    expect(backoffDelay(50, o, () => 1)).toBe(1000)
    expect(backoffDelay(-5, o, () => 0.5)).toBe(100)
    expect(backoffDelay(2, o, () => 7)).toBe(400)
  })
})
