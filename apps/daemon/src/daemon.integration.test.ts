import { readFile, stat } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonAlreadyRunningError, startDaemon } from './daemon.ts'
import { isPidAlive } from './state-dir.ts'
import {
  connectAuthed,
  openSocket,
  startTestDaemon,
  type TestClient,
  type TestDaemon,
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

async function client(d: TestDaemon): Promise<TestClient> {
  const c = await connectAuthed(d)
  cleanups.push(() => c.close())
  return c
}

async function waitDead(pid: number, timeoutMs = 10000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (!isPidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

describe('daemon real', () => {
  it('flujo completo: espacio, pestaña, terminal real, salida, lectura y cierre que mata el proceso', async () => {
    const d = await boot()
    const c = await client(d)
    await c.call('events.subscribe', {})

    const { workspace } = await c.call<{ workspace: { id: string } }>('workspace.create', {
      name: 'prueba',
    })
    const { tab } = await c.call<{ tab: { panes: { id: string }[] } }>('tab.create', {
      workspaceId: workspace.id,
    })
    const paneId = tab.panes[0]?.id as string
    const { terminalId } = await c.call<{ terminalId: string }>('terminal.spawn', {
      paneId,
      cmd: process.execPath,
      args: [
        '-e',
        'console.log("PID:"+process.pid); process.stdin.on("data",d=>process.stdout.write("eco:"+d)); setInterval(()=>{},1000)',
      ],
      cols: 80,
      rows: 24,
    })

    const first = await c.waitEvent('terminal.output', (data) => String(data.data).includes('PID:'))
    const pid = Number(/PID:(\d+)/.exec(String((first.data as { data: string }).data))?.[1])
    expect(Number.isInteger(pid)).toBe(true)
    expect(isPidAlive(pid)).toBe(true)

    await c.call('terminal.write', { terminalId, data: 'hola\r' })
    await c.waitEvent('terminal.output', (data) => String(data.data).includes('eco:'))
    const read = await c.call<{ data: string; offset: number }>('terminal.read', { terminalId })
    expect(read.data).toContain('PID:')
    expect(read.offset).toBeGreaterThan(0)

    await c.call('pane.close', { paneId })
    expect(await waitDead(pid)).toBe(true)
  })

  it('con el pty host, un crash nativo (host muerto) no tumba al daemon: la terminal sale con HOST_CRASH y las nuevas funcionan', async () => {
    const d = await boot({ ptyMode: 'host' })
    const c = await client(d)
    await c.call('events.subscribe', {})
    const { workspace } = await c.call<{ workspace: { id: string } }>('workspace.create', {
      name: 'crash',
    })
    const { tab } = await c.call<{ tab: { panes: { id: string }[] } }>('tab.create', {
      workspaceId: workspace.id,
    })
    const spawn = async (script: string) => {
      const { tab: t2 } = await c.call<{ tab: { panes: { id: string }[] } }>('tab.create', {
        workspaceId: workspace.id,
      })
      return c.call<{ terminalId: string }>('terminal.spawn', {
        paneId: t2.panes[0]?.id as string,
        cmd: process.execPath,
        args: ['-e', script],
        cols: 80,
        rows: 24,
      })
    }
    void tab
    const live = 'console.log("vivo"); setInterval(()=>{},1000)'
    const victim = await spawn(live)
    await c.waitEvent('terminal.output', (data) => String(data.data).includes('vivo'))
    const hostPid = d.ptyHostPid()
    expect(hostPid).toBeDefined()
    process.kill(hostPid as number, 'SIGKILL')
    const exit = await c.waitEvent('terminal.exit', (data) => data.terminalId === victim.terminalId)
    expect((exit.data as { signal: string }).signal).toBe('HOST_CRASH')
    const next = await spawn('console.log("renacida"); setInterval(()=>{},1000)')
    await c.waitEvent('terminal.output', (data) => String(data.data).includes('renacida'))
    expect(next.terminalId).not.toBe(victim.terminalId)
    expect(d.ptyHostPid()).not.toBe(hostPid)
  })

  it('emite workspace.changed al renombrar y con seq creciente de uno en uno', async () => {
    const d = await boot()
    const c = await client(d)
    const sub = await c.call<{ seq: number }>('events.subscribe', {})
    const { workspace } = await c.call<{ workspace: { id: string } }>('workspace.create', {
      name: 'a',
    })
    await c.call('workspace.rename', { workspaceId: workspace.id, name: 'b' })
    await c.call('workspace.close', { workspaceId: workspace.id })
    await c.waitEvent('workspace.changed', (data) => data.removed === true)
    const seqs = c.messages.filter((m) => m.event !== undefined).map((m) => m.seq as number)
    expect(seqs[0]).toBe(sub.seq + 1)
    seqs.forEach((s, i) => {
      if (i > 0) expect(s).toBe((seqs[i - 1] as number) + 1)
    })
    const names = c.messages
      .filter((m) => m.event === 'workspace.changed')
      .map((m) => (m.data as { workspace?: { name: string } }).workspace?.name)
    expect(names).toContain('b')
  })

  it('snapshot devuelve el seq actual de la conexión', async () => {
    const d = await boot()
    const c = await client(d)
    await c.call('events.subscribe', {})
    await c.call('workspace.create', { name: 'x' })
    const snap = await c.call<{ seq: number; workspaces: unknown[] }>('snapshot')
    expect(snap.workspaces).toHaveLength(1)
    expect(snap.seq).toBe(1)
  })

  it('autentica por primer mensaje auth', async () => {
    const d = await boot()
    const c = await openSocket(d.port)
    cleanups.push(() => c.close())
    const res = await c.request('auth', { token: d.token })
    expect(res.ok).toBe(true)
    expect((await c.call<{ pid: number }>('daemon.info')).pid).toBe(process.pid)
  })

  it('daemon.shutdown responde y luego detiene el daemon y borra el descubrimiento', async () => {
    const stops: number[] = []
    const d = await boot({ onShutdownRequested: (stop) => void stop().then(() => stops.push(1)) })
    const c = await client(d)
    expect(await c.call('daemon.shutdown')).toEqual({})
    const end = Date.now() + 5000
    while (stops.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
    expect(stops).toEqual([1])
    await expect(stat(d.paths.daemon)).rejects.toThrow()
  })

  it('daemon.shutdown por omisión detiene el daemon', async () => {
    const d = await boot()
    const c = await client(d)
    await c.call('daemon.shutdown')
    const end = Date.now() + 5000
    while (d.logs.every((l) => !l.includes('daemon detenido')) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(d.logs.some((l) => l.includes('daemon detenido'))).toBe(true)
  })

  it('GET /health sin token devuelve solo ok y versión', async () => {
    const d = await boot()
    const res = await fetch(`http://127.0.0.1:${d.port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: '0.0.0' })
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('escribe token y daemon.json, y los borra al detenerse', async () => {
    const d = await boot()
    const token = await readFile(d.paths.token, 'utf8')
    expect(token).toBe(d.token)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    const info = JSON.parse(await readFile(d.paths.daemon, 'utf8')) as Record<string, unknown>
    expect(info).toMatchObject({ port: d.port, pid: process.pid, version: '0.0.0' })
    if (process.platform !== 'win32') {
      expect((await stat(d.paths.token)).mode & 0o777).toBe(0o600)
      expect((await stat(d.paths.dir)).mode & 0o777).toBe(0o700)
    }
    await d.stop()
    await expect(stat(d.paths.daemon)).rejects.toThrow()
    await expect(stat(d.paths.token)).rejects.toThrow()
  })

  it('stop mata las terminales vivas y cierra las conexiones', async () => {
    const d = await boot()
    const c = await client(d)
    const { workspace } = await c.call<{ workspace: { id: string } }>('workspace.create', {
      name: 'a',
    })
    const { tab } = await c.call<{ tab: { panes: { id: string }[] } }>('tab.create', {
      workspaceId: workspace.id,
    })
    const paneId = tab.panes[0]?.id as string
    await c.call('events.subscribe', {})
    await c.call('terminal.spawn', {
      paneId,
      cmd: process.execPath,
      args: ['-e', 'console.log("PID:"+process.pid); setInterval(()=>{},1000)'],
      cols: 80,
      rows: 24,
    })
    const first = await c.waitEvent('terminal.output', (data) => String(data.data).includes('PID:'))
    const pid = Number(/PID:(\d+)/.exec(String((first.data as { data: string }).data))?.[1])
    await d.stop()
    expect(await waitDead(pid)).toBe(true)
    await c.waitClose()
  })

  it('un segundo daemon sobre el mismo directorio de estado dice que ya está corriendo', async () => {
    const d = await boot()
    await expect(startDaemon({ port: 0, stateDir: d.stateDir, webRoot: null })).rejects.toThrow(
      DaemonAlreadyRunningError,
    )
    // El primero sigue sano.
    expect((await fetch(`http://127.0.0.1:${d.port}/health`)).status).toBe(200)
  })
})
