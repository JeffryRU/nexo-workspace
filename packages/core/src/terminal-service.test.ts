import { events, type PaneId } from '@nexo/contracts'
import { bootHarness as boot, FakePtyPort } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { DomainError } from './errors.ts'
import { PtySpawnError } from './ports/pty.ts'
import { TerminalService } from './terminal-service.ts'

async function code(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'OK'
}

describe('TerminalService.spawn', () => {
  it('crea la terminal, la enlaza al panel y usa el cwd del espacio', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    expect(proc.options).toMatchObject({ cmd: 'sh', args: [], cwd: '/work', cols: 80, rows: 24 })
    expect(t.snapshot.snapshot().workspaces[0]?.tabs[0]?.panes[0]?.terminalId).toBe(terminalId)
    expect(t.terminals.terminalOf(t.paneId)).toBe(terminalId)
    expect(t.bus.ofType('layout.changed').at(-1)?.panes[0]?.terminalId).toBe(terminalId)
  })

  it('respeta cmd, args, cwd y env explícitos', async () => {
    const t = await boot()
    await t.terminals.spawn({
      paneId: t.paneId,
      cmd: 'node',
      args: ['-v'],
      cwd: '/otro',
      env: { A: '1' },
      cols: 10,
      rows: 5,
    })
    expect(t.pty.processes[0]?.options).toEqual({
      cmd: 'node',
      args: ['-v'],
      cwd: '/otro',
      env: { A: '1' },
      cols: 10,
      rows: 5,
    })
  })

  it('sin cmd y sin comando por omisión es INVALID_PARAMS', async () => {
    const t = await boot()
    const bare = new TerminalService({
      pty: t.pty,
      bus: t.bus,
      clock: t.clock,
      ids: t.ids,
      panes: t.layout,
    })
    expect(await code(bare.spawn({ paneId: t.paneId, cols: 80, rows: 24 }))).toBe('INVALID_PARAMS')
  })

  it('mapea los errores del PTY a códigos de dominio y libera el panel', async () => {
    const pty = new FakePtyPort({ missingCmds: ['nada'], missingCwds: ['/nada'] })
    const t = await boot({ pty })
    const spawn = (extra: object) =>
      code(t.terminals.spawn({ paneId: t.paneId, cols: 80, rows: 24, ...extra }))
    expect(await spawn({ cmd: 'nada' })).toBe('NOT_FOUND')
    expect(await spawn({ cwd: '/nada' })).toBe('NOT_FOUND')
    pty.failNextSpawn(new PtySpawnError('INVALID_OPTIONS', 'x'))
    expect(await spawn({})).toBe('INVALID_PARAMS')
    pty.failNextSpawn(new PtySpawnError('SPAWN_FAILED', 'x'))
    expect(await spawn({})).toBe('INTERNAL')
    pty.failNextSpawn(new Error('secreto interno'))
    expect(await spawn({})).toBe('INTERNAL')
    expect(t.terminals.list()).toEqual([])
    expect(t.layout.paneContext(t.paneId)?.pane.terminalId).toBeUndefined()
    expect(await spawn({})).toBe('OK')
  })

  it('valida tamaño, panel y tipo de panel', async () => {
    const t = await boot()
    expect(await code(t.terminals.spawn({ paneId: t.paneId, cols: 0, rows: 24 }))).toBe(
      'INVALID_PARAMS',
    )
    expect(await code(t.terminals.spawn({ paneId: t.paneId, cols: 80, rows: 1.5 }))).toBe(
      'INVALID_PARAMS',
    )
    const ghost = 'fantasma' as PaneId
    expect(await code(t.terminals.spawn({ paneId: ghost, cols: 80, rows: 24 }))).toBe('NOT_FOUND')
    const agent = t.workspaces.split({ paneId: t.paneId, direction: 'row', kind: 'agent' }).pane
    expect(await code(t.terminals.spawn({ paneId: agent.id, cols: 80, rows: 24 }))).toBe('CONFLICT')
  })

  it('un panel admite una sola terminal viva; tras terminar se puede relanzar', async () => {
    const t = await boot()
    const first = await t.spawn()
    expect(await code(t.terminals.spawn({ paneId: t.paneId, cols: 80, rows: 24 }))).toBe('CONFLICT')
    first.proc.exit()
    const second = await t.spawn()
    expect(second.terminalId).not.toBe(first.terminalId)
    expect(await code(() => t.terminals.read({ terminalId: first.terminalId }))).toBe('NOT_FOUND')
    expect(t.terminals.list()).toHaveLength(1)
  })

  it('respeta el máximo de terminales vivas; las terminadas no cuentan', async () => {
    const t = await boot({ config: { maxTerminals: 2 } })
    const second = t.workspaces.split({ paneId: t.paneId, direction: 'row' }).pane
    const third = t.workspaces.split({ paneId: t.paneId, direction: 'row' }).pane
    const a = await t.spawn()
    await t.spawn(second.id)
    expect(await code(t.terminals.spawn({ paneId: third.id, cols: 80, rows: 24 }))).toBe('CONFLICT')
    a.proc.exit()
    expect(await code(t.terminals.spawn({ paneId: third.id, cols: 80, rows: 24 }))).toBe('OK')
  })
})

describe('TerminalService.write / resize / kill / list', () => {
  it('escribe y redimensiona el proceso', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    t.terminals.write({ terminalId, data: 'ls\r' })
    t.terminals.resize({ terminalId, cols: 100, rows: 30 })
    expect(proc.written).toEqual(['ls\r'])
    expect(proc.size).toEqual({ cols: 100, rows: 30 })
    expect(t.terminals.list()[0]).toMatchObject({ cols: 100, rows: 30, state: 'running' })
  })

  it('rechaza ids inexistentes, escrituras enormes y tamaños inválidos', async () => {
    const t = await boot()
    const { terminalId } = await t.spawn()
    const ghost = 'nada' as typeof terminalId
    expect(await code(() => t.terminals.write({ terminalId: ghost, data: 'x' }))).toBe('NOT_FOUND')
    expect(await code(() => t.terminals.resize({ terminalId: ghost, cols: 1, rows: 1 }))).toBe(
      'NOT_FOUND',
    )
    expect(await code(() => t.terminals.kill({ terminalId: ghost }))).toBe('NOT_FOUND')
    expect(await code(() => t.terminals.read({ terminalId: ghost }))).toBe('NOT_FOUND')
    expect(await code(() => t.terminals.write({ terminalId, data: 'x'.repeat(65 * 1024) }))).toBe(
      'PAYLOAD_TOO_LARGE',
    )
    expect(await code(() => t.terminals.resize({ terminalId, cols: 0, rows: 5 }))).toBe(
      'INVALID_PARAMS',
    )
    expect(await code(() => t.terminals.resize({ terminalId, cols: 5, rows: 1001 }))).toBe(
      'INVALID_PARAMS',
    )
  })

  it('escribir o redimensionar una terminal terminada es CONFLICT; leer sigue valiendo', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    proc.emitData('adiós')
    proc.exit({ exitCode: 3 })
    expect(await code(() => t.terminals.write({ terminalId, data: 'x' }))).toBe('CONFLICT')
    expect(await code(() => t.terminals.resize({ terminalId, cols: 5, rows: 5 }))).toBe('CONFLICT')
    expect(t.terminals.read({ terminalId }).data).toBe('adiós')
    expect(t.terminals.list()[0]).toMatchObject({ state: 'exited', exit: { exitCode: 3 } })
  })

  it('kill usa SIGTERM por omisión, acepta una señal y es idempotente', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    t.terminals.kill({ terminalId, signal: 'SIGINT' })
    expect(proc.killedWith).toBe('SIGINT')
    t.terminals.kill({ terminalId })
    expect(t.bus.ofType('terminal.exit')).toEqual([
      { terminalId, exitCode: null, signal: 'SIGINT' },
    ])
    const other = await boot()
    const second = await other.spawn()
    other.terminals.kill({ terminalId: second.terminalId })
    expect(second.proc.killedWith).toBe('SIGTERM')
  })

  it('limita la frecuencia de escritura con una ventana deslizante', async () => {
    const t = await boot({ config: { writeRate: { maxWrites: 3, windowMs: 1000 } } })
    const { terminalId, proc } = await t.spawn()
    const write = () => t.terminals.write({ terminalId, data: 'x' })
    write()
    t.clock.advance(400)
    write()
    t.clock.advance(400)
    write()
    try {
      write()
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('RATE_LIMITED')
      expect((error as DomainError).data).toEqual({ retryAfterMs: 200 })
    }
    expect(proc.written).toHaveLength(3)
    t.clock.advance(200)
    write()
    expect(proc.written).toHaveLength(4)
    expect(await code(() => write())).toBe('RATE_LIMITED')
  })

  it('el límite de escritura es por terminal', async () => {
    const t = await boot({ config: { writeRate: { maxWrites: 1, windowMs: 1000 } } })
    const second = t.workspaces.split({ paneId: t.paneId, direction: 'row' }).pane
    const a = await t.spawn()
    const b = await t.spawn(second.id)
    t.terminals.write({ terminalId: a.terminalId, data: 'x' })
    expect(await code(() => t.terminals.write({ terminalId: a.terminalId, data: 'x' }))).toBe(
      'RATE_LIMITED',
    )
    expect(await code(() => t.terminals.write({ terminalId: b.terminalId, data: 'x' }))).toBe('OK')
  })
})

describe('TerminalService: salida', () => {
  it('agrupa la salida cada 8 ms y publica terminal.output con el offset del final', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    proc.emitData('hola ')
    proc.emitData('é')
    expect(t.bus.ofType('terminal.output')).toEqual([])
    t.clock.advance(8)
    expect(t.bus.ofType('terminal.output')).toEqual([{ terminalId, offset: 7, data: 'hola é' }])
    proc.emitData('€')
    t.clock.advance(8)
    expect(t.bus.ofType('terminal.output').at(-1)).toEqual({ terminalId, offset: 10, data: '€' })
    for (const e of t.bus.ofType('terminal.output'))
      expect(events['terminal.output'].safeParse(e).success).toBe(true)
  })

  it('al terminar vacía lo pendiente antes de emitir terminal.exit', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    proc.emitData('último')
    proc.exit({ exitCode: 0 })
    const names = t.bus.events.map((e) => e.event).filter((n) => n.startsWith('terminal.'))
    expect(names).toEqual(['terminal.output', 'terminal.exit'])
    expect(t.bus.ofType('terminal.output')[0]).toEqual({ terminalId, offset: 7, data: 'último' })
    t.clock.advance(100)
    expect(t.bus.ofType('terminal.output')).toHaveLength(1)
  })

  it('une un par sustituto partido entre dos trozos del proceso', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    proc.emitData('a\ud83d')
    proc.emitData('\ude00b')
    t.clock.advance(8)
    expect(t.bus.ofType('terminal.output')).toEqual([{ terminalId, offset: 6, data: 'a😀b' }])
    expect(t.terminals.read({ terminalId })).toEqual({ data: 'a😀b', offset: 6 })
  })

  it('un sustituto alto final se entrega al terminar el proceso', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    proc.emitData('x\ud83d')
    proc.exit()
    expect(t.terminals.read({ terminalId }).data).toBe('x\ud83d')
  })

  it('read devuelve lo más reciente, por tramos y con truncated', async () => {
    const t = await boot({ config: { ringCapacityBytes: 8 } })
    const { terminalId, proc } = await t.spawn()
    proc.emitData('0123456789')
    expect(t.terminals.read({ terminalId })).toEqual({ data: '23456789', offset: 10 })
    expect(t.terminals.read({ terminalId, maxBytes: 3 })).toEqual({ data: '789', offset: 10 })
    expect(t.terminals.read({ terminalId, fromOffset: 0 })).toEqual({
      data: '23456789',
      offset: 10,
      truncated: true,
    })
    expect(t.terminals.read({ terminalId, fromOffset: 4, maxBytes: 2 })).toEqual({
      data: '45',
      offset: 6,
    })
    expect(t.terminals.read({ terminalId, fromOffset: 10 })).toEqual({ data: '', offset: 10 })
  })

  it('los offsets de los eventos coinciden con los de read', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    for (let i = 0; i < 5; i++) {
      proc.emitData(`línea ${i}\r\n`)
      t.clock.advance(8)
    }
    const last = t.bus.ofType('terminal.output').at(-1)
    expect(last?.offset).toBe(t.terminals.read({ terminalId }).offset)
  })
})

describe('TerminalService: título', () => {
  it('extrae el título OSC 0/2, lo guarda en el panel y emite pane.title', async () => {
    const t = await boot()
    const { proc } = await t.spawn()
    proc.emitData('\x1b]0;vim main.ts\x07')
    expect(t.bus.ofType('pane.title')).toEqual([{ paneId: t.paneId, title: 'vim main.ts' }])
    expect(t.layout.paneContext(t.paneId)?.pane.title).toBe('vim main.ts')
    proc.emitData('\x1b]2;vim main.ts\x1b\\')
    expect(t.bus.ofType('pane.title')).toHaveLength(1)
    proc.emitData('\x1b]2;otro\x07')
    expect(t.bus.ofType('pane.title')).toHaveLength(2)
  })

  it('funciona con la secuencia partida entre trozos y no emite layout.changed', async () => {
    const t = await boot()
    const { proc } = await t.spawn()
    const before = t.bus.ofType('layout.changed').length
    proc.emitData('\x1b]0;par')
    proc.emitData('tido\x07')
    expect(t.bus.ofType('pane.title')[0]?.title).toBe('partido')
    expect(t.bus.ofType('layout.changed')).toHaveLength(before)
  })
})

describe('TerminalService: cierre', () => {
  it('cerrar el panel mata la terminal, la olvida y corta la salida', async () => {
    const t = await boot()
    const { terminalId, proc } = await t.spawn()
    proc.emitData('pendiente')
    t.workspaces.closePane({ paneId: t.paneId })
    expect(proc.killedWith).toBe('SIGKILL')
    expect(t.terminals.list()).toEqual([])
    expect(await code(() => t.terminals.read({ terminalId }))).toBe('NOT_FOUND')
    proc.emitData('tarde')
    t.clock.advance(100)
    expect(t.bus.ofType('terminal.output')).toEqual([])
    expect(t.bus.ofType('terminal.exit')).toHaveLength(1)
  })

  it('shutdown mata todas', async () => {
    const t = await boot()
    const second = t.workspaces.split({ paneId: t.paneId, direction: 'row' }).pane
    const a = await t.spawn()
    const b = await t.spawn(second.id)
    t.terminals.shutdown()
    expect(a.proc.killedWith).toBe('SIGKILL')
    expect(b.proc.killedWith).toBe('SIGKILL')
    expect(t.terminals.list()).toEqual([])
  })
})
