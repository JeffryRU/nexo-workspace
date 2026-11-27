import { PaneId } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { FakeAgentProvider } from './fake-agent.ts'
import {
  FakeClock,
  FakeLogger,
  FakeNotifier,
  FakeProcessLauncher,
  FakePtyPort,
  FakeSessionStore,
  RecordingEventBus,
  SequentialIds,
} from './fakes.ts'

describe('FakeClock', () => {
  it('ejecuta los temporizadores vencidos en orden al avanzar', () => {
    const clock = new FakeClock(100)
    const order: number[] = []
    clock.setTimeout(() => order.push(2), 20)
    clock.setTimeout(() => order.push(1), 10)
    const cancel = clock.setTimeout(() => order.push(3), 15)
    cancel()
    clock.advance(25)
    expect(order).toEqual([1, 2])
    expect(clock.now()).toBe(125)
    expect(clock.pending).toBe(0)
  })
})

describe('SequentialIds', () => {
  it('genera ids deterministas y válidos', () => {
    const ids = new SequentialIds()
    expect([ids.workspace(), ids.tab(), ids.pane(), ids.pane(), ids.terminal()]).toEqual([
      'ws-1',
      'tab-1',
      'pane-1',
      'pane-2',
      'term-1',
    ])
  })
})

describe('RecordingEventBus', () => {
  it('registra y notifica; cancelar la suscripción deja de notificar', () => {
    const bus = new RecordingEventBus()
    const seen: string[] = []
    const off = bus.subscribe((e) => seen.push(e.event))
    const data = { paneId: PaneId.parse('p1'), attention: 'idle' as const }
    bus.publish({ event: 'pane.attention', data })
    off()
    bus.publish({ event: 'pane.attention', data })
    expect(seen).toEqual(['pane.attention'])
    expect(bus.ofType('pane.attention')).toHaveLength(2)
  })
})

describe('FakePtyPort', () => {
  it('se programa: salida, salida del proceso y fallo de spawn', async () => {
    const port = new FakePtyPort()
    const proc = await port.spawn({ cmd: 'sh', args: [], cols: 80, rows: 24 })
    const data: string[] = []
    const exits: unknown[] = []
    proc.onData((d) => data.push(d))
    proc.onExit((e) => exits.push(e))
    const fake = port.processes[0]
    fake?.emitData('hola')
    proc.write('ls')
    proc.resize(100, 30)
    fake?.exit({ exitCode: 3 })
    fake?.emitData('tarde')
    expect(data).toEqual(['hola'])
    expect(exits).toEqual([{ exitCode: 3, signal: null }])
    expect(fake?.written).toEqual(['ls'])
    expect(fake?.size).toEqual({ cols: 100, rows: 30 })
    port.failNextSpawn(new Error('boom'))
    await expect(port.spawn({ cmd: 'sh', args: [], cols: 80, rows: 24 })).rejects.toThrow('boom')
    await expect(port.spawn({ cmd: 'sh', args: [], cols: 0, rows: 24 })).rejects.toMatchObject({
      name: 'PtySpawnError',
      code: 'INVALID_OPTIONS',
    })
  })
})

describe('otros falsos', () => {
  it('FakeSessionStore guarda y carga', async () => {
    const store = new FakeSessionStore()
    expect(await store.load()).toBeNull()
    await store.save({ version: 1, workspaces: [] })
    expect(await store.load()).toEqual({ version: 1, workspaces: [] })
    expect(store.saves).toBe(1)
  })

  it('FakeNotifier y FakeLogger registran', async () => {
    const notifier = new FakeNotifier()
    await notifier.notify({ title: 't', body: 'b' })
    expect(notifier.sent).toHaveLength(1)
    const log = new FakeLogger()
    log.debug('a')
    log.info('b', { x: 1 })
    log.warn('c')
    log.error('d')
    expect(log.entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('FakeProcessLauncher y FakeAgentProvider son programables', async () => {
    const launcher = new FakeProcessLauncher()
    launcher.respond = () => ({ exitCode: 1, stdout: '', stderr: 'x', timedOut: false })
    expect((await launcher.run({ cmd: 'git', args: ['status'] })).exitCode).toBe(1)
    expect(launcher.calls).toHaveLength(1)
    const provider = new FakeAgentProvider('claude')
    provider.available = false
    expect(await provider.isAvailable()).toBe(false)
    await expect(provider.open({ cwd: '/x' })).rejects.toThrow()
  })
})
