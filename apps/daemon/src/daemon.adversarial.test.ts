import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { DaemonAlreadyRunningError, PortInUseError, startDaemon } from './daemon.ts'
import {
  connectAuthed,
  openSocket,
  startTestDaemon,
  type TestClient,
  type TestDaemon,
  upgradeStatus,
} from './test-helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function boot(options: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> {
  const d = await startTestDaemon(options)
  cleanups.push(() => d.cleanup())
  return d
}

async function authed(d: TestDaemon): Promise<TestClient> {
  const c = await connectAuthed(d)
  cleanups.push(() => c.close())
  return c
}

async function raw(c: TestClient): Promise<TestClient> {
  cleanups.push(() => c.close())
  return c
}

const health = async (d: { port: number }) =>
  (await fetch(`http://127.0.0.1:${d.port}/health`)).status

describe('autenticación hostil', () => {
  it('rechaza en el upgrade un token incorrecto, vacío, largo o parecido', async () => {
    const d = await boot()
    const almost = `${d.token.slice(0, -1)}${d.token.endsWith('A') ? 'B' : 'A'}`
    for (const bad of ['', 'x', almost, `${d.token}x`, d.token.slice(1), 'A'.repeat(8000)]) {
      const status = await upgradeStatus(d.port, { protocols: ['nexo.v1', `nexo.token.${bad}`] })
      expect(status, bad.slice(0, 10)).toBe(401)
    }
    expect(await upgradeStatus(d.port, { protocols: ['nexo.v1', `nexo.token.${d.token}`] })).toBe(0)
  })

  it('rechaza subprotocolos mal formados o con dos tokens', async () => {
    const d = await boot()
    expect(await upgradeStatus(d.port, { protocols: ['otro'] })).toBe(400)
    expect(
      await upgradeStatus(d.port, {
        protocols: ['nexo.v1', `nexo.token.${d.token}`, 'nexo.token.otro'],
      }),
    ).toBe(400)
    expect(await upgradeStatus(d.port, { protocols: [`nexo.token.${d.token}`] })).toBe(400)
  })

  it('auth por mensaje con token incorrecto, vacío, unicode o enorme cierra con UNAUTHORIZED', async () => {
    const d = await boot()
    for (const bad of [
      '',
      'x',
      'ñandú'.repeat(10),
      '\u0000',
      `${d.token}\u0000`,
      'A'.repeat(4096),
    ]) {
      const c = await raw(await openSocket(d.port))
      const res = await c.request('auth', { token: bad })
      expect(res.ok).toBe(false)
      expect((res.error as { code: string }).code).toBe('UNAUTHORIZED')
      expect((await c.waitClose()).code).toBe(1008)
    }
    // Demasiado largo para el esquema: también se corta sin autenticar.
    const c = await raw(await openSocket(d.port))
    const res = await c.request('auth', { token: 'A'.repeat(5000) })
    expect(res.ok).toBe(false)
    expect((await c.waitClose()).code).toBe(1008)
  })

  it('cualquier método antes de auth es UNAUTHORIZED y cierra', async () => {
    const d = await boot()
    const c = await raw(await openSocket(d.port))
    const res = await c.request('workspace.create', { name: 'x' })
    expect((res.error as { code: string }).code).toBe('UNAUTHORIZED')
    await c.waitClose()
    const snap = await (await authed(d)).call<{ workspaces: unknown[] }>('snapshot')
    expect(snap.workspaces).toHaveLength(0)
  })

  it('daemon.shutdown sin autenticar es UNAUTHORIZED y el daemon sigue vivo', async () => {
    const stops: number[] = []
    const d = await boot({ onShutdownRequested: () => void stops.push(1) })
    const c = await raw(await openSocket(d.port))
    const res = await c.request('daemon.shutdown', {})
    expect((res.error as { code: string }).code).toBe('UNAUTHORIZED')
    await c.waitClose()
    await new Promise((r) => setTimeout(r, 150))
    expect(stops).toEqual([])
    expect((await (await authed(d)).call<{ pid: number }>('daemon.info')).pid).toBe(process.pid)
  })

  it('JSON roto o binario antes de auth cierra la conexión', async () => {
    const d = await boot()
    const c = await raw(await openSocket(d.port))
    c.ws.send('{no es json')
    await c.waitClose()
    const b = await raw(await openSocket(d.port))
    b.ws.send(Buffer.from([1, 2, 3]))
    b.ws.send(Buffer.from([1, 2, 3]))
    b.ws.send(Buffer.from([1, 2, 3]))
    await b.waitClose()
  })

  it('sin autenticar en el plazo se cierra', async () => {
    const d = await boot({ server: { authTimeoutMs: 250 } })
    const c = await raw(await openSocket(d.port))
    const closed = await c.waitClose()
    expect(closed.code).toBe(1008)
    expect(closed.reason).toContain('auth')
  })

  it('una conexión autenticada por subprotocolo no necesita el plazo', async () => {
    const d = await boot({ server: { authTimeoutMs: 150 } })
    const c = await authed(d)
    await new Promise((r) => setTimeout(r, 400))
    expect((await c.call<{ pid: number }>('daemon.info')).pid).toBe(process.pid)
  })

  it('auth repetido ya autenticado es inofensivo', async () => {
    const d = await boot()
    const c = await authed(d)
    expect((await c.request('auth', { token: 'cualquiera' })).ok).toBe(true)
  })
})

describe('Origin y Host hostiles', () => {
  it('rechaza orígenes ajenos y null con 403, aun con token correcto', async () => {
    const d = await boot()
    const protocols = ['nexo.v1', `nexo.token.${d.token}`]
    for (const origin of [
      'http://evil.example',
      'null',
      'http://localhost:5173',
      'file://',
      'tauri://localhost.evil',
    ]) {
      expect(await upgradeStatus(d.port, { protocols, headers: { Origin: origin } }), origin).toBe(
        403,
      )
    }
  })

  it('permite Tauri, sin Origin, y Vite solo con NEXO_DEV', async () => {
    const d = await boot()
    for (const origin of [
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
    ]) {
      expect(await upgradeStatus(d.port, { headers: { Origin: origin } }), origin).toBe(0)
    }
    expect(await upgradeStatus(d.port)).toBe(0)
    const dev = await boot({ dev: true })
    expect(await upgradeStatus(dev.port, { headers: { Origin: 'http://localhost:5173' } })).toBe(0)
    expect(await upgradeStatus(dev.port, { headers: { Origin: 'http://127.0.0.1:5173' } })).toBe(0)
    expect(await upgradeStatus(dev.port, { headers: { Origin: 'http://localhost:5174' } })).toBe(
      403,
    )
  })

  it('rechaza un Host que no es el loopback (DNS rebinding)', async () => {
    const d = await boot()
    expect(await upgradeStatus(d.port, { headers: { Host: 'evil.example' } })).toBe(403)
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: d.port, path: '/health', headers: { Host: 'evil.example' } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })

  it('una ruta de WebSocket desconocida es 404', async () => {
    const d = await boot()
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/otra`, ['nexo.v1'])
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0))
      ws.on('error', () => {})
    })
    expect(status).toBe(404)
  })
})

describe('mensajes hostiles', () => {
  it('JSON roto, método inexistente, __proto__ y params inválidos reciben error y la conexión sigue', async () => {
    const d = await boot()
    const c = await authed(d)
    c.ws.send('{roto')
    c.ws.send(JSON.stringify({ v: 1, id: 'a', method: 'no.existe', params: {} }))
    c.ws.send(
      '{"v":1,"id":"p","method":"workspace.create","params":{"__proto__":{"x":1},"name":"x"}}',
    )
    c.ws.send('{"__proto__":{"polluted":true},"v":1,"id":"q","method":"daemon.info"}')
    c.ws.send(
      JSON.stringify({ v: 1, id: 'b', method: 'workspace.create', params: { name: '\u001b[31m' } }),
    )
    c.ws.send(JSON.stringify({ v: 2, id: 'c', method: 'daemon.info' }))
    c.ws.send('null')
    c.ws.send('[]')
    c.ws.send('"texto"')
    expect(((await c.waitMessage((m) => m.id === 'a')).error as { code: string }).code).toBe(
      'NOT_FOUND',
    )
    expect(((await c.waitMessage((m) => m.id === 'p')).error as { code: string }).code).toBe(
      'INVALID_PARAMS',
    )
    expect(((await c.waitMessage((m) => m.id === 'q')).error as { code: string }).code).toBe(
      'INVALID_PARAMS',
    )
    expect(((await c.waitMessage((m) => m.id === 'b')).error as { code: string }).code).toBe(
      'INVALID_PARAMS',
    )
    expect(((await c.waitMessage((m) => m.id === 'c')).error as { code: string }).code).toBe(
      'INVALID_PARAMS',
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((await c.call<{ protocol: number }>('daemon.info')).protocol).toBe(1)
  })

  it('un método con nombre de Object.prototype no se despacha', async () => {
    const d = await boot()
    const c = await authed(d)
    for (const method of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const res = await c.request(method, {})
      expect(res.ok, method).toBe(false)
    }
  })

  it('los frames binarios reciben error y, si insisten, cierran con 1003', async () => {
    const d = await boot()
    const c = await authed(d)
    c.ws.send(Buffer.from([0xff, 0xfe]))
    await c.waitMessage((m) => m.ok === false)
    c.ws.send(Buffer.from([0xff]))
    c.ws.send(Buffer.from([0xff]))
    expect((await c.waitClose()).code).toBe(1003)
  })

  it('UTF-8 inválido no tumba al daemon', async () => {
    const d = await boot()
    const c = await authed(d)
    c.ws.send('\ud800 suelto', () => {})
    c.ws.send(JSON.stringify({ v: 1, id: 'ok', method: 'daemon.info' }))
    await c.waitMessage((m) => m.id === 'ok')
    expect(await health(d)).toBe(200)
  })

  it('un mensaje de 2 MiB recibe PAYLOAD_TOO_LARGE y, si se repite, cierra', async () => {
    const d = await boot()
    const c = await authed(d)
    const big = 'x'.repeat(2 * 1024 * 1024)
    c.ws.send(big)
    const res = await c.waitMessage((m) => m.ok === false)
    expect((res.error as { code: string }).code).toBe('PAYLOAD_TOO_LARGE')
    c.ws.send(big)
    c.ws.send(big)
    expect((await c.waitClose()).code).toBe(1009)
    expect(await health(d)).toBe(200)
  })

  it('un frame muy por encima del tope se corta con 1009', async () => {
    const d = await boot()
    const c = await authed(d)
    c.ws.send('x'.repeat(5 * 1024 * 1024))
    expect((await c.waitClose()).code).toBe(1009)
    expect(await health(d)).toBe(200)
  })

  it('un mensaje justo en el tope no se rechaza por tamaño', async () => {
    const d = await boot()
    const c = await authed(d)
    const filler = 'a'.repeat(1024 * 1024 - 200)
    c.ws.send(JSON.stringify({ v: 1, id: 'g', method: 'daemon.info', params: { relleno: filler } }))
    const res = await c.waitMessage((m) => m.id === 'g')
    // Excede el esquema (claves extra), pero no el tamaño.
    expect((res.error as { code: string }).code).toBe('INVALID_PARAMS')
  })

  it('la inundación de mensajes recibe RATE_LIMITED y luego se corta; el daemon sigue', async () => {
    const d = await boot({ server: { rate: { max: 20, windowMs: 60000 } } })
    const c = await authed(d)
    for (let i = 0; i < 500; i++) {
      c.ws.send(JSON.stringify({ v: 1, id: `f${i}`, method: 'daemon.info' }))
    }
    const limited = await c.waitMessage(
      (m) => (m.error as { code?: string } | undefined)?.code === 'RATE_LIMITED',
    )
    expect(limited.id).toMatch(/^f\d+$/)
    expect((await c.waitClose()).code).toBe(1008)
    expect(await health(d)).toBe(200)
    expect((await (await authed(d)).call<{ pid: number }>('daemon.info')).pid).toBe(process.pid)
  })

  it('un id enorme se rechaza sin eco del mensaje', async () => {
    const d = await boot()
    const c = await authed(d)
    c.ws.send(JSON.stringify({ v: 1, id: 'i'.repeat(5000), method: 'daemon.info' }))
    const res = await c.waitMessage((m) => m.ok === false)
    expect(JSON.stringify(res).length).toBeLessThan(500)
  })
})

describe('conexiones', () => {
  it('atiende 100 conexiones a la vez', async () => {
    const d = await boot()
    const clients = await Promise.all(Array.from({ length: 100 }, () => authed(d)))
    const infos = await Promise.all(clients.map((c) => c.call<{ pid: number }>('daemon.info')))
    expect(infos.every((i) => i.pid === process.pid)).toBe(true)
    expect(d.stats().authenticated).toBe(100)
    for (const c of clients) c.close()
  })

  it('respeta el máximo de conexiones con 503 y se recupera al liberar', async () => {
    const d = await boot({ server: { maxConnections: 3 } })
    const cs = await Promise.all([authed(d), authed(d), authed(d)])
    expect(await upgradeStatus(d.port)).toBe(503)
    cs[0]?.close()
    await cs[0]?.waitClose()
    await new Promise((r) => setTimeout(r, 100))
    expect(await upgradeStatus(d.port)).toBe(0)
  })

  it('el cliente que se desconecta en mitad de una petición no afecta al daemon', async () => {
    const d = await boot()
    const c = await authed(d)
    const { workspace } = await c.call<{ workspace: { id: string } }>('workspace.create', {
      name: 'a',
    })
    const { tab } = await c.call<{ tab: { panes: { id: string }[] } }>('tab.create', {
      workspaceId: workspace.id,
    })
    const paneId = tab.panes[0]?.id
    c.ws.send(
      JSON.stringify({
        v: 1,
        id: 'x',
        method: 'terminal.spawn',
        params: {
          paneId,
          cmd: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          cols: 80,
          rows: 24,
        },
      }),
    )
    c.close()
    await new Promise((r) => setTimeout(r, 200))
    const other = await authed(d)
    const snap = await other.call<{
      workspaces: { tabs: { panes: { terminalId?: string }[] }[] }[]
    }>('snapshot')
    expect(snap.workspaces).toHaveLength(1)
    expect(await health(d)).toBe(200)
  })

  it('las terminales y el estado siguen vivos aunque el cliente se vaya', async () => {
    const d = await boot()
    const a = await authed(d)
    await a.call('workspace.create', { name: 'persistente' })
    a.close()
    await a.waitClose()
    const b = await authed(d)
    expect((await b.call<{ workspaces: { name: string }[] }>('snapshot')).workspaces[0]?.name).toBe(
      'persistente',
    )
  })
})

describe('contrapresión', () => {
  const out = (n: number) => ({
    event: 'terminal.output' as const,
    data: { terminalId: 't1' as never, offset: n, data: 'x'.repeat(64 * 1024) },
  })

  it('un cliente lento pierde terminal.output, el búfer del daemon queda acotado y recibe client.resync', async () => {
    const soft = 256 * 1024
    const hard = 8 * 1024 * 1024
    const d = await boot({ server: { softBufferBytes: soft, hardBufferBytes: hard } })
    const slow = await authed(d)
    await slow.call('events.subscribe', { events: ['terminal.output', 'client.resync'] })
    const fast = await authed(d)
    await fast.call('events.subscribe', { events: ['pane.title'] })
    slow.ws.pause()

    let maxSeen = 0
    for (let i = 0; i < 3000 && d.stats().droppedOutputEvents === 0; i++) {
      d.bus.publish(out(i))
      maxSeen = Math.max(maxSeen, d.stats().maxBuffered)
      if (i % 20 === 0) await new Promise((r) => setImmediate(r))
    }
    expect(d.stats().droppedOutputEvents).toBeGreaterThan(0)
    // Se siguen publicando eventos: el búfer no crece más allá del umbral blando (+ un mensaje).
    for (let i = 0; i < 500; i++) {
      d.bus.publish(out(10000 + i))
      maxSeen = Math.max(maxSeen, d.stats().maxBuffered)
    }
    expect(maxSeen).toBeLessThan(soft + 3 * 64 * 1024 + 4096)
    expect(d.stats().droppedOutputEvents).toBeGreaterThan(400)

    slow.ws.resume()
    const resync = await slow.waitEvent('client.resync', () => true, 10000)
    expect((resync.data as { reason: string; dropped: number }).reason).toBe('backpressure')
    expect((resync.data as { dropped: number }).dropped).toBeGreaterThan(0)
    // El hueco en seq permite detectar la pérdida sin client.resync.
    const seqs = slow.messages.filter((m) => m.event !== undefined).map((m) => m.seq as number)
    expect(seqs.some((s, i) => i > 0 && s - (seqs[i - 1] as number) > 1)).toBe(true)
    // Y el cliente se recupera: ya puede pedir snapshot.
    expect((await slow.call<{ seq: number }>('snapshot')).seq).toBeGreaterThan(0)
  })

  it('no apila client.resync: uno por ráfaga hasta que el cliente relee (o pasa resyncAckMs)', async () => {
    const d = await boot({
      server: { softBufferBytes: 256 * 1024, hardBufferBytes: 64 * 1024 * 1024, resyncAckMs: 600 },
    })
    const slow = await authed(d)
    await slow.call('events.subscribe', { events: ['terminal.output', 'client.resync'] })
    const burst = async (from: number) => {
      slow.ws.pause()
      const before = d.stats().droppedOutputEvents
      for (let i = 0; i < 4000 && d.stats().droppedOutputEvents - before < 20; i++) {
        d.bus.publish(out(from + i))
        if (i % 20 === 0) await new Promise((r) => setImmediate(r))
      }
      slow.ws.resume()
    }
    const resyncs = () => slow.messages.filter((m) => m.event === 'client.resync').length

    await burst(0)
    await slow.waitEvent('client.resync', () => true, 10000)
    expect(resyncs()).toBe(1)
    // Segunda ráfaga sin que el cliente haya releído: no se manda otro client.resync todavía...
    await burst(10_000)
    await new Promise((r) => setTimeout(r, 300))
    expect(resyncs()).toBe(1)
    // ...hasta que pasa el tope de espera (cliente que nunca confirma),
    await vi.waitFor(() => expect(resyncs()).toBe(2), { timeout: 5000 })
    // o hasta que confirma con un snapshot: entonces la siguiente ráfaga sí avisa enseguida.
    await slow.call('snapshot')
    await burst(20_000)
    await vi.waitFor(() => expect(resyncs()).toBe(3), { timeout: 5000 })
  })

  it('tras confirmar con terminal.read y sin más pérdidas no se envía un client.resync vacío', async () => {
    const d = await boot({
      server: { softBufferBytes: 256 * 1024, hardBufferBytes: 64 * 1024 * 1024 },
    })
    const slow = await authed(d)
    await slow.call('events.subscribe', { events: ['terminal.output', 'client.resync'] })
    slow.ws.pause()
    for (let i = 0; i < 4000 && d.stats().droppedOutputEvents < 20; i++) {
      d.bus.publish(out(i))
      if (i % 20 === 0) await new Promise((r) => setImmediate(r))
    }
    slow.ws.resume()
    await slow.waitEvent('client.resync', () => true, 10000)
    await slow.call('snapshot')
    await new Promise((r) => setTimeout(r, 200))
    expect(slow.messages.filter((m) => m.event === 'client.resync')).toHaveLength(1)
  })

  it('pasado el umbral duro se corta al cliente', async () => {
    const d = await boot({
      server: { softBufferBytes: 1024 * 1024 * 1024, hardBufferBytes: 512 * 1024 },
    })
    const slow = await authed(d)
    await slow.call('events.subscribe', {})
    slow.ws.pause()
    for (let i = 0; i < 4000 && d.stats().connections > 0; i++) {
      d.bus.publish(out(i))
      if (i % 20 === 0) await new Promise((r) => setImmediate(r))
    }
    expect(d.stats().connections).toBe(0)
    expect(await health(d)).toBe(200)
  })

  it('los eventos no suscritos no se envían', async () => {
    const d = await boot()
    const c = await authed(d)
    d.bus.publish(out(1))
    await c.call('events.subscribe', { events: ['pane.title'] })
    d.bus.publish(out(2))
    await new Promise((r) => setTimeout(r, 100))
    expect(c.messages.some((m) => m.event === 'terminal.output')).toBe(false)
  })
})

describe('descubrimiento y arranque', () => {
  it('reemplaza un daemon.json obsoleto (pid muerto) y su cerrojo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexo-stale-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(
      join(dir, 'daemon.json'),
      JSON.stringify({ version: '0', port: 1, pid: 2 ** 31 - 2, startedAt: 'x' }),
    )
    await writeFile(join(dir, 'daemon.lock'), `${2 ** 31 - 2}:viejo`)
    await writeFile(join(dir, 'token'), 'viejo')
    const d = await boot({ stateDir: dir })
    const info = JSON.parse(await readFile(join(dir, 'daemon.json'), 'utf8')) as {
      port: number
      pid: number
    }
    expect(info.pid).toBe(process.pid)
    expect(info.port).toBe(d.port)
    expect(await readFile(join(dir, 'token'), 'utf8')).toBe(d.token)
  })

  it('un daemon.json corrupto o con basura no impide arrancar', async () => {
    for (const body of ['{{{', '', 'null', '\u0000'.repeat(100), '{"pid":"x"}']) {
      const dir = await mkdtemp(join(tmpdir(), 'nexo-corrupt-'))
      cleanups.push(() => rm(dir, { recursive: true, force: true }))
      await writeFile(join(dir, 'daemon.json'), body)
      const d = await startDaemon({ port: 0, stateDir: dir, webRoot: null, logSink: () => {} })
      expect(JSON.parse(await readFile(join(dir, 'daemon.json'), 'utf8')).port).toBe(d.port)
      await d.stop()
    }
  })

  it('un cerrojo ilegible o con basura no impide arrancar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexo-lock-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'daemon.lock'), 'basura sin pid')
    const d = await boot({ stateDir: dir })
    expect(await health(d)).toBe(200)
  })

  it('dos daemons a la vez sobre el mismo directorio: exactamente uno arranca', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexo-race-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        startDaemon({ port: 0, stateDir: dir, webRoot: null, logSink: () => {} }),
      ),
    )
    const ok = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    for (const f of failed) expect(f.reason).toBeInstanceOf(DaemonAlreadyRunningError)
    for (const r of ok) await r.value.stop()
  })

  it('un puerto ocupado por otro programa da un error claro', async () => {
    const blocker = createServer((socket) => socket.destroy())
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())))
    const port = (blocker.address() as { port: number }).port
    const dir = await mkdtemp(join(tmpdir(), 'nexo-busy-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const err = await startDaemon({ port, stateDir: dir, webRoot: null, logSink: () => {} }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PortInUseError)
    expect((err as Error).message).toContain(String(port))
    // No quedó cerrojo colgado: se puede volver a intentar con otro puerto.
    const d = await boot({ stateDir: dir })
    expect(await health(d)).toBe(200)
  })

  it('un puerto ocupado por otro daemon de Nexo dice que ya está corriendo', async () => {
    const first = await boot()
    const dir = await mkdtemp(join(tmpdir(), 'nexo-other-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const err = await startDaemon({
      port: first.port,
      stateDir: dir,
      webRoot: null,
      logSink: () => {},
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DaemonAlreadyRunningError)
    expect((err as Error).message).toContain('ya está corriendo')
  })

  it('un servidor que responde /health sin la cabecera de Nexo no se confunde con un daemon', async () => {
    const { createServer: http } = await import('node:http')
    const fake = http((_q, res) => res.end('{"ok":true,"version":"x"}'))
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise<void>((r) => fake.close(() => r())))
    const port = (fake.address() as { port: number }).port
    const dir = await mkdtemp(join(tmpdir(), 'nexo-fake-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const err = await startDaemon({ port, stateDir: dir, webRoot: null, logSink: () => {} }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PortInUseError)
  })

  it('stop es idempotente y puede llamarse en paralelo', async () => {
    const d = await startTestDaemon()
    await Promise.all([d.stop(), d.stop(), d.cleanup()])
    await d.stop()
  })
})

describe('HTTP', () => {
  async function web() {
    const base = await mkdtemp(join(tmpdir(), 'nexo-web-'))
    const root = join(base, 'dist')
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<h1>hola</h1>')
    await writeFile(join(base, 'secreto.txt'), 'SECRETO')
    cleanups.push(() => rm(base, { recursive: true, force: true }))
    return root
  }

  const get = (port: number, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
              headers: res.headers,
            }),
          )
        })
        req.on('error', reject)
        req.end()
      },
    )

  it('sirve la web con CSP y nada fuera de la raíz', async () => {
    const root = await web()
    const d = await boot({ webRoot: root })
    const home = await get(d.port, '/')
    expect(home.body).toBe('<h1>hola</h1>')
    expect(String(home.headers['content-security-policy'])).toContain("default-src 'self'")
    for (const p of [
      '/../secreto.txt',
      '/..%2fsecreto.txt',
      '/%2e%2e/secreto.txt',
      '/%2e%2e%2fsecreto.txt',
      '/..%5csecreto.txt',
      '/..\\secreto.txt',
      '/C:\\Windows\\win.ini',
      '/C:/Windows/win.ini',
      '/%2fetc%2fpasswd',
      '//etc/passwd',
      '/assets/../../secreto.txt',
      '/%252e%252e/secreto.txt',
    ]) {
      const r = await get(d.port, p)
      expect(r.body, p).not.toContain('SECRETO')
      expect([400, 403, 404], p).toContain(r.status)
    }
  })

  it('no filtra el token por HTTP ni expone daemon.json', async () => {
    const root = await web()
    const d = await boot({ webRoot: root })
    for (const p of ['/token', '/daemon.json', `/health?t=${d.token}`]) {
      const r = await get(d.port, p)
      expect(r.body).not.toContain(d.token)
    }
    const h = await get(d.port, '/health')
    expect(JSON.parse(h.body)).toEqual({ ok: true, version: '0.0.0' })
  })

  it('sin web, todo lo que no es /health es 404; métodos raros no rompen', async () => {
    const d = await boot()
    expect((await get(d.port, '/')).status).toBe(404)
    expect((await get(d.port, `/${'a'.repeat(100000)}`)).status).toBeGreaterThanOrEqual(400)
    expect(await health(d)).toBe(200)
  })
})

describe('el token nunca llega a los logs', () => {
  it('ni en conexiones buenas, malas, rechazadas ni al detenerse', async () => {
    const d = await boot()
    const c = await authed(d)
    await c.call('daemon.info')
    await upgradeStatus(d.port, { protocols: ['nexo.v1', `nexo.token.${d.token}x`] })
    await upgradeStatus(d.port, { headers: { Origin: `http://evil.example/?t=${d.token}` } })
    const viaMsg = await raw(await openSocket(d.port))
    await viaMsg.request('auth', { token: d.token })
    const bad = await raw(await openSocket(d.port))
    await bad.request('auth', { token: `${d.token}!` })
    c.ws.send(`{"v":1,"id":"z","method":"auth","params":{"token":"${d.token}","extra":1}}`)
    await c.waitMessage((m) => m.id === 'z')
    await d.stop()
    expect(d.logs.length).toBeGreaterThan(0)
    for (const line of d.logs) expect(line).not.toContain(d.token)
  })
})
