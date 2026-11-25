import type { ClientOptions } from '@nexo/client'
import { QueryClient } from '@tanstack/solid-query'
import { describe, expect, it } from 'vitest'
import {
  FakeClient,
  layoutEvent,
  manualFrames,
  mkPane,
  mkTab,
  mkWorkspace,
  snapshotOf,
  workspaceEvent,
  xid,
} from '../test-helpers.ts'
import { createDaemonSession } from './session.ts'

const info = { port: 4317, token: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345' }
const tick = () => new Promise((r) => setTimeout(r, 0))

function setup(client = new FakeClient(), queryClient?: QueryClient) {
  const frames = manualFrames()
  const captured: { options?: ClientOptions } = {}
  const session = createDaemonSession({
    info,
    makeClient: (options) => {
      captured.options = options
      return client
    },
    frame: frames.frame,
    ...(queryClient === undefined ? {} : { queryClient }),
  })
  return { session, client, frames, captured }
}

const withTerminal = () => {
  const tab = mkTab('t1', ['p1'])
  return mkWorkspace('w1', [{ ...tab, panes: [mkPane('p1', { terminalId: xid('x1') })] }])
}

describe('createDaemonSession', () => {
  it('conecta, se suscribe y carga el snapshot inicial', async () => {
    const { session, client } = setup()
    client.snapshot = snapshotOf([mkWorkspace('w1', [mkTab('t1')])], 3)
    expect(session.status()).toBe('connecting')
    await session.start()
    expect(session.status()).toBe('open')
    expect(session.store.state.workspaces[0]?.id).toBe('w1')
    expect(client.callsOf('snapshot')).toHaveLength(1)
  })

  it('usa la caché de solid-query para el snapshot inicial', async () => {
    const qc = new QueryClient()
    const { session, client } = setup(new FakeClient(), qc)
    client.snapshot = snapshotOf([mkWorkspace('w1')], 1)
    await session.start()
    expect(session.store.state.workspaces).toHaveLength(1)
  })

  it('si no se puede conectar queda sin conexión y permite reintentar', async () => {
    const client = new FakeClient()
    client.connectError = new Error('rechazada')
    const { session } = setup(client)
    await session.start()
    expect(session.status()).toBe('offline')
    expect(session.failure()).toBe('unreachable')
    client.connectError = undefined
    await session.retry()
    expect(session.status()).toBe('open')
    expect(session.failure()).toBeUndefined()
  })

  it('aplica los eventos del daemon al store', async () => {
    const { session, client } = setup()
    client.snapshot = snapshotOf([mkWorkspace('w1', [mkTab('t1')])], 1)
    await session.start()
    const ev = layoutEvent('w1', mkTab('t1', ['p1', 'p2']), 2)
    client.emit(ev.event, ev.data, ev.seq)
    expect(session.store.state.workspaces[0]?.tabs[0]?.panes).toHaveLength(2)
    const w = workspaceEvent(mkWorkspace('w2'), 3)
    client.emit(w.event, w.data, w.seq)
    expect(session.store.state.workspaces).toHaveLength(2)
  })

  it('la salida de terminal va al hub y no pasa por el store', async () => {
    const { session, client, frames } = setup()
    client.snapshot = snapshotOf([withTerminal()], 1)
    await session.start()
    await tick()
    expect(client.callsOf('terminal.read')[0]?.params).toMatchObject({ maxBytes: 256 * 1024 })
    const written: string[] = []
    session.hub.attach('x1', {
      write: (d, done) => {
        written.push(d)
        done()
      },
      reset: () => {},
    })
    client.emit('terminal.output', { terminalId: xid('x1'), offset: 2, data: 'hi' }, 2)
    frames.flush()
    expect(written.join('')).toBe('hi')
    expect(session.store.snapshot().seq).toBe(1)
  })

  it('al reconectar (snapshot por resync) reconstruye el estado y relee desde el último offset', async () => {
    const { session, client, frames, captured } = setup()
    client.snapshot = snapshotOf([withTerminal()], 1)
    let history = ''
    client.handlers.set('terminal.read', (p) => {
      const from = (p as { fromOffset?: number }).fromOffset ?? 0
      return { data: history.slice(from), offset: history.length }
    })
    await session.start()
    await tick()
    const written: string[] = []
    session.hub.attach('x1', {
      write: (d, done) => {
        written.push(d)
        done()
      },
      reset: () => {},
    })
    session.hub.setVisible('x1', true)
    history = 'hola'
    client.emit('terminal.output', { terminalId: xid('x1'), offset: 4, data: 'hola' }, 2)
    frames.flush()
    // Se pierde la conexión; mientras tanto el daemon produjo más salida y otro espacio.
    client.setState('reconnecting')
    expect(session.status()).toBe('reconnecting')
    history = 'hola mundo'
    client.snapshot = snapshotOf([withTerminal(), mkWorkspace('w9')], 1)
    client.setState('open')
    // El cliente real invoca onSnapshot tras reconectar.
    captured.options?.onSnapshot?.(await client.call('snapshot', {}), { reason: 'reconnect' })
    await tick()
    await tick()
    frames.flush()
    expect(session.store.state.workspaces.map((w) => w.id)).toEqual(['w1', 'w9'])
    expect(written.join('')).toBe('hola mundo')
  })
  it('un resync relee las terminales sin esperar al snapshot (que puede perderse en plena ráfaga)', async () => {
    const { session, client, frames } = setup()
    client.snapshot = snapshotOf([withTerminal()], 1)
    let history = ''
    client.handlers.set('terminal.read', (p) => {
      const from = (p as { fromOffset?: number }).fromOffset ?? 0
      return { data: history.slice(from), offset: history.length }
    })
    await session.start()
    await tick()
    const written: string[] = []
    session.hub.attach('x1', {
      write: (d, done) => {
        written.push(d)
        done()
      },
      reset: () => {},
    })
    session.hub.setVisible('x1', true)
    const reads = client.callsOf('terminal.read').length
    // El snapshot no responde jamás: la relectura no depende de él.
    client.handlers.set('snapshot', () => new Promise(() => {}) as never)
    history = 'ultima linea'
    client.emit('resync', { reason: 'backpressure', dropped: 9 })
    await tick()
    await tick()
    frames.flush()
    expect(client.callsOf('terminal.read').length).toBeGreaterThan(reads)
    expect(written.join('')).toBe('ultima linea')
  })

  it('el estado de la conexión sigue al cliente y el cierre definitivo deja sin conexión', async () => {
    const { session, client } = setup()
    await session.start()
    client.setState('reconnecting')
    expect(session.status()).toBe('reconnecting')
    client.setState('open')
    expect(session.status()).toBe('open')
    client.setState('closed')
    expect(session.status()).toBe('offline')
    expect(session.failure()).toBe('closed')
  })

  it('las acciones no llaman al daemon mientras no hay conexión', async () => {
    const { session, client } = setup()
    await session.start()
    client.setState('reconnecting')
    const before = client.calls.length
    await session.actions.newTab()
    expect(client.calls.length).toBe(before)
  })

  it('request usa el cliente actual y dispose cierra', async () => {
    const { session, client } = setup()
    await expect(session.request('daemon.info', {})).rejects.toThrow()
    await session.start()
    expect((await session.request('daemon.info', {})).version).toBe('9.9.9')
    session.dispose()
    expect(client.closed).toBe(true)
  })

  it('ignora eventos de un cliente anterior tras reintentar', async () => {
    const first = new FakeClient()
    const second = new FakeClient()
    const clients = [first, second]
    const frames = manualFrames()
    const session = createDaemonSession({
      info,
      makeClient: () => clients.shift() as FakeClient,
      frame: frames.frame,
    })
    await session.start()
    await session.retry()
    const w = workspaceEvent(mkWorkspace('viejo'), 5)
    first.emit(w.event, w.data, w.seq)
    expect(session.store.state.workspaces).toHaveLength(0)
    expect(first.closed).toBe(true)
  })
})
