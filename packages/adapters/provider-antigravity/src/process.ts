import { type ChildProcess, spawn } from 'node:child_process'
import type { AgyCommand } from './resolve.ts'

export type ExitInfo = { exitCode: number | null; signal: string | null; error?: Error }

/** Un proceso `agy` (un turno) visto como texto por stdin/stdout. Abstracción para poder probar sin proceso real. */
export type AgyProcess = {
  /** Escribe en stdin y lo cierra: `agy` acaba el turno al ver el fin de la entrada. Nunca lanza. */
  writeAndClose(text: string): void
  /** `stdout` ya decodificado (los caracteres UTF-8 partidos entre trozos se reconstruyen). */
  onStdout(listener: (text: string) => void): void
  onStderr(listener: (text: string) => void): void
  /** Una sola vez, al terminar (o si no pudo arrancar: `error`). */
  onExit(listener: (info: ExitInfo) => void): void
  /**
   * Pide cortar el turno. En POSIX envía SIGINT (`agy` cierra con estado `INTERRUPTED`) y, si sigue vivo
   * tras `graceMs`, lo mata; en Windows no hay señales y se termina el árbol de procesos. Idempotente.
   */
  interrupt(graceMs?: number): void
  /** Termina el proceso (y, en Windows, su árbol) y, si sigue vivo tras `graceMs`, lo mata a la fuerza. Idempotente. */
  kill(graceMs?: number): void
}

export type LaunchOptions = {
  command: AgyCommand
  /** Argumentos que se añaden a los del comando (`command.args`). */
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string | undefined>>
}

export type AgyLauncher = (options: LaunchOptions) => AgyProcess

function cleanEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

/** En Windows `child.kill()` deja vivos a los nietos (los comandos del agente): se termina el árbol. */
function killTree(child: ChildProcess, signal?: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      }).on('error', () => child.kill())
      return
    } catch {
      // cae al kill normal
    }
  }
  child.kill(signal)
}

/** Lanza el proceso de verdad con `spawn(cmd, args[])`, sin shell (AGENTS.md, regla 9). */
export const spawnAgyProcess: AgyLauncher = ({ command, args, cwd, env }) => {
  const child: ChildProcess = spawn(command.command, [...command.args, ...args], {
    cwd,
    env: cleanEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })
  const exits: ((info: ExitInfo) => void)[] = []
  let exited: ExitInfo | undefined
  const finish = (info: ExitInfo) => {
    if (exited !== undefined) return
    exited = info
    for (const l of exits) l(info)
  }
  child.once('error', (error) => finish({ exitCode: null, signal: null, error }))
  child.once('close', (exitCode, signal) => finish({ exitCode, signal }))
  // Un nieto que conserve las tuberías abiertas retrasaría 'close' para siempre: 'exit' lo cubre.
  child.once('exit', (exitCode, signal) => {
    setTimeout(() => finish({ exitCode, signal }), 500).unref()
  })
  child.stdin?.on('error', () => {})
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  let timer: ReturnType<typeof setTimeout> | undefined
  const forceLater = (graceMs: number) => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      if (exited === undefined) killTree(child, 'SIGKILL')
    }, graceMs)
    timer.unref()
  }

  return {
    writeAndClose(text) {
      const stdin = child.stdin
      if (exited !== undefined || stdin === null || stdin.destroyed) return
      stdin.end(text)
    },
    onStdout(listener) {
      child.stdout?.on('data', (chunk: string) => listener(chunk))
    },
    onStderr(listener) {
      child.stderr?.on('data', (chunk: string) => listener(chunk))
    },
    onExit(listener) {
      if (exited !== undefined) listener(exited)
      else exits.push(listener)
    },
    interrupt(graceMs = 3000) {
      if (exited !== undefined || timer !== undefined) return
      if (process.platform === 'win32') killTree(child)
      else child.kill('SIGINT')
      forceLater(graceMs)
    },
    kill(graceMs = 2000) {
      if (exited !== undefined) return
      child.stdin?.end()
      killTree(child, 'SIGTERM')
      forceLater(graceMs)
    },
  }
}

export type RunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error?: Error
}

/** Ejecuta `agy` con argumentos fijos hasta que termina (o vence el plazo) y devuelve su salida acotada. */
export function runAgy(options: {
  launcher: AgyLauncher
  command: AgyCommand
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  timeoutMs: number
  maxChars: number
}): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = options.launcher({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill(300)
    }, options.timeoutMs)
    proc.onStdout((t) => {
      if (stdout.length < options.maxChars) stdout += t
    })
    proc.onStderr((t) => {
      stderr = (stderr + t).slice(-4096)
    })
    proc.onExit((info) => {
      clearTimeout(timer)
      resolve({
        exitCode: info.exitCode,
        stdout: stdout.slice(0, options.maxChars),
        stderr,
        timedOut,
        ...(info.error === undefined ? {} : { error: info.error }),
      })
    })
    proc.writeAndClose('')
  })
}
