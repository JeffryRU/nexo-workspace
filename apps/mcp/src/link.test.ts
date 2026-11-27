import { DiscoveryError } from '@nexo/client/node'
import { describe, expect, it } from 'vitest'
import { DaemonUnavailableError, describeError, ToolError } from './errors.ts'
import { DaemonLink, type LinkEvent, WATCHED_EVENTS } from './link.ts'
import { clientError, FakeClient, tick } from './test-helpers.ts'

function make(
  connect: () => Promise<FakeClient>,
  over: { cooldown?: number; now?: () => number } = {},
) {
  const logs: string[] = []
  const link = new DaemonLink({
    connect,
    logger: (m) => logs.push(m),
    failureCooldownMs: over.cooldown ?? 0,
    ...(over.now === undefined ? {} : { now: over.now }),
  })
  return { link, logs }
}

describe('DaemonLink', () => {
  it('conecta una sola vez aunque lo pidan a la vez y se suscribe a los eventos útiles', async () => {
    const fake = new FakeClient()
    let connects = 0
    const { link } = make(async () => {
      connects++
      return fake
    })
    const [a, b] = await Promise.all([link.get(), link.get()])
    expect(a).toBe(b)
    expect(connects).toBe(1)
    expect(link.connected).toBe(true)
    expect(fake.subscribed).toEqual([...WATCHED_EVENTS])
    expect(fake.subscribed).not.toContain('terminal.output')
  })

  it('reenvía los eventos y un resync', async () => {
    const fake = new FakeClient()
    const { link } = make(async () => fake)
    const seen: LinkEvent[] = []
    const off = link.onEvent((e) => seen.push(e))
    await link.get()
    fake.emit('limits.updated', { provider: 'codex', status: 'ok', windows: [] } as never)
    fake.emitResync()
    expect(seen.map((e) => e.name)).toEqual(['limits.updated', 'resync'])
    off()
    fake.emitResync()
    expect(seen).toHaveLength(2)
  })

  it('un oyente que falla no impide avisar a los demás', async () => {
    const fake = new FakeClient()
    const { link, logs } = make(async () => fake)
    const seen: string[] = []
    link.onEvent(() => {
      throw new Error('mal oyente')
    })
    link.onEvent((e) => seen.push(e.name))
    await link.get()
    fake.emitResync()
    expect(seen).toEqual(['resync'])
    expect(logs.some((l) => l.includes('mal oyente'))).toBe(true)
  })

  it('el cierre definitivo del cliente fuerza una conexión nueva', async () => {
    const clients = [new FakeClient(), new FakeClient()]
    let n = 0
    const { link } = make(async () => clients[n++] as FakeClient)
    const seen: string[] = []
    link.onEvent((e) => seen.push(e.name))
    await link.get()
    clients[0]?.emitState('closed')
    expect(link.connected).toBe(false)
    expect(seen).toEqual(['resync'])
    const again = await link.get()
    expect(again).toBe(clients[1])
  })

  it('daemon caído: error claro, y no martillea durante el enfriamiento', async () => {
    let attempts = 0
    let now = 0
    const { link, logs } = make(
      async () => {
        attempts++
        throw new DiscoveryError('NOT_RUNNING', 'no corre')
      },
      { cooldown: 1000, now: () => now },
    )
    await expect(link.get()).rejects.toBeInstanceOf(DaemonUnavailableError)
    await expect(link.get()).rejects.toThrow(/no está corriendo/)
    await expect(link.get()).rejects.toBeInstanceOf(DaemonUnavailableError)
    expect(attempts).toBe(1)
    now = 2000
    await expect(link.get()).rejects.toBeInstanceOf(DaemonUnavailableError)
    expect(attempts).toBe(2)
    expect(logs.length).toBeGreaterThan(0)
  })

  it('un fallo al suscribirse cierra el cliente y se vuelve a intentar', async () => {
    const bad = new FakeClient()
    bad.subscribe = async () => {
      throw clientError('UNAUTHORIZED')
    }
    const good = new FakeClient()
    const queue = [bad, good]
    const { link } = make(async () => queue.shift() as FakeClient)
    await expect(link.get()).rejects.toBeInstanceOf(DaemonUnavailableError)
    expect(bad.closed).toBe(true)
    await tick(5)
    expect(await link.get()).toBe(good)
  })

  it('close es definitivo', async () => {
    const fake = new FakeClient()
    const { link } = make(async () => fake)
    await link.get()
    link.close()
    expect(fake.closed).toBe(true)
    await expect(link.get()).rejects.toThrow(/se cerró/)
  })
})

describe('describeError', () => {
  it('traduce errores del daemon, del descubrimiento y propios', () => {
    expect(describeError(clientError('NOT_FOUND', 'sesión x'))).toMatchObject({ code: 'NOT_FOUND' })
    expect(describeError(clientError('CONFLICT')).message).toMatch(/estado actual/)
    expect(describeError(new DiscoveryError('STALE', 'x')).code).toBe('DAEMON_UNAVAILABLE')
    expect(describeError(new DiscoveryError('CORRUPT', 'x')).message).toMatch(/ilegible/)
    expect(describeError(new DiscoveryError('START_TIMEOUT', 'x')).message).toMatch(/a tiempo/)
    expect(describeError(new ToolError('FORBIDDEN', 'no')).code).toBe('FORBIDDEN')
    expect(describeError(new DaemonUnavailableError('caído')).message).toBe('caído')
  })

  it('un error cualquiera no filtra su mensaje ni su pila', () => {
    const d = describeError(new Error('ruta secreta C:/Users/x/token'))
    expect(d).toEqual({ code: 'INTERNAL', message: 'error inesperado en el servidor MCP' })
    expect(describeError('texto')).toMatchObject({ code: 'INTERNAL' })
  })

  it('redacta tokens que cite el mensaje del daemon', () => {
    const d = describeError(
      clientError('INTERNAL', 'falló con nexo.token.SECRETO123456 y Bearer abc'),
    )
    expect(d.message).not.toContain('SECRETO')
    expect(d.message).not.toContain('Bearer abc')
  })
})
