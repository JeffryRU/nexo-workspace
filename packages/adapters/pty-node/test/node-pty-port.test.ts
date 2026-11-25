import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PtyProcess } from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { NodePtyPort } from '../src/node-pty-port.ts'
import { collect, IS_WINDOWS, LIVE_SCRIPT, NODE, nodeArgs, waitFor } from './helpers.ts'

const port = new NodePtyPort()

// En Windows, Node no refresca `process.stdout.columns` tras un resize de ConPTY (sin evento); se
// consulta el handle del TTY directamente. En Linux se lee `process.stdout.columns/rows`, como pide el uso real.
const SIZE_PROBE = `let last = ''; setInterval(() => { let s; if (process.platform === 'win32') { const a = [0, 0]; process.stdout._handle.getWindowSize(a); s = a[0] + 'x' + a[1] } else { s = process.stdout.columns + 'x' + process.stdout.rows } if (s !== last) { last = s; console.log('size=' + s) } }, 20)`
const live: PtyProcess[] = []
const dirs: string[] = []

async function start(
  script: string,
  extra: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number } = {},
): Promise<PtyProcess> {
  const proc = await port.spawn({
    cmd: NODE,
    args: nodeArgs(script),
    cols: extra.cols ?? 80,
    rows: extra.rows ?? 24,
    ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
    ...(extra.env === undefined ? {} : { env: extra.env }),
  })
  live.push(proc)
  return proc
}

afterEach(() => {
  for (const p of live.splice(0)) p.kill('SIGKILL')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('NodePtyPort', () => {
  it('eco: lo escrito llega al hijo y vuelve por onData', async () => {
    const proc = await start(
      "process.stdin.setRawMode(true); process.stdin.on('data', d => process.stdout.write('eco:' + d.toString().trim() + ':fin\\n'))",
    )
    const c = collect(proc)
    proc.write('hola\r')
    await waitFor(() => c.output().includes('eco:hola:fin'))
  })

  it('reporta el código de salida', async () => {
    const proc = await start('process.exit(7)')
    expect(await collect(proc).exit).toEqual({ exitCode: 7, signal: null })
  })

  it('el código de salida 0 se reporta como 0', async () => {
    const proc = await start('console.log("ok")')
    expect(await collect(proc).exit).toEqual({ exitCode: 0, signal: null })
  })

  it('pasa variables de entorno (mezcladas con las del anfitrión)', async () => {
    const proc = await start(
      'console.log("v=" + process.env.NEXO_VAR + ";p=" + ((process.env.PATH ?? process.env.Path) ? "si" : "no"))',
      { env: { NEXO_VAR: 'valor ñ=1' } },
    )
    const c = collect(proc)
    await c.exit
    expect(c.output()).toContain('v=valor ñ=1;p=si')
  })

  it('respeta cwd', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexo-pty-')))
    dirs.push(dir)
    const proc = await start('console.log("cwd=" + process.cwd())', { cwd: dir })
    const c = collect(proc)
    await c.exit
    const printed = /cwd=(.*)/.exec(c.output())?.[1]?.trim() ?? ''
    expect(realpathSync.native(printed).toLowerCase()).toBe(dir.toLowerCase())
  })

  it('refleja las dimensiones iniciales y los resize en el hijo', async () => {
    const proc = await start(SIZE_PROBE, { cols: 90, rows: 20 })
    const c = collect(proc)
    await waitFor(() => c.output().includes('size=90x20'))
    proc.resize(120, 33)
    await waitFor(() => c.output().includes('size=120x33'))
  })

  it('kill termina el proceso; en Linux informa la señal, en Windows un código numérico', async () => {
    const proc = await start(LIVE_SCRIPT)
    const c = collect(proc)
    await waitFor(() => c.output().includes('listo'))
    proc.kill('SIGKILL')
    const exit = await c.exit
    if (IS_WINDOWS) {
      expect(exit.signal).toBeNull()
      expect(typeof exit.exitCode).toBe('number')
    } else {
      expect(exit).toEqual({ exitCode: null, signal: 'SIGKILL' })
    }
  })

  it('tras la salida no se entrega más salida y cancelar suscripciones es seguro', async () => {
    const proc = await start('console.log("fin")')
    let after = 0
    await collect(proc).exit
    const off = proc.onData(() => {
      after++
    })
    off()
    off()
    await new Promise((r) => setTimeout(r, 50))
    expect(after).toBe(0)
  })

  it('un onExit tardío cancelado antes de entregarse no se invoca', async () => {
    const proc = await start('process.exit(0)')
    await collect(proc).exit
    let calls = 0
    const off = proc.onExit(() => {
      calls++
    })
    off()
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(0)
  })

  it('cancelar onExit antes de la salida evita la llamada', async () => {
    const proc = await start(LIVE_SCRIPT)
    let calls = 0
    const off = proc.onExit(() => {
      calls++
    })
    off()
    const c = collect(proc)
    proc.kill()
    await c.exit
    expect(calls).toBe(0)
  })

  it('resuelve ejecutables por PATH (node sin ruta)', async () => {
    const proc = await new NodePtyPort().spawn({
      cmd: 'node',
      args: ['-e', 'console.log("via-path")'],
      cols: 80,
      rows: 24,
    })
    live.push(proc)
    const c = collect(proc)
    await c.exit
    expect(c.output()).toContain('via-path')
  })
})
