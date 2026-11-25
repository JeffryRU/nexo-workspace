import { DisplayText, events, type PaneId, type TerminalId, utf8ByteLength } from '@nexo/contracts'
import { bootHarness, SequentialIds } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { DomainError } from './errors.ts'
import type { IdPort } from './ports/misc.ts'

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'OK'
}

describe('TerminalService (adversarial): salida', () => {
  it('ráfaga de 50 MB en trozos de 64 KiB: offsets monótonos, trozos acotados y búfer acotado', async () => {
    const t = await bootHarness()
    const { terminalId, proc } = await t.spawn()
    const piece = `${'ñ'.repeat(32 * 1024 - 1)}\n`
    const count = Math.ceil((50 * 1024 * 1024) / utf8ByteLength(piece))
    for (let i = 0; i < count; i++) proc.emitData(piece)
    t.clock.advance(8)
    const out = t.bus.ofType('terminal.output')
    let previous = 0
    let total = 0
    for (const e of out) {
      expect(e.offset).toBeGreaterThan(previous)
      expect(utf8ByteLength(e.data)).toBeLessThanOrEqual(64 * 1024)
      total += utf8ByteLength(e.data)
      expect(e.offset).toBe(total)
      previous = e.offset
    }
    expect(total).toBe(count * utf8ByteLength(piece))
    const read = t.terminals.read({ terminalId })
    expect(read.offset).toBe(total)
    expect(utf8ByteLength(read.data)).toBeLessThanOrEqual(1024 * 1024)
    expect(t.terminals.list()[0]?.offset).toBe(total)
  }, 60_000)

  it('ráfaga de 50 MB en un solo trozo no revienta ni supera el tamaño de mensaje', async () => {
    const t = await bootHarness()
    const { proc } = await t.spawn()
    proc.emitData('z'.repeat(50 * 1024 * 1024))
    t.clock.advance(8)
    for (const e of t.bus.ofType('terminal.output').slice(0, 5)) {
      expect(events['terminal.output'].safeParse(e).success).toBe(true)
    }
    const last = t.bus.ofType('terminal.output').at(-1)
    expect(last?.offset).toBe(50 * 1024 * 1024)
  }, 60_000)

  it('un carácter de 4 bytes partido en cada posición posible llega íntegro', async () => {
    const text = 'a😀b𝔘c€d'
    for (let cut = 0; cut <= text.length; cut++) {
      const t = await bootHarness()
      const { terminalId, proc } = await t.spawn()
      proc.emitData(text.slice(0, cut))
      t.clock.advance(3)
      proc.emitData(text.slice(cut))
      t.clock.advance(8)
      const joined = t.bus
        .ofType('terminal.output')
        .map((e) => e.data)
        .join('')
      expect(joined).toBe(text)
      expect(t.bus.ofType('terminal.output').at(-1)?.offset).toBe(utf8ByteLength(text))
      expect(t.terminals.read({ terminalId }).data).toBe(text)
    }
  })

  it('salida de un solo byte por trozo con multibyte en medio', async () => {
    const t = await bootHarness()
    const { terminalId, proc } = await t.spawn()
    const text = 'x😀y'
    for (const ch of text) proc.emitData(ch)
    t.clock.advance(8)
    expect(t.terminals.read({ terminalId }).data).toBe(text)
  })

  it('sustitutos sueltos hostiles no rompen los límites ni los eventos', async () => {
    const t = await bootHarness({ config: { ringCapacityBytes: 16 } })
    const { terminalId, proc } = await t.spawn()
    for (const junk of ['\ude00', '\ud83d\ud83d', '\ude00\ud83d', '\ud83d']) {
      proc.emitData(junk.repeat(50))
    }
    proc.exit()
    expect(utf8ByteLength(t.terminals.read({ terminalId }).data)).toBeLessThanOrEqual(16)
    for (const e of t.bus.ofType('terminal.output')) {
      expect(events['terminal.output'].safeParse(e).success).toBe(true)
    }
  })
})

describe('TerminalService (adversarial): título OSC', () => {
  it('secuencias hostiles nunca producen un título inválido', async () => {
    const t = await bootHarness()
    const { proc } = await t.spawn()
    const hostile = [
      `\x1b]0;${'A'.repeat(100000)}\x07`,
      '\x1b]0;\x1b[2J\x1b[Hlimpia\x07',
      '\x1b]0;a\nb\rc\u0000d‮e\x07',
      '\x1b]2;\x1b]2;anidado\x07',
      '\x1b]0;sin terminar',
      `]0;${String.fromCodePoint(0x85, 0x2028, 0x2029)}`,
      `${']0;😀'.repeat(300)}`,
      '\x1b]\x1b]\x1b]\x07\x07',
      '\x1b'.repeat(5000),
      `\x1b]0;${'\x1b'.repeat(5000)}\x07`,
      '\x9d0;c1 osc\x9c',
    ]
    for (const h of hostile) {
      proc.emitData(h)
      proc.emitData('\x1b]0;ok\x07')
    }
    const titles = t.bus.ofType('pane.title')
    expect(titles.length).toBeGreaterThan(0)
    for (const e of titles) {
      expect(events['pane.title'].safeParse(e).success).toBe(true)
      expect(DisplayText.safeParse(e.title).success).toBe(true)
    }
    expect(t.layout.paneContext(t.paneId)?.pane.title).toBe('ok')
  })

  it('un OSC enorme repartido en miles de trozos no acumula memoria ni emite títulos', async () => {
    const t = await bootHarness()
    const { proc } = await t.spawn()
    proc.emitData('\x1b]0;')
    for (let i = 0; i < 5000; i++) proc.emitData('B'.repeat(1000))
    proc.emitData('\x07')
    expect(t.bus.ofType('pane.title')).toEqual([])
    proc.emitData('\x1b]0;vuelve\x07')
    expect(t.bus.ofType('pane.title').at(-1)?.title).toBe('vuelve')
  })

  it('el título no cambia tras cerrar el panel', async () => {
    const t = await bootHarness()
    const { proc } = await t.spawn()
    t.workspaces.closePane({ paneId: t.paneId })
    proc.emitData('\x1b]0;tarde\x07')
    expect(t.bus.ofType('pane.title')).toEqual([])
  })
})

describe('TerminalService (adversarial): ciclo de vida', () => {
  it('escribir, redimensionar, leer y matar tras cerrar el panel dan NOT_FOUND sin lanzar otra cosa', async () => {
    const t = await bootHarness()
    const { terminalId } = await t.spawn()
    t.workspaces.closePane({ paneId: t.paneId })
    expect(await codeOf(() => t.terminals.write({ terminalId, data: 'x' }))).toBe('NOT_FOUND')
    expect(await codeOf(() => t.terminals.resize({ terminalId, cols: 5, rows: 5 }))).toBe(
      'NOT_FOUND',
    )
    expect(await codeOf(() => t.terminals.read({ terminalId }))).toBe('NOT_FOUND')
    expect(await codeOf(() => t.terminals.kill({ terminalId }))).toBe('NOT_FOUND')
    t.terminals.closePane(t.paneId)
  })

  it('cerrar un panel mientras la terminal emite no deja eventos ni terminales', async () => {
    const t = await bootHarness()
    const { proc } = await t.spawn()
    proc.emitData('a'.repeat(100))
    t.workspaces.closePane({ paneId: t.paneId })
    for (let i = 0; i < 10; i++) proc.emitData('b'.repeat(70 * 1024))
    t.clock.advance(1000)
    expect(t.bus.ofType('terminal.output')).toEqual([])
    expect(t.terminals.list()).toEqual([])
    expect(t.clock.pending).toBe(0)
  })

  it('con un PTY que tarda en morir, el exit llega una vez y no hay terminal fantasma', async () => {
    const t = await bootHarness()
    const { proc } = await t.spawn()
    // Un proceso que ignora kill: la terminal se olvida igual y su salida tardía se descarta.
    proc.kill = () => {}
    t.workspaces.closePane({ paneId: t.paneId })
    proc.emitData('zombi')
    proc.exit({ exitCode: 9 })
    proc.exit({ exitCode: 1 })
    expect(t.bus.ofType('terminal.exit')).toHaveLength(1)
    expect(t.bus.ofType('terminal.output')).toEqual([])
    expect(t.terminals.list()).toEqual([])
  })

  it('kill durante un spawn pendiente mata el proceso en cuanto existe', async () => {
    const t = await bootHarness()
    const pending = t.terminals.spawn({ paneId: t.paneId, cols: 80, rows: 24 })
    const [info] = t.terminals.list()
    expect(info?.state).toBe('starting')
    const terminalId = info?.terminalId as TerminalId
    expect(await codeOf(() => t.terminals.write({ terminalId, data: 'x' }))).toBe('CONFLICT')
    t.terminals.kill({ terminalId, signal: 'SIGHUP' })
    await pending
    const proc = t.pty.processes[0]
    expect(proc?.killedWith).toBe('SIGHUP')
    expect(t.bus.ofType('terminal.exit')).toEqual([
      { terminalId, exitCode: null, signal: 'SIGHUP' },
    ])
    expect(t.terminals.list()[0]?.state).toBe('exited')
  })

  it('cerrar el panel durante un spawn pendiente rechaza el spawn y mata el proceso', async () => {
    const t = await bootHarness()
    const pending = t.terminals.spawn({ paneId: t.paneId, cols: 80, rows: 24 })
    t.workspaces.closePane({ paneId: t.paneId })
    expect(await codeOf(() => pending)).toBe('CONFLICT')
    expect(t.pty.processes[0]?.exited).toBeDefined()
    expect(t.terminals.list()).toEqual([])
    expect(t.bus.ofType('terminal.exit')).toEqual([])
  })

  it('cerrar el panel durante un spawn que además falla da el error del PTY y no deja rastro', async () => {
    const t = await bootHarness()
    t.pty.failNextSpawn(new Error('falla'))
    const pending = t.terminals.spawn({ paneId: t.paneId, cols: 80, rows: 24 })
    t.workspaces.closePane({ paneId: t.paneId })
    expect(await codeOf(() => pending)).toBe('INTERNAL')
    expect(t.terminals.list()).toEqual([])
  })

  it('redimensionar durante un spawn pendiente se aplica al proceso al nacer', async () => {
    const t = await bootHarness()
    const pending = t.terminals.spawn({ paneId: t.paneId, cols: 80, rows: 24 })
    const terminalId = t.terminals.list()[0]?.terminalId as TerminalId
    t.terminals.resize({ terminalId, cols: 120, rows: 40 })
    await pending
    expect(t.pty.processes[0]?.size).toEqual({ cols: 120, rows: 40 })
  })

  it('dos spawn simultáneos sobre el mismo panel: uno gana, el otro CONFLICT', async () => {
    const t = await bootHarness()
    const results = await Promise.allSettled([
      t.terminals.spawn({ paneId: t.paneId, cols: 80, rows: 24 }),
      t.terminals.spawn({ paneId: t.paneId, cols: 80, rows: 24 }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(t.terminals.list()).toHaveLength(1)
    expect(t.pty.processes).toHaveLength(1)
  })

  it('exit antes de que se registre nada más: no hay doble exit ni salida tras terminar', async () => {
    const t = await bootHarness()
    const { proc } = await t.spawn()
    proc.exit({ exitCode: 0 })
    proc.emitData('tarde')
    t.clock.advance(100)
    expect(t.bus.ofType('terminal.exit')).toHaveLength(1)
    expect(t.bus.ofType('terminal.output')).toEqual([])
  })
})

describe('TerminalService (adversarial): límites e ids', () => {
  it('exceder el máximo de terminales con muchos paneles', async () => {
    const t = await bootHarness({ config: { maxTerminals: 3 } })
    let pane: PaneId = t.paneId
    const results: string[] = []
    for (let i = 0; i < 8; i++) {
      results.push(await codeOf(() => t.terminals.spawn({ paneId: pane, cols: 80, rows: 24 })))
      pane = t.workspaces.split({ paneId: pane, direction: 'row' }).pane.id
    }
    expect(results).toEqual([
      'OK',
      'OK',
      'OK',
      'CONFLICT',
      'CONFLICT',
      'CONFLICT',
      'CONFLICT',
      'CONFLICT',
    ])
    expect(t.terminals.list()).toHaveLength(3)
    expect(t.pty.processes).toHaveLength(3)
  })

  it('ráfaga de escrituras: pasa el máximo y el resto es RATE_LIMITED, nunca llega al PTY', async () => {
    const t = await bootHarness({ config: { writeRate: { maxWrites: 10, windowMs: 1000 } } })
    const { terminalId, proc } = await t.spawn()
    let limited = 0
    for (let i = 0; i < 1000; i++) {
      if ((await codeOf(() => t.terminals.write({ terminalId, data: 'x' }))) === 'RATE_LIMITED')
        limited++
    }
    expect(limited).toBe(990)
    expect(proc.written).toHaveLength(10)
  })

  it('una escritura enorme se rechaza antes de gastar cuota de frecuencia', async () => {
    const t = await bootHarness({ config: { writeRate: { maxWrites: 1, windowMs: 1000 } } })
    const { terminalId } = await t.spawn()
    expect(await codeOf(() => t.terminals.write({ terminalId, data: '€'.repeat(30000) }))).toBe(
      'PAYLOAD_TOO_LARGE',
    )
    expect(await codeOf(() => t.terminals.write({ terminalId, data: 'ok' }))).toBe('OK')
  })

  it('ids hostiles o inexistentes dan NOT_FOUND', async () => {
    const t = await bootHarness()
    for (const id of ['__proto__', 'constructor', 'toString', '', 'x'.repeat(10000)]) {
      const terminalId = id as TerminalId
      expect(await codeOf(() => t.terminals.read({ terminalId }))).toBe('NOT_FOUND')
      expect(await codeOf(() => t.terminals.write({ terminalId, data: 'x' }))).toBe('NOT_FOUND')
      expect(
        await codeOf(() => t.terminals.spawn({ paneId: id as PaneId, cols: 80, rows: 24 })),
      ).toBe('NOT_FOUND')
    }
  })

  it('lecturas con offsets y tamaños extremos no lanzan', async () => {
    const t = await bootHarness()
    const { terminalId, proc } = await t.spawn()
    proc.emitData('hola')
    for (const fromOffset of [0, 1, 4, 5, Number.MAX_SAFE_INTEGER]) {
      for (const maxBytes of [1, 3, 1024 * 1024]) {
        const r = t.terminals.read({ terminalId, fromOffset, maxBytes })
        expect(r.offset).toBeLessThanOrEqual(4)
      }
    }
  })

  it('un IdPort que repite el id de terminal produce CONFLICT, no corrupción', async () => {
    const base = new SequentialIds()
    const stuck: IdPort = {
      workspace: () => base.workspace(),
      tab: () => base.tab(),
      pane: () => base.pane(),
      terminal: () => 'siempre-igual' as TerminalId,
      agentSession: () => base.agentSession(),
      block: () => base.block(),
    }
    const t = await bootHarness({ ids: stuck })
    const second = t.workspaces.split({ paneId: t.paneId, direction: 'row' }).pane
    await t.spawn()
    expect(await codeOf(() => t.terminals.spawn({ paneId: second.id, cols: 80, rows: 24 }))).toBe(
      'CONFLICT',
    )
    expect(t.terminals.list()).toHaveLength(1)
    expect(t.layout.paneContext(second.id)?.pane.terminalId).toBeUndefined()
  })
})
