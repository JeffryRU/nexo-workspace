import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { type LoggerPort, type PtyExit, type PtyProcess, PtySpawnError } from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_CRASH_SIGNAL, PtyHostPort } from '../src/pty-host-port.ts'
import { collect, LIVE_SCRIPT, NODE, nodeArgs, waitFor } from './helpers.ts'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const HOST_ENTRY = fileURLToPath(new URL('../src/host.ts', import.meta.url))

const ports: PtyHostPort[] = []
afterEach(() => {
  for (const p of ports.splice(0)) p.dispose()
})

type Logged = { level: string; message: string }
function recordingLogger(): { logger: LoggerPort; lines: Logged[] } {
  const lines: Logged[] = []
  const at = (level: string) => (message: string) => {
    lines.push({ level, message })
  }
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  }
}

function newPort(options: ConstructorParameters<typeof PtyHostPort>[0] = {}): PtyHostPort {
  const port = new PtyHostPort(options)
  ports.push(port)
  return port
}

const spawnFake = (port: PtyHostPort): Promise<PtyProcess> =>
  port.spawn({ cmd: NODE, args: [], cols: 80, rows: 24 })

describe('pty-host adversarial: caída del host', () => {
  it('matar el host a mitad de la salida de varias terminales: todas reciben exit y el proceso sigue', async () => {
    const { logger, lines } = recordingLogger()
    const port = newPort({ logger, backoffBaseMs: 20 })
    const flood = "setInterval(() => console.log('y'.repeat(200)), 5)"
    const procs = await Promise.all(
      Array.from({ length: 5 }, () =>
        port.spawn({ cmd: NODE, args: nodeArgs(flood), cols: 80, rows: 24 }),
      ),
    )
    const cs = procs.map(collect)
    await waitFor(() => cs.every((c) => c.output().includes('yyyy')), 60000)
    const pid = port.hostPid as number
    process.kill(pid, 'SIGKILL')
    const exits = await Promise.all(cs.map((c) => c.exit))
    for (const e of exits) expect(e).toEqual({ exitCode: null, signal: HOST_CRASH_SIGNAL })
    expect(lines.some((l) => l.level === 'error')).toBe(true)

    const fresh = await port.spawn({
      cmd: NODE,
      args: nodeArgs("console.log('de nuevo'); process.exit(0)"),
      cols: 80,
      rows: 24,
    })
    const c = collect(fresh)
    await c.exit
    expect(c.output()).toContain('de nuevo')
    expect(port.hostPid).not.toBe(pid)
  }, 120000)

  it('un host que se cae en bucle: backoff, tope y error claro', async () => {
    const { logger, lines } = recordingLogger()
    const port = newPort({
      logger,
      entry: fixture('die-on-ready.mjs'),
      backoffBaseMs: 40,
      backoffMaxMs: 80,
      maxConsecutiveFailures: 3,
      cooldownMs: 600,
    })
    const messages: string[] = []
    const stamps: number[] = []
    for (let i = 0; i < 4; i++) {
      if (i === 0) stamps.push(Date.now())
      const error = await spawnFake(port).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(PtySpawnError)
      messages.push((error as Error).message)
      stamps.push(Date.now())
    }
    expect(messages.slice(0, 3).every((m) => m.includes('pty host'))).toBe(true)
    expect(messages[3]).toMatch(/se cayó 3 veces seguidas; no se reintenta/)
    // El backoff espacia los intentos: hasta terminar el 3.º intento pasan al menos 40 + 80 ms desde antes del
    // 1.º. Se mide al terminar el 3.º (el 2.º espera 40 ms; el 3.º, 80), no al empezarlo: antes solo se
    // medía el primer retardo y el margen salía del tiempo de arranque del proceso. Date.now() tiene
    // resolución de 1 ms y el temporizador puede disparar ~1 ms antes, de ahí los 4 ms de tolerancia.
    expect((stamps[3] ?? 0) - (stamps[0] ?? 0)).toBeGreaterThanOrEqual(120 - 4)
    expect(lines.filter((l) => l.level === 'error').length).toBeGreaterThanOrEqual(3)
    expect(port.consecutiveHostFailures).toBe(3)

    // Tras el enfriamiento se permite un intento nuevo (que vuelve a fallar, pero ya no por el circuito).
    await new Promise((r) => setTimeout(r, 700))
    const again = await spawnFake(port).catch((e: unknown) => e)
    expect((again as Error).message).not.toMatch(/no se reintenta/)
  })

  it('un host que muere antes de anunciarse falla el spawn con SPAWN_FAILED', async () => {
    const port = newPort({ entry: fixture('die-before-ready.mjs'), backoffBaseMs: 10 })
    const error = (await spawnFake(port).catch((e: unknown) => e)) as PtySpawnError
    expect(error).toBeInstanceOf(PtySpawnError)
    expect(error.code).toBe('SPAWN_FAILED')
    expect(error.message).toContain('terminó al arrancar')
  })
})

describe('pty-host adversarial: mensajes hostiles del host', () => {
  it('descarta mensajes malformados, enormes o de ids ajenos sin tumbar al adaptador', async () => {
    const { logger, lines } = recordingLogger()
    const port = newPort({ logger, entry: fixture('garbage-host.mjs') })
    const proc = await spawnFake(port)
    const c = collect(proc)
    const exit = await c.exit
    expect(exit).toEqual({ exitCode: 0, signal: null })
    expect(c.output()).toBe('valido')
    expect(lines.filter((l) => l.level === 'warn').length).toBeGreaterThanOrEqual(6)
    expect(port.hostRunning).toBe(true)
  })

  it('un host que inunda de basura se mata y su terminal recibe HOST_CRASH', async () => {
    const port = newPort({ entry: fixture('flood-host.mjs'), maxInvalidMessages: 10 })
    const proc = await spawnFake(port)
    const exit = await new Promise<PtyExit>((resolve) => proc.onExit(resolve))
    expect(exit.signal).toBe(HOST_CRASH_SIGNAL)
  })
})

describe('pty-host adversarial: mensajes hostiles hacia el host', () => {
  it('el host descarta mensajes inválidos, sigue vivo y atiende un spawn válido', async () => {
    const child = fork(HOST_ENTRY, [], { stdio: ['ignore', 'inherit', 'ignore', 'ipc'] })
    const received: Array<{ t: string; id?: number }> = []
    child.on('message', (m) => received.push(m as { t: string; id?: number }))
    try {
      await waitFor(() => received.some((m) => m.t === 'ready'))
      child.send({ t: 'spawn', id: -1 })
      child.send('basura')
      child.send({ t: 'write', id: 1, data: 'x'.repeat(10 * 1024 * 1024) })
      child.send({ t: 'kill', id: 123456 })
      child.send({ t: 'resize', id: 5, cols: 0, rows: 0 })
      child.send({
        t: 'spawn',
        id: 7,
        file: NODE,
        args: nodeArgs(LIVE_SCRIPT),
        cwd: process.cwd(),
        env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        conptyDll: process.platform === 'win32',
      })
      await waitFor(() => received.some((m) => m.t === 'spawned' && m.id === 7), 60000)
      expect(child.connected).toBe(true)
      expect(received.some((m) => m.t === 'spawned' && m.id === -1)).toBe(false)
      child.send({ t: 'kill', id: 7 })
      await waitFor(() => received.some((m) => m.t === 'exit' && m.id === 7), 60000)
    } finally {
      child.kill('SIGKILL')
    }
  }, 120000)

  it('el host termina si el daemon cierra el canal', async () => {
    const child = fork(HOST_ENTRY, [], { stdio: ['ignore', 'inherit', 'ignore', 'ipc'] })
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    )
    await new Promise((resolve) => child.once('message', resolve))
    child.disconnect()
    expect(await exited).toBe(0)
  })
})

describe('pty-host adversarial: carga', () => {
  it('50 terminales que salen a la vez', async () => {
    const port = newPort()
    const procs = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        port.spawn({
          cmd: NODE,
          args: nodeArgs(`console.log('t${i}'); process.exit(${i % 5})`),
          cols: 80,
          rows: 24,
        }),
      ),
    )
    const cs = procs.map(collect)
    const exits = await Promise.all(cs.map((c) => c.exit))
    for (const [i, e] of exits.entries()) expect(e).toEqual({ exitCode: i % 5, signal: null })
    expect(port.hostRunning).toBe(true)
  }, 240000)

  it('50 terminales matadas a la vez', async () => {
    const port = newPort()
    const procs = await Promise.all(
      Array.from({ length: 50 }, () =>
        port.spawn({ cmd: NODE, args: nodeArgs(LIVE_SCRIPT), cols: 80, rows: 24 }),
      ),
    )
    const cs = procs.map(collect)
    for (const p of procs) p.kill()
    await Promise.all(cs.map((c) => c.exit))
    expect(port.hostRunning).toBe(true)
  }, 240000)
})
