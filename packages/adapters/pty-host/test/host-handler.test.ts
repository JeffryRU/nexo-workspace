import { describe, expect, it } from 'vitest'
import { createHostHandler, type HostSpawnOptions, type PtyLike } from '../src/host-handler.ts'
import { type HostEvent, parseHostEvent } from '../src/protocol.ts'

type ExitCb = (e: { exitCode: number | undefined; signal?: number | undefined }) => void

class FakePty implements PtyLike {
  readonly pid = 77
  readonly calls: string[] = []
  dataCb: (d: string) => void = () => {}
  exitCb: ExitCb = () => {}
  throwOnWrite = false
  throwOnKill = false
  write(data: string): void {
    if (this.throwOnWrite) throw new Error('boom')
    this.calls.push(`write:${data}`)
  }
  resize(cols: number, rows: number): void {
    this.calls.push(`resize:${cols}x${rows}`)
  }
  kill(signal?: string): void {
    if (this.throwOnKill) throw new Error('ya murió')
    this.calls.push(`kill:${signal ?? '-'}`)
  }
  onData(cb: (d: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: ExitCb): void {
    this.exitCb = cb
  }
}

const spawnMsg = (id: number) => ({
  t: 'spawn',
  id,
  file: 'x',
  args: [],
  cwd: '/',
  env: {},
  name: 'xterm',
  cols: 80,
  rows: 24,
  conptyDll: false,
})

function setup(platform: NodeJS.Platform, failSpawn?: unknown) {
  const events: HostEvent[] = []
  const logs: string[] = []
  const ptys: FakePty[] = []
  const spawned: HostSpawnOptions[] = []
  let exited = 0
  const handle = createHostHandler({
    platform,
    killSpacingMs: 1,
    send: (e) => events.push(e),
    log: (m) => logs.push(m),
    exit: () => {
      exited++
    },
    spawnPty: (o) => {
      if (failSpawn !== undefined) throw failSpawn
      spawned.push(o)
      const p = new FakePty()
      ptys.push(p)
      return p
    },
  })
  return { handle, events, logs, ptys, spawned, exited: () => exited }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('createHostHandler', () => {
  it('lanza, reenvía datos y salida', () => {
    const s = setup('linux')
    s.handle(spawnMsg(1))
    expect(s.events).toEqual([{ t: 'spawned', id: 1, pid: 77 }])
    s.ptys[0]?.dataCb('hola')
    s.ptys[0]?.exitCb({ exitCode: 3 })
    expect(s.events.slice(1)).toEqual([
      { t: 'data', id: 1, data: 'hola' },
      { t: 'exit', id: 1, exitCode: 3, signal: null },
    ])
  })

  it('una salida sin código de salida se envía como exitCode null (no como evento inválido)', () => {
    const s = setup('win32')
    s.handle(spawnMsg(1))
    s.ptys[0]?.exitCb({ exitCode: undefined, signal: undefined })
    expect(s.events[1]).toEqual({ t: 'exit', id: 1, exitCode: null, signal: null })
    expect(parseHostEvent(s.events[1])).toMatchObject({ ok: true })
    expect(s.logs.join(' ')).toContain('sin código de salida')
  })

  it('rechaza ids repetidos y errores de node-pty', () => {
    const s = setup('linux')
    s.handle(spawnMsg(1))
    s.handle(spawnMsg(1))
    expect(s.events[1]).toMatchObject({ t: 'spawn-error', id: 1 })
    const f = setup('linux', new Error('sin ConPTY'))
    f.handle(spawnMsg(2))
    expect(f.events[0]).toEqual({ t: 'spawn-error', id: 2, message: 'sin ConPTY' })
    const g = setup('linux', 'texto')
    g.handle(spawnMsg(3))
    expect(g.events[0]).toMatchObject({ message: 'texto' })
  })

  it('descarta mensajes inválidos', () => {
    const s = setup('linux')
    s.handle({ t: 'spawn', id: -1 })
    s.handle(null)
    expect(s.logs).toHaveLength(2)
    expect(s.events).toEqual([])
  })

  it('write y resize llegan al PTY; las excepciones y los ids desconocidos se ignoran', () => {
    const s = setup('linux')
    s.handle(spawnMsg(1))
    s.handle({ t: 'write', id: 1, data: 'a' })
    s.handle({ t: 'resize', id: 1, cols: 10, rows: 5 })
    s.handle({ t: 'write', id: 99, data: 'a' })
    expect(s.ptys[0]?.calls).toEqual(['write:a', 'resize:10x5'])
    if (s.ptys[0]) s.ptys[0].throwOnWrite = true
    expect(() => s.handle({ t: 'write', id: 1, data: 'b' })).not.toThrow()
  })

  it('kill en Linux manda la señal (SIGTERM por omisión) y tolera fallos', () => {
    const s = setup('linux')
    s.handle(spawnMsg(1))
    s.handle({ t: 'kill', id: 1 })
    s.handle({ t: 'kill', id: 1, signal: 'SIGKILL' })
    expect(s.ptys[0]?.calls).toEqual(['kill:SIGTERM', 'kill:SIGKILL'])
    if (s.ptys[0]) s.ptys[0].throwOnKill = true
    expect(() => s.handle({ t: 'kill', id: 1 })).not.toThrow()
    s.ptys[0]?.exitCb({ exitCode: 0 })
    s.handle({ t: 'kill', id: 1 })
  })

  it('en Windows: kill espaciado y sin señal, un solo kill, y write/resize se ignoran después', async () => {
    const s = setup('win32')
    s.handle(spawnMsg(1))
    s.handle(spawnMsg(2))
    s.handle({ t: 'kill', id: 1, signal: 'SIGKILL' })
    s.handle({ t: 'kill', id: 1 })
    s.handle({ t: 'kill', id: 2 })
    s.handle({ t: 'write', id: 1, data: 'x' })
    s.handle({ t: 'resize', id: 1, cols: 5, rows: 5 })
    await tick()
    expect(s.ptys[0]?.calls).toEqual(['kill:-'])
    expect(s.ptys[1]?.calls).toEqual(['kill:-'])
  })

  it('en Windows, un kill pendiente se omite si la terminal ya salió', async () => {
    const s = setup('win32')
    s.handle(spawnMsg(1))
    s.handle({ t: 'kill', id: 1 })
    s.ptys[0]?.exitCb({ exitCode: 0 })
    await tick()
    expect(s.ptys[0]?.calls).toEqual([])
  })

  it('shutdown mata todas las terminales y termina el proceso', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const s = setup(platform)
      s.handle(spawnMsg(1))
      s.handle(spawnMsg(2))
      s.handle({ t: 'shutdown' })
      await tick(300)
      expect(s.ptys.map((p) => p.calls)).toEqual(
        platform === 'linux' ? [['kill:SIGHUP'], ['kill:SIGHUP']] : [['kill:-'], ['kill:-']],
      )
      expect(s.exited()).toBe(1)
    }
  })
})
