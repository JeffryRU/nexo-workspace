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

export function toExit(raw: { exitCode: number; signal?: number | undefined }): PtyExit {
  const signal =
    raw.signal === undefined || raw.signal === 0
      ? null
      : (signalNames.get(raw.signal) ?? `SIG${raw.signal}`)
  // En Unix, una muerte por señal llega como exitCode 0 + signal; se normaliza a exitCode null.
  return { exitCode: signal === null ? raw.exitCode : null, signal }
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

class NodePtyProcess implements PtyProcess {
  readonly pid: number
  readonly #pty: nodePty.IPty
  readonly #platform: NodeJS.Platform
  readonly #dataListeners = new Set<(data: string) => void>()
  readonly #exitListeners = new Set<(exit: PtyExit) => void>()
  readonly #disposables: nodePty.IDisposable[] = []
  #exited: PtyExit | undefined
  #killRequested = false

  constructor(pty: nodePty.IPty, platform: NodeJS.Platform) {
    this.#pty = pty
    this.#platform = platform
    this.pid = pty.pid
    this.#disposables.push(
      pty.onData((data) => {
        for (const listener of [...this.#dataListeners]) listener(data)
      }),
      pty.onExit((raw) => this.#handleExit(toExit(raw))),
    )
  }

  #handleExit(exit: PtyExit): void {
    if (this.#exited !== undefined) return
    this.#exited = exit
    for (const disposable of this.#disposables.splice(0)) disposable.dispose()
    const listeners = [...this.#exitListeners]
    this.#exitListeners.clear()
    this.#dataListeners.clear()
    for (const listener of listeners) listener(exit)
  }

  #inputClosed(): boolean {
    return this.#exited !== undefined || (this.#killRequested && this.#platform === 'win32')
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
}

/** `PtyPort` sobre node-pty (ConPTY en Windows, forkpty en Linux/macOS). */
export class NodePtyPort implements PtyPort {
  readonly #platform: NodeJS.Platform
  readonly #baseEnv: Readonly<Record<string, string | undefined>>

  constructor(options: NodePtyPortOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#baseEnv = options.baseEnv ?? process.env
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
      return new NodePtyProcess(pty, this.#platform)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new PtySpawnError('SPAWN_FAILED', `no se pudo lanzar ${cmd}: ${message}`, {
        cause: error,
      })
    }
  }
}
