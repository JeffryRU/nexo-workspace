export type Unsubscribe = () => void

export type PtySpawnOptions = {
  cmd: string
  args: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
  cols: number
  rows: number
}

export type PtyExit = { exitCode: number | null; signal: string | null }

/**
 * Un proceso en un PTY.
 *
 * Contrato (lo comprueba la suite de conformidad):
 * - `write` y `resize` sobre un proceso que ya terminó no hacen nada ni lanzan.
 * - `resize` con columnas/filas fuera de 1..1000 o no enteras lanza `RangeError`.
 * - `kill` es idempotente; `onExit` se dispara exactamente una vez.
 * - Un `onExit` registrado cuando el proceso ya terminó se invoca igualmente (una vez).
 */
export interface PtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'): void
  onData(listener: (data: string) => void): Unsubscribe
  onExit(listener: (exit: PtyExit) => void): Unsubscribe
}

export interface PtyPort {
  /** Rechaza si el proceso no se puede lanzar o si las dimensiones no son válidas. */
  spawn(options: PtySpawnOptions): Promise<PtyProcess>
}
