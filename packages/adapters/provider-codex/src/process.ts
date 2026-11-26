import { type ChildProcess, spawn } from 'node:child_process'
import type { CodexCommand } from './resolve.ts'

export type ExitInfo = { exitCode: number | null; signal: string | null; error?: Error }

/** Un proceso `codex app-server` visto como texto por stdin/stdout. Abstracción para poder probar sin proceso real. */
export type CodexProcess = {
  /** Escribe en stdin; nunca lanza (si el proceso ya murió, se pierde). */
  write(text: string): void
  /** `stdout` ya decodificado (los caracteres UTF-8 partidos entre trozos se reconstruyen). */
  onStdout(listener: (text: string) => void): void
  onStderr(listener: (text: string) => void): void
  /** Una sola vez, al terminar (o si no pudo arrancar: `error`). */
  onExit(listener: (info: ExitInfo) => void): void
  /** Pide terminar: cierra stdin, envía la señal de fin y, si sigue vivo tras `graceMs`, lo mata. Idempotente. */
  kill(graceMs?: number): void
}

export type LaunchOptions = {
  command: CodexCommand
  cwd: string
  env: Readonly<Record<string, string | undefined>>
}

export type CodexLauncher = (options: LaunchOptions) => CodexProcess

/** Lanza el proceso de verdad con `spawn(cmd, args[])`, sin shell (AGENTS.md, regla 9). */
export const spawnCodexProcess: CodexLauncher = ({ command, cwd, env }) => {
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v
  const child: ChildProcess = spawn(command.command, [...command.args, 'app-server'], {
    cwd,
    env: cleanEnv,
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
  let killTimer: ReturnType<typeof setTimeout> | undefined

  return {
    write(text) {
      if (exited !== undefined || child.stdin === null || child.stdin.destroyed) return
      child.stdin.write(text)
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
    kill(graceMs = 2000) {
      if (exited !== undefined || killTimer !== undefined) return
      child.stdin?.end()
      child.kill()
      killTimer = setTimeout(() => {
        if (exited === undefined) child.kill('SIGKILL')
      }, graceMs)
      killTimer.unref()
    },
  }
}
