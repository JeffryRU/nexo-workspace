import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { type ClientOptions } from 'ws'
import { type DaemonOptions, type RunningDaemon, startDaemon } from './daemon.ts'

export type TestDaemon = RunningDaemon & {
  logs: string[]
  stateDir: string
  cleanup(): Promise<void>
}

/** Daemon real en puerto efímero con un directorio de estado temporal. */
export async function startTestDaemon(options: DaemonOptions = {}): Promise<TestDaemon> {
  const stateDir = options.stateDir ?? (await mkdtemp(join(tmpdir(), 'nexo-test-')))
  const logs: string[] = []
  const daemon = await startDaemon({
    port: 0,
    webRoot: null,
    logLevel: 'debug',
    logSink: (line) => logs.push(line),
    ...options,
    stateDir,
  })
  return {
    ...daemon,
    logs,
    stateDir,
    async cleanup() {
      await daemon.stop()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}

type Waiter = {
  match: (msg: Record<string, unknown>) => boolean
  resolve: (m: Record<string, unknown>) => void
}

export class TestClient {
  readonly ws: WebSocket
  readonly messages: Record<string, unknown>[] = []
  closed: { code: number; reason: string } | undefined
  readonly #waiters: Waiter[] = []
  #n = 0

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>
      this.messages.push(msg)
      for (const w of [...this.#waiters]) {
        if (w.match(msg)) {
          this.#waiters.splice(this.#waiters.indexOf(w), 1)
          w.resolve(msg)
        }
      }
    })
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString('utf8') }
    })
    ws.on('error', () => {})
  }

  waitMessage(
    match: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    const existing = this.messages.find(match)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('tiempo agotado esperando mensaje')),
        timeoutMs,
      )
      this.#waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  waitEvent(
    name: string,
    match: (data: Record<string, unknown>) => boolean = () => true,
    timeoutMs?: number,
  ) {
    return this.waitMessage(
      (m) => m.event === name && match((m.data ?? {}) as Record<string, unknown>),
      timeoutMs,
    )
  }

  /** Envía una petición y espera su respuesta (`ok` o error). */
  async request(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const id = `r${++this.#n}`
    this.ws.send(JSON.stringify({ v: 1, id, method, params }))
    return this.waitMessage((m) => m.id === id)
  }

  /** Como `request`, pero exige éxito y devuelve `result`. */
  async call<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    const res = await this.request(method, params)
    if (res.ok !== true) throw new Error(`${method} falló: ${JSON.stringify(res.error)}`)
    return res.result as T
  }

  waitClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    if (this.closed !== undefined) return Promise.resolve(this.closed)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('la conexión no se cerró')), timeoutMs)
      this.ws.once('close', (code, reason) => {
        clearTimeout(timer)
        resolve({ code, reason: reason.toString('utf8') })
      })
    })
  }

  close(): void {
    this.ws.terminate()
  }
}

export type ConnectOptions = {
  protocols?: string[]
  headers?: Record<string, string>
  /** Si se da, se envía `auth` con este token tras abrir. */
  auth?: string
  clientOptions?: ClientOptions
}

/** Abre un WebSocket y espera `open`; rechaza con el estado HTTP si el upgrade falla. */
export function openSocket(port: number, options: ConnectOptions = {}): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, options.protocols ?? ['nexo.v1'], {
      headers: options.headers ?? {},
      ...options.clientOptions,
    })
    ws.once('open', () => resolve(new TestClient(ws)))
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }))
    })
    ws.once('error', (error) => reject(error))
  })
}

export async function connectAuthed(daemon: { port: number; token: string }): Promise<TestClient> {
  const client = await openSocket(daemon.port, {
    protocols: ['nexo.v1', `nexo.token.${daemon.token}`],
  })
  return client
}

/** Resuelve el estado HTTP del upgrade (o `0` si se abrió). */
export async function upgradeStatus(port: number, options: ConnectOptions = {}): Promise<number> {
  try {
    const c = await openSocket(port, options)
    c.close()
    return 0
  } catch (error) {
    return (error as { status?: number }).status ?? -1
  }
}
