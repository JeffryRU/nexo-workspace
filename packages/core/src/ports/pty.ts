export type Unsubscribe = () => void

export type PtySpawnOptions = {
  cmd: string
  args: readonly string[]
  cwd?: string
  /** Se mezcla sobre el entorno del proceso anfitrión (las claves de `env` ganan). */
  env?: Readonly<Record<string, string>>
  cols: number
  rows: number
}

/**
 * Salida de un proceso. En Linux, un proceso matado por señal da `exitCode` null y `signal` con su
 * nombre; en Windows (ConPTY) no hay señales: `signal` es null y `exitCode` es numérico.
 *
 * Excepción: con el adaptador `pty-host`, si el proceso host murió (crash nativo) la terminal sale con
 * `exitCode` null y `signal: "HOST_CRASH"`; no es una señal real del sistema.
 */
export type PtyExit = { exitCode: number | null; signal: string | null }

export type PtySpawnErrorCode =
  | 'EXECUTABLE_NOT_FOUND'
  | 'CWD_NOT_FOUND'
  | 'INVALID_OPTIONS'
  | 'SPAWN_FAILED'

/** Error tipado de `PtyPort.spawn`: el rechazo siempre es una instancia de esta clase. */
export class PtySpawnError extends Error {
  readonly code: PtySpawnErrorCode

  constructor(code: PtySpawnErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PtySpawnError'
    this.code = code
  }
}

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
  /**
   * Rechaza siempre con `PtySpawnError`: `EXECUTABLE_NOT_FOUND`, `CWD_NOT_FOUND` (el directorio no
   * existe o no es un directorio), `INVALID_OPTIONS` (dimensiones fuera de 1..1000, no enteras o
   * `cmd` vacío) o `SPAWN_FAILED`.
   */
  spawn(options: PtySpawnOptions): Promise<PtyProcess>
}
