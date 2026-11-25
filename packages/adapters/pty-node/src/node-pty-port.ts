import { constants } from 'node:os'
import process from 'node:process'
import {
  type PtyExit,
  type PtyPort,
  type PtyProcess,
  PtySpawnError,
  type PtySpawnOptions,
  type Unsubscribe,
} from '@nexo/core'
import * as nodePty from 'node-pty'
import { isDirectory, readEnv, resolveExecutable } from './resolve.ts'
import { acquireWriteErrorFilter } from './write-error-filter.ts'

const MIN_SIZE = 1
const MAX_SIZE = 1000

type KillSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'

function isValidSize(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_SIZE && n <= MAX_SIZE
}

function assertSize(cols: number, rows: number): void {
  for (const n of [cols, rows]) {
    if (!isValidSize(n)) throw new RangeError(`dimensión fuera de rango (1..${MAX_SIZE}): ${n}`)
  }
}

const signalNames = new Map<number, string>(
  Object.entries(constants.signals).map(([name, value]) => [value, name]),
)

/** Lo mínimo que se necesita de un `IPty` de node-pty (permite probar con un falso). */
export type PtyLike = {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): nodePty.IDisposable
  /** `exitCode` y `signal` pueden venir con otro tipo en tiempo de ejecución (ConPTY): se validan. */
  onExit(
    listener: (e: { exitCode: number | undefined; signal?: number | undefined }) => void,
  ): nodePty.IDisposable
  /** Interno de la implementación Unix de node-pty: cola de escrituras pendientes. */
  _writeStream?: { _writeQueue?: unknown[] }
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n)

export function toExit(
  raw: { exitCode?: unknown; signal?: unknown },
  log: (message: string) => void = () => {},
): PtyExit {
  const signal =
    !isInt(raw.signal) || raw.signal === 0
      ? null
      : (signalNames.get(raw.signal) ?? `SIG${raw.signal}`)
  // En Unix, una muerte por señal llega como exitCode 0 + signal; se normaliza a exitCode null.
  if (signal !== null) return { exitCode: null, signal }
  // node-pty (ConPTY) puede llamar a onExit sin código numérico; sin normalizar, el exit no sería válido (#37).
  if (!isInt(raw.exitCode)) {
    log(`la terminal salió sin código de salida (${String(raw.exitCode)})`)
    return { exitCode: null, signal: null }
  }
  return { exitCode: raw.exitCode, signal: null }
}

/** Mezcla `env` sobre el entorno del anfitrión; en Windows las claves no distinguen mayúsculas. */
export function mergeEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> | undefined,
  platform: NodeJS.Platform,
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) merged[key] = value
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (platform === 'win32') {
      const lower = key.toLowerCase()
      for (const existing of Object.keys(merged)) {
        if (existing.toLowerCase() === lower) delete merged[existing]
      }
    }
    merged[key] = value
  }
  return merged
}

const KILL_SPACING_MS = 25
let killGate: Promise<void> = Promise.resolve()

/** Ejecuta `action` en cola, separada 25 ms de la anterior. */
function windowsKillGate(action: () => void): Promise<void> {
  killGate = killGate.then(async () => {
    action()
    await new Promise<void>((resolve) => setTimeout(resolve, KILL_SPACING_MS))
  })
  return killGate
}

/** Solo para pruebas: envuelve un `PtyLike` ya creado. */
export class NodePtyProcess implements PtyProcess {
  readonly pid: number
  readonly #pty: PtyLike
  readonly #log: (message: string) => void
  readonly #platform: NodeJS.Platform
  readonly #dataListeners = new Set<(data: string) => void>()
  readonly #exitListeners = new Set<(exit: PtyExit) => void>()
  readonly #disposables: nodePty.IDisposable[] = []
  #exited: PtyExit | undefined
  #killRequested = false
  #terminating = false
  readonly #releaseFilter: (() => void) | undefined

  constructor(pty: PtyLike, platform: NodeJS.Platform, log: (message: string) => void) {
    this.#pty = pty
    this.#log = log
    this.#releaseFilter = platform === 'win32' ? undefined : acquireWriteErrorFilter()
    this.#platform = platform
    this.pid = pty.pid
    this.#disposables.push(
      pty.onData((data) => {
        for (const listener of [...this.#dataListeners]) listener(data)
      }),
      pty.onExit((raw) => this.#handleExit(toExit(raw, this.#log))),
    )
  }

  #handleExit(exit: PtyExit): void {
    if (this.#exited !== undefined) return
    this.#exited = exit
    for (const disposable of this.#disposables.splice(0)) disposable.dispose()
    this.#dropPendingWrites()
    this.#releaseFilter?.()
    const listeners = [...this.#exitListeners]
    this.#exitListeners.clear()
    this.#dataListeners.clear()
    for (const listener of listeners) listener(exit)
  }

  // node-pty (Unix) encola las escrituras y las reintenta en segundo plano; si la PTY se cierra con datos
  // pendientes, fallan con EBADF y node-pty lo imprime con console.error («Unhandled pty write error»).
  // No hay API pública para cancelarlas, así que se vacía la cola (escribir tras salir es un no-op).
  #dropPendingWrites(): void {
    const queue = this.#pty._writeStream?._writeQueue
    if (Array.isArray(queue)) queue.length = 0
  }

  #inputClosed(): boolean {
    return (
      this.#exited !== undefined ||
      (this.#killRequested && this.#platform === 'win32') ||
      this.#terminating
    )
  }

  // En Windows, tras pedir kill, ConPTY ya cerró el handle nativo: escribir o redimensionar entonces puede
  // provocar una violación de acceso en node-pty, así que se ignora igual que tras la salida.
  write(data: string): void {
    if (this.#inputClosed()) return
    try {
      this.#pty.write(data)
    } catch {
      // Carrera con la salida del proceso (EIO/EPIPE/«already exited»): equivale a escribir tras salir.
    }
  }

  resize(cols: number, rows: number): void {
    assertSize(cols, rows)
    if (this.#inputClosed()) return
    try {
      this.#pty.resize(cols, rows)
    } catch {
      // Carrera con la salida del proceso; las dimensiones ya se validaron arriba.
    }
  }

  kill(signal: KillSignal = 'SIGTERM'): void {
    if (this.#exited !== undefined) return
    const windows = this.#platform === 'win32'
    // En Windows no hay señales y node-pty lanza si se le pasa una; un segundo kill no hace nada.
    if (windows && this.#killRequested) return
    this.#killRequested = true
    // SIGINT no termina por fuerza (Ctrl+C): el proceso puede seguir recibiendo entrada. Con el resto, el
    // descriptor se cierra enseguida y las escrituras encoladas fallarían con EBADF antes de notificar la salida.
    if (!windows && signal !== 'SIGINT') {
      this.#terminating = true
      this.#dropPendingWrites()
    }
    if (windows) {
      // Varios kill simultáneos pueden tumbar el proceso anfitrión desde el código nativo de
      // node-pty en Windows; se espacian unos milisegundos (ver windowsKillGate).
      void windowsKillGate(() => this.#nativeKill(undefined))
    } else {
      this.#nativeKill(signal)
    }
  }

  #nativeKill(signal: KillSignal | undefined): void {
    if (this.#exited !== undefined) return
    try {
      this.#pty.kill(signal)
    } catch {
      // El proceso ya murió y la notificación de salida está en camino.
    }
  }

  onData(listener: (data: string) => void): Unsubscribe {
    if (this.#exited !== undefined) return () => {}
    this.#dataListeners.add(listener)
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

export type NodePtyPortOptions = {
  /** Solo para pruebas; por defecto `process.platform`. */
  platform?: NodeJS.Platform
  /** Entorno base; por defecto `process.env`. */
  baseEnv?: Readonly<Record<string, string | undefined>>
  /** Registro de anomalías; por defecto, stderr. */
  log?: (message: string) => void
}

/** `PtyPort` sobre node-pty (ConPTY en Windows, forkpty en Linux/macOS). */
export class NodePtyPort implements PtyPort {
  readonly #platform: NodeJS.Platform
  readonly #baseEnv: Readonly<Record<string, string | undefined>>
  readonly #log: (message: string) => void

  constructor(options: NodePtyPortOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#baseEnv = options.baseEnv ?? process.env
    this.#log =
      options.log ??
      ((m) =>
        void process.stderr.write(`[pty-node] ${m}
`))
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

    try {
      const pty = nodePty.spawn(file, [...args], {
        name: readEnv(env, 'TERM', this.#platform) ?? 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        // El ConPTY del sistema provoca violaciones de acceso en node-pty 1.1.0 cuando varios PTYs
        // salen a la vez (reproducible sin este adaptador); el conpty.dll incluido no las tiene.
        useConptyDll: this.#platform === 'win32',
      })
      return new NodePtyProcess(pty, this.#platform, this.#log)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new PtySpawnError('SPAWN_FAILED', `no se pudo lanzar ${cmd}: ${message}`, {
        cause: error,
      })
    }
  }
}
