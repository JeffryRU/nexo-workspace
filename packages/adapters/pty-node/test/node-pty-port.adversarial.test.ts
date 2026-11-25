import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PtyProcess, PtySpawnError, type PtySpawnOptions } from '@nexo/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodePtyPort } from '../src/node-pty-port.ts'
import { collect, IS_WINDOWS, LIVE_SCRIPT, NODE, nodeArgs, waitFor } from './helpers.ts'

const port = new NodePtyPort()
const live: PtyProcess[] = []
const dirs: string[] = []

async function start(script: string, extra: Partial<PtySpawnOptions> = {}): Promise<PtyProcess> {
  const proc = await port.spawn({ cmd: NODE, args: nodeArgs(script), cols: 80, rows: 24, ...extra })
  live.push(proc)
  return proc
}

async function rejection(options: PtySpawnOptions): Promise<PtySpawnError> {
  const error = await port.spawn(options).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PtySpawnError)
  return error as PtySpawnError
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const p of live.splice(0)) p.kill('SIGKILL')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('NodePtyPort adversarial: spawn', () => {
  const base = { args: [], cols: 80, rows: 24 }

  it('ejecutable inexistente: EXECUTABLE_NOT_FOUND, sin crash', async () => {
    const error = await rejection({ ...base, cmd: 'nexo-no-existe-xyz' })
    expect(error.code).toBe('EXECUTABLE_NOT_FOUND')
    const abs = await rejection({ ...base, cmd: join(tmpdir(), 'nexo-no-existe-xyz', 'bin') })
    expect(abs.code).toBe('EXECUTABLE_NOT_FOUND')
  })

  it('un directorio no es un ejecutable', async () => {
    const error = await rejection({ ...base, cmd: tmpdir() })
    expect(error.code).toBe('EXECUTABLE_NOT_FOUND')
  })

  it('cwd inexistente o que es un archivo: CWD_NOT_FOUND', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexo-adv-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'archivo'), 'x')
    for (const cwd of [join(dir, 'no', 'existe'), join(dir, 'archivo')]) {
      const error = await rejection({ ...base, cmd: NODE, cwd })
      expect(error.code).toBe('CWD_NOT_FOUND')
    }
  })

  it('opciones malformadas: INVALID_OPTIONS', async () => {
    const bad: PtySpawnOptions[] = [
      { ...base, cmd: '' },
      { ...base, cmd: `${NODE}\u0000x` },
      { ...base, cmd: NODE, args: ['a\u0000b'] },
      { ...base, cmd: NODE, args: 'cadena de shell' as unknown as string[] },
      { ...base, cmd: NODE, cols: Number.NaN },
      { ...base, cmd: NODE, rows: -5 },
      { ...base, cmd: NODE, cols: 1e9 },
      { ...base, cmd: NODE, rows: 0.5 },
      { ...base, cmd: undefined as unknown as string },
    ]
    for (const options of bad) expect((await rejection(options)).code).toBe('INVALID_OPTIONS')
  })

  it('args hostiles (comillas, espacios, metacaracteres de shell) llegan intactos al hijo', async () => {
    const hostile = ['a b', '"q"', "it's", '$(echo pwn)', '; rm -rf /', '&& dir', '%PATH%', 'ñ€']
    const real = await port.spawn({
      cmd: NODE,
      args: [
        '-e',
        'console.log("ARGS=" + JSON.stringify(process.argv.slice(1)))',
        '--',
        ...hostile,
      ],
      cols: 500,
      rows: 24,
    })
    live.push(real)
    const c = collect(real)
    await c.exit
    const json = /ARGS=(\[.*\])\r?\n/.exec(c.output())?.[1] ?? ''
    expect(JSON.parse(json)).toEqual(hostile)
  })
})

describe('NodePtyPort adversarial: ciclo de vida', () => {
  it('kill a mitad de una salida enorme termina y no entrega más datos después', async () => {
    const proc = await start(
      "const chunk = 'x'.repeat(65536); (function loop() { while (process.stdout.write(chunk)) {} process.stdout.once('drain', loop) })()",
    )
    const c = collect(proc)
    await waitFor(() => c.output().length > 100_000)
    proc.kill('SIGKILL')
    await c.exit
    const sizeAtExit = c.output().length
    await new Promise((r) => setTimeout(r, 100))
    expect(c.output().length).toBe(sizeAtExit)
  })

  it('kill doble y kill después de la salida son seguros; onExit se dispara una vez', async () => {
    const proc = await start(LIVE_SCRIPT)
    let exits = 0
    proc.onExit(() => {
      exits++
    })
    const c = collect(proc)
    await waitFor(() => c.output().includes('listo'))
    proc.kill()
    proc.kill()
    proc.kill('SIGKILL')
    await c.exit
    expect(() => proc.kill()).not.toThrow()
    expect(() => proc.kill('SIGHUP')).not.toThrow()
    await new Promise((r) => setTimeout(r, 100))
    expect(exits).toBe(1)
  })

  it('escribir y redimensionar después de que salió no lanza', async () => {
    const proc = await start('process.exit(3)')
    expect(await collect(proc).exit).toEqual({ exitCode: 3, signal: null })
    for (let i = 0; i < 50; i++) {
      expect(() => proc.write(`dato ${i}\r`)).not.toThrow()
      expect(() => proc.resize(100 + i, 30)).not.toThrow()
    }
    expect(() => proc.resize(0, 0)).toThrow(RangeError)
  })

  it('resize en ráfaga (1000 veces) deja el proceso vivo y con el último tamaño', async () => {
    const proc = await start(
      "let last = ''; setInterval(() => { let s; if (process.platform === 'win32') { const a = [0, 0]; process.stdout._handle.getWindowSize(a); s = a[0] + 'x' + a[1] } else { s = process.stdout.columns + 'x' + process.stdout.rows } if (s !== last) { last = s; console.log('size=' + s) } }, 20)",
    )
    const c = collect(proc)
    await waitFor(() => c.output().includes('size=80x24'))
    for (let i = 0; i < 1000; i++) proc.resize(20 + (i % 200), 10 + (i % 90))
    proc.resize(133, 41)
    await waitFor(() => c.output().includes('size=133x41'))
  })

  it('resize con 0, negativos, NaN, Infinity y enormes lanza RangeError y no altera el estado', async () => {
    const proc = await start(LIVE_SCRIPT)
    const values = [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1001,
      1e9,
      2 ** 53,
      0.5,
    ]
    for (const v of values) {
      expect(() => proc.resize(v, 24)).toThrow(RangeError)
      expect(() => proc.resize(80, v)).toThrow(RangeError)
    }
    expect(() => proc.resize(1, 1)).not.toThrow()
    expect(() => proc.resize(1000, 1000)).not.toThrow()
  })

  it('datos binarios, UTF-8 partido entre escrituras y bytes inválidos', async () => {
    const proc = await start(
      "const w = (b) => process.stdout.write(Buffer.from(b)); w([0xe2, 0x82]); setTimeout(() => { w([0xac]); w([0xff, 0xfe, 0x00, 0x01]); w([0xf0, 0x9f, 0x98]); setTimeout(() => { w([0x80]); console.log('FIN') }, 50) }, 50)",
    )
    const c = collect(proc)
    await c.exit
    const out = c.output()
    expect(out).toContain('€')
    expect(out).toContain('😀')
    expect(out).toContain('FIN')
    // Ningún fragmento partido del euro (U+FFFD justo antes de «€») debe aparecer.
    expect(out).not.toContain('�€')
  })

  // ConPTY procesa la entrada a ~25 KiB/s (1 MiB tarda ~40 s), así que en Windows se comprueba que la
  // escritura no bloquea ni lanza, que el progreso avanza y que kill responde con la cola pendiente.
  it('entrada de 1 MiB: llega completa (Linux) o avanza sin bloquear y se puede matar (Windows)', async () => {
    const size = 1024 * 1024
    const proc = await start(
      `let n = 0, p = 0; process.stdin.setRawMode(true); process.stdin.on('data', d => { n += d.length; if (n >= ${size}) { console.log('TOTAL=' + n); setTimeout(() => process.exit(0), 50) } else if (n >= 65536 && !p) { p = 1; console.log('PROGRESO=' + n) } })`,
    )
    const c = collect(proc)
    await new Promise((r) => setTimeout(r, 300))
    const started = Date.now()
    expect(() => proc.write('a'.repeat(size))).not.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
    if (IS_WINDOWS) {
      await waitFor(() => c.output().includes('PROGRESO=') || c.output().includes('TOTAL='), 20000)
      proc.kill()
    } else {
      await waitFor(() => c.output().includes(`TOTAL=${size}`), 25000)
    }
    await c.exit
  })

  it('20 PTYs que salen a la vez: todos reportan salida, sin fugas de listeners ni zombis', async () => {
    const before = {
      exit: process.listenerCount('exit'),
      sigchld: process.listenerCount('SIGCHLD'),
      uncaught: process.listenerCount('uncaughtException'),
    }
    const at = Date.now() + 3000
    const procs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        start(
          `console.log('hijo-${i}'); setTimeout(() => process.exit(${i % 5}), Math.max(0, ${at} - Date.now()))`,
        ),
      ),
    )
    const results = procs.map((p) => collect(p))
    const exits = await Promise.all(results.map((r) => r.exit))
    exits.forEach((e, i) => {
      expect(e).toEqual({ exitCode: i % 5, signal: null })
    })
    results.forEach((r, i) => {
      expect(r.output()).toContain(`hijo-${i}`)
    })
    await waitFor(() => procs.every((p) => !isAlive(p.pid)), 10000)
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(before.exit)
    expect(process.listenerCount('SIGCHLD')).toBe(before.sigchld)
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught)
  })

  it('20 PTYs terminados con kill a la vez no dejan procesos vivos', async () => {
    const procs = await Promise.all(Array.from({ length: 20 }, () => start(LIVE_SCRIPT)))
    const results = procs.map((p) => collect(p))
    await waitFor(() => results.every((r) => r.output().includes('listo')), 20000)
    for (const p of procs) p.kill('SIGKILL')
    await Promise.all(results.map((r) => r.exit))
    await waitFor(() => procs.every((p) => !isAlive(p.pid)), 10000)
  })

  it('onExit registrado antes de la salida recibe una única notificación', async () => {
    const proc = await start('console.log("x")')
    const exits: number[] = []
    proc.onExit(() => exits.push(1))
    const c = collect(proc)
    await c.exit
    expect(exits).toEqual([1])
  })

  it.skipIf(!IS_WINDOWS)(
    'Windows: kill con señal se ignora y el código de salida es numérico',
    async () => {
      const proc = await start(LIVE_SCRIPT)
      const c = collect(proc)
      await waitFor(() => c.output().includes('listo'))
      proc.kill('SIGINT')
      const exit = await c.exit
      expect(exit.signal).toBeNull()
      expect(typeof exit.exitCode).toBe('number')
    },
  )
})

describe('escritura en ráfaga al salir', () => {
  it('no deja errores no manejados ni ruido en stderr', async () => {
    const errors: unknown[] = []
    const onRejection = (e: unknown) => errors.push(e)
    const onException = (e: unknown) => errors.push(e)
    process.on('unhandledRejection', onRejection)
    process.on('uncaughtException', onException)
    // Deja pasar el margen del filtro de otras pruebas para que el espía quede bajo el filtro, no sobre él.
    await new Promise((r) => setTimeout(r, 600))
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let round = 0; round < 15; round++) {
        const proc = await start(LIVE_SCRIPT)
        const exited = collect(proc).exit
        proc.write('x'.repeat(65536))
        proc.kill('SIGKILL')
        for (let i = 0; i < 100; i++) proc.write('y'.repeat(4096))
        await exited
        for (let i = 0; i < 20; i++) proc.write('z')
      }
      await new Promise((r) => setTimeout(r, 200))
      expect(stderr).not.toHaveBeenCalled()
      expect(errors).toEqual([])
    } finally {
      stderr.mockRestore()
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    }
  })
})
