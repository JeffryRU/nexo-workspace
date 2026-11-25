import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PtyProcess, PtySpawnError } from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_CRASH_SIGNAL, PtyHostPort } from '../src/pty-host-port.ts'
import { collect, IS_WINDOWS, LIVE_SCRIPT, NODE, nodeArgs, waitFor } from './helpers.ts'

const ports: PtyHostPort[] = []
const dirs: string[] = []

function newPort(options: ConstructorParameters<typeof PtyHostPort>[0] = {}): PtyHostPort {
  const port = new PtyHostPort(options)
  ports.push(port)
  return port
}

afterEach(() => {
  for (const p of ports.splice(0)) p.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function start(port: PtyHostPort, script: string, extra = {}): Promise<PtyProcess> {
  return port.spawn({ cmd: NODE, args: nodeArgs(script), cols: 80, rows: 24, ...extra })
}

describe('PtyHostPort', () => {
  it('lanza la terminal en un proceso distinto del actual', async () => {
    const port = newPort()
    const proc = await start(port, LIVE_SCRIPT)
    expect(port.hostPid).toBeDefined()
    expect(port.hostPid).not.toBe(process.pid)
    expect(proc.pid).not.toBe(process.pid)
    proc.kill()
  })

  it('entrega salida y código de salida', async () => {
    const port = newPort()
    const proc = await start(port, "console.log('hola mundo'); process.exit(7)")
    const c = collect(proc)
    expect(await c.exit).toEqual({ exitCode: 7, signal: null })
    expect(c.output()).toContain('hola mundo')
  })

  it('pasa cwd y env al proceso', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nexo-host-')))
    dirs.push(dir)
    const port = newPort()
    const proc = await start(
      port,
      "console.log('cwd=' + process.cwd() + ' v=' + process.env.NEXO_PRUEBA); process.exit(0)",
      { cwd: dir, env: { NEXO_PRUEBA: 'valor' } },
    )
    const c = collect(proc)
    await c.exit
    expect(c.output()).toContain(`cwd=${dir}`)
    expect(c.output()).toContain('v=valor')
  })

  it('la entrada llega al proceso (eco)', async () => {
    const port = newPort()
    const proc = await start(
      port,
      "process.stdin.on('data', (d) => process.stdout.write('eco:' + d.toString().trim() + '\\n')); console.log('listo')",
    )
    const c = collect(proc)
    await waitFor(() => c.output().includes('listo'))
    proc.write('ping\r')
    await waitFor(() => c.output().includes('eco:ping'))
    proc.kill()
  })

  it.skipIf(IS_WINDOWS)(
    'una muerte por señal da exitCode null y el nombre de la señal',
    async () => {
      const port = newPort()
      const proc = await start(port, LIVE_SCRIPT)
      const c = collect(proc)
      await waitFor(() => c.output().includes('listo'))
      proc.kill('SIGKILL')
      expect(await c.exit).toEqual({ exitCode: null, signal: 'SIGKILL' })
    },
  )

  it('traduce los errores de lanzamiento a PtySpawnError sin arrancar el host', async () => {
    const port = newPort()
    const error = await port
      .spawn({ cmd: 'nexo-no-existe-xyz', args: [], cols: 80, rows: 24 })
      .catch((e) => e)
    expect(error).toBeInstanceOf(PtySpawnError)
    expect(error.code).toBe('EXECUTABLE_NOT_FOUND')
    expect(port.hostRunning).toBe(false)
  })

  it('tras un crash del host, la terminal recibe HOST_CRASH y las nuevas funcionan', async () => {
    const port = newPort({ backoffBaseMs: 20 })
    const victim = await start(port, LIVE_SCRIPT)
    const c = collect(victim)
    await waitFor(() => c.output().includes('listo'))
    const pid = port.hostPid
    expect(pid).toBeDefined()
    process.kill(pid as number, 'SIGKILL')
    expect(await c.exit).toEqual({ exitCode: null, signal: HOST_CRASH_SIGNAL })
    expect(() => victim.write('x')).not.toThrow()
    const fresh = await start(port, "console.log('nueva'); process.exit(0)")
    const c2 = collect(fresh)
    await c2.exit
    expect(c2.output()).toContain('nueva')
    expect(port.hostPid).not.toBe(pid)
  })

  it('dispose mata el host y rechaza lanzamientos posteriores', async () => {
    const port = newPort()
    const proc = await start(port, LIVE_SCRIPT)
    const c = collect(proc)
    port.dispose()
    await c.exit
    const error = await start(port, LIVE_SCRIPT).catch((e) => e)
    expect(error).toBeInstanceOf(PtySpawnError)
  })
})
