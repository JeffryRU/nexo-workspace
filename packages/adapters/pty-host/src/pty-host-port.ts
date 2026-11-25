import { constants } from 'node:os'
import process from 'node:process'
import {
  type LoggerPort,
  type PtyExit,
  type PtyPort,
  type PtyProcess,
  PtySpawnError,
  type PtySpawnOptions,
  type Unsubscribe,
} from '@nexo/core'
import {
  type HostEvent,
  type HostRequest,
  MAX_SPAWN_ENV_BYTES,
  MAX_TERMINAL_ID,
  MAX_WRITE_CHARS,
} from './protocol.ts'
import { isDirectory, mergeEnv, readEnv, resolveExecutable } from './resolve.ts'
import {
  type HostDownInfo,
  type HostHandle,
  HostSupervisor,
  type SupervisorOptions,
} from './supervisor.ts'

const MIN_SIZE = 1
const MAX_SIZE = 1000
/** Salida recibida antes de que nadie se suscriba (el IPC puede entregar `data` justo tras `spawned`). */
const MAX_PREBUFFER_CHARS = 1024 * 1024
const SPAWN_REPLY_TIMEOUT_MS = 60000

/** `PtyExit.signal` cuando el proceso host murió y arrastró la terminal. */
export const HOST_CRASH_SIGNAL = 'HOST_CRASH'

type KillSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'

const isValidSize = (n: number): boolean => Number.isInteger(n) && n >= MIN_SIZE && n <= MAX_SIZE

const signalNames = new Map<number, string>(
  Object.entries(constants.signals).map(([name, value]) => [value, name]),
)

export function toExit(raw: { exitCode: number | null; signal: number | null }): PtyExit {
  const signal =
    raw.signal === null || raw.signal === 0
      ? null
      : (signalNames.get(raw.signal) ?? `SIG${raw.signal}`)
  // En Unix, una muerte por señal llega como exitCode 0 + signal; se normaliza a exitCode null.
  return { exitCode: signal === null ? raw.exitCode : null, signal }
}

class HostPtyProcess implements PtyProcess {
  readonly pid: number
  readonly generation: number
  readonly #id: number
  readonly #host: HostHandle
  readonly #platform: NodeJS.Platform
  readonly #dataListeners = new Set<(data: string) => void>()
  readonly #exitListeners = new Set<(exit: PtyExit) => void>()
  #prebuffer: string[] | undefined = []
  #prebufferChars = 0
  #exited: PtyExit | undefined
  #killRequested = false

  constructor(id: number, pid: number, host: HostHandle, platform: NodeJS.Platform) {
    this.#id = id
    this.pid = pid
    this.generation = host.generation
    this.#host = host
    this.#platform = platform
  }

  deliverData(data: string): void {
    if (this.#exited !== undefined) return
    if (this.#prebuffer !== undefined) {
      if (this.#prebufferChars + data.length > MAX_PREBUFFER_CHARS) return
      this.#prebuffer.push(data)
      this.#prebufferChars += data.length
      return
    }
    for (const listener of [...this.#dataListeners]) listener(data)
  }

  deliverExit(exit: PtyExit): void {
    if (this.#exited !== undefined) return
    this.#exited = exit
    const listeners = [...this.#exitListeners]
    this.#exitListeners.clear()
    this.#dataListeners.clear()
    this.#prebuffer = undefined
    for (const listener of listeners) listener(exit)
  }

  #send(request: HostRequest): void {
    this.#host.send(request)
  }

  #inputClosed(): boolean {
    return this.#exited !== undefined || (this.#killRequested && this.#platform === 'win32')
  }

  write(data: string): void {
    if (this.#inputClosed()) return
    let start = 0
    while (start < data.length) {
      let end = Math.min(start + MAX_WRITE_CHARS, data.length)
      // No partir un par sustituto entre dos mensajes.
      const last = data.charCodeAt(end - 1)
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--
      this.#send({ t: 'write', id: this.#id, data: data.slice(start, end) })
      start = end
    }
  }

  resize(cols: number, rows: number): void {
    for (const n of [cols, rows]) {
      if (!isValidSize(n)) throw new RangeError(`dimensión fuera de rango (1..${MAX_SIZE}): ${n}`)
    }
    if (this.#inputClosed()) return
    this.#send({ t: 'resize', id: this.#id, cols, rows })
  }

  kill(signal: KillSignal = 'SIGTERM'): void {
    if (this.#exited !== undefined) return
    if (this.#platform === 'win32' && this.#killRequested) return
    this.#killRequested = true
    this.#send({ t: 'kill', id: this.#id, signal })
  }

  onData(listener: (data: string) => void): Unsubscribe {
    if (this.#exited !== undefined) return () => {}
    this.#dataListeners.add(listener)
    const pending = this.#prebuffer
    if (pending !== undefined) {
      this.#prebuffer = undefined
      for (const chunk of pending) for (const l of [...this.#dataListeners]) l(chunk)
    }
    return () => {
      this.#dataListeners.delete(listener)
    }
  }

  onExit(listener: (exit: PtyExit) => void): Unsubscribe {
    const exited = this.#exited
    if (exited !== undefined) {
      let active = true
      void Promise.resolve().then(() => {
        if (active) listener(exited)
      })
      return () => {
        active = false
      }
    }
    this.#exitListeners.add(listener)
    return () => {
      this.#exitListeners.delete(listener)
    }
  }
}

export type PtyHostPortOptions = Pick<
  SupervisorOptions,
  | 'entry'
  | 'execArgv'
  | 'readyTimeoutMs'
  | 'backoffBaseMs'
  | 'backoffMaxMs'
  | 'stableMs'
  | 'maxConsecutiveFailures'
  | 'cooldownMs'
  | 'maxInvalidMessages'
  | 'shutdownGraceMs'
> & {
  logger?: LoggerPort
  /** Solo para pruebas; por defecto `process.platform`. */
  platform?: NodeJS.Platform
  /** Entorno base; por defecto `process.env`. */
  baseEnv?: Readonly<Record<string, string | undefined>>
  /** Espera máxima a que el host confirme un `spawn`. */
  spawnReplyTimeoutMs?: number
}

type Pending = {
  host: HostHandle
  cmd: string
  timer: NodeJS.Timeout
  resolve(proc: PtyProcess): void
  reject(error: PtySpawnError): void
}

/**
 * `PtyPort` que ejecuta node-pty en un proceso hijo («pty host»): una violación de acceso nativa de ConPTY
 * tumba al host, no al daemon. Las terminales afectadas reciben `onExit` con `signal: 'HOST_CRASH'` y el
 * host se relanza para las nuevas.
 */
export class PtyHostPort implements PtyPort {
  readonly #platform: NodeJS.Platform
  readonly #baseEnv: Readonly<Record<string, string | undefined>>
  readonly #logger: LoggerPort | undefined
  readonly #spawnReplyTimeoutMs: number
  readonly #supervisor: HostSupervisor
  readonly #procs = new Map<number, HostPtyProcess>()
  readonly #pending = new Map<number, Pending>()
  #nextId = 1

  constructor(options: PtyHostPortOptions = {}) {
    const { platform, baseEnv, spawnReplyTimeoutMs, ...rest } = options
    this.#platform = platform ?? process.platform
    this.#baseEnv = baseEnv ?? process.env
    this.#logger = options.logger
    this.#spawnReplyTimeoutMs = spawnReplyTimeoutMs ?? SPAWN_REPLY_TIMEOUT_MS
    this.#supervisor = new HostSupervisor({
      ...rest,
      onEvent: (generation, event) => this.#onEvent(generation, event),
      onDown: (generation, info) => this.#onDown(generation, info),
    })
  }

  get hostRunning(): boolean {
    return this.#supervisor.running
  }

  /** PID del proceso host actual (para diagnóstico y pruebas). */
  get hostPid(): number | undefined {
    return this.#supervisor.pid
  }

  get consecutiveHostFailures(): number {
    return this.#supervisor.consecutiveFailures
  }

  #updateBusy(): void {
    this.#supervisor.setBusy(this.#procs.size > 0 || this.#pending.size > 0)
  }

  #onEvent(generation: number, event: HostEvent): void {
    switch (event.t) {
      case 'spawned': {
        const pending = this.#pending.get(event.id)
        if (pending === undefined || pending.host.generation !== generation) return
        this.#pending.delete(event.id)
        clearTimeout(pending.timer)
        const proc = new HostPtyProcess(event.id, event.pid, pending.host, this.#platform)
        this.#procs.set(event.id, proc)
        pending.resolve(proc)
        return
      }
      case 'spawn-error': {
        const pending = this.#pending.get(event.id)
        if (pending === undefined || pending.host.generation !== generation) return
        this.#pending.delete(event.id)
        clearTimeout(pending.timer)
        this.#updateBusy()
        pending.reject(
          new PtySpawnError('SPAWN_FAILED', `no se pudo lanzar ${pending.cmd}: ${event.message}`),
        )
        return
      }
      case 'data': {
        const proc = this.#procs.get(event.id)
        if (proc !== undefined && proc.generation === generation) proc.deliverData(event.data)
        return
      }
      case 'exit': {
        const proc = this.#procs.get(event.id)
        if (proc === undefined || proc.generation !== generation) return
        this.#procs.delete(event.id)
        this.#updateBusy()
        proc.deliverExit(toExit(event))
        return
      }
      case 'ready':
        return
    }
  }

  #onDown(generation: number, info: HostDownInfo): void {
    const exit: PtyExit =
      info.reason === 'disposed'
        ? { exitCode: null, signal: 'SIGKILL' }
        : { exitCode: null, signal: HOST_CRASH_SIGNAL }
    for (const [id, pending] of [...this.#pending]) {
      if (pending.host.generation !== generation) continue
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(
        new PtySpawnError('SPAWN_FAILED', `el proceso pty host se cayó al lanzar ${pending.cmd}`),
      )
    }
    const affected = [...this.#procs].filter(([, proc]) => proc.generation === generation)
    for (const [id] of affected) this.#procs.delete(id)
    this.#updateBusy()
    if (affected.length > 0 && info.reason !== 'disposed') {
      this.#logger?.error('el pty host cayó y arrastró terminales', {
        generation,
        terminals: affected.length,
        code: info.code,
        signal: info.signal,
      })
    }
    for (const [, proc] of affected) proc.deliverExit(exit)
  }

  async spawn(options: PtySpawnOptions): Promise<PtyProcess> {
    const { cmd, args, cols, rows } = options
    if (typeof cmd !== 'string' || cmd === '' || cmd.includes('\u0000')) {
      throw new PtySpawnError('INVALID_OPTIONS', 'cmd debe ser un texto no vacío sin NUL')
    }
    if (!isValidSize(cols) || !isValidSize(rows)) {
      throw new PtySpawnError(
        'INVALID_OPTIONS',
        `dimensiones fuera de rango (1..${MAX_SIZE}): ${cols}x${rows}`,
      )
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\u0000'))) {
      throw new PtySpawnError('INVALID_OPTIONS', 'args debe ser un arreglo de textos sin NUL')
    }
    const cwd = options.cwd ?? process.cwd()
    if (!isDirectory(cwd)) {
      throw new PtySpawnError('CWD_NOT_FOUND', `el directorio no existe: ${cwd}`)
    }
    const env = mergeEnv(this.#baseEnv, options.env, this.#platform)
    const file = resolveExecutable(cmd, { cwd, env, platform: this.#platform })
    if (file === undefined) {
      throw new PtySpawnError('EXECUTABLE_NOT_FOUND', `ejecutable no encontrado: ${cmd}`)
    }
    let envBytes = 0
    for (const [k, v] of Object.entries(env)) envBytes += k.length + v.length
    if (envBytes > MAX_SPAWN_ENV_BYTES) {
      throw new PtySpawnError('INVALID_OPTIONS', 'el entorno es demasiado grande')
    }

    const host = await this.#supervisor.ensure()
    if (!host.alive()) {
      throw new PtySpawnError(
        'SPAWN_FAILED',
        'el proceso pty host se cayó antes de recibir el lanzamiento',
      )
    }
    const id = this.#nextId
    this.#nextId = id >= MAX_TERMINAL_ID ? 1 : id + 1

    return new Promise<PtyProcess>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        this.#updateBusy()
        reject(new PtySpawnError('SPAWN_FAILED', `el pty host no respondió al lanzar ${cmd}`))
      }, this.#spawnReplyTimeoutMs)
      this.#pending.set(id, { host, cmd, timer, resolve, reject })
      this.#updateBusy()
      host.send({
        t: 'spawn',
        id,
        file,
        args: [...args],
        cwd,
        env,
        name: readEnv(env, 'TERM', this.#platform) ?? 'xterm-256color',
        cols,
        rows,
        conptyDll: this.#platform === 'win32',
      })
    })
  }

  /** Pide al host que cierre todas las terminales y salga; lo mata si tarda. Las terminales reciben `onExit`. */
  dispose(): void {
    this.#supervisor.dispose()
  }
}
