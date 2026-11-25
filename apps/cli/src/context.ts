import type { NexoClient } from '@nexo/client'
import type { z } from 'zod'
import { CliError, type ExitCode } from './errors.ts'
import { sanitize } from './text.ts'

/** Lo mínimo del cliente que usan los comandos (así se inyecta uno falso en las pruebas). */
export type ClientLike = Pick<NexoClient, 'call' | 'subscribe' | 'on' | 'close'>

export type Sink = { write(text: string): void }

export type Io = {
  stdout: Sink
  stderr: Sink
  stdin: () => AsyncIterable<Uint8Array | string>
  columns?: number | undefined
  rows?: number | undefined
}

export type DaemonInfoLocation = { port: number; pid: number }

/** Todo lo que toca el sistema; `main.ts` aporta las implementaciones reales. */
export type Deps = {
  io: Io
  /** Conecta al daemon; con `autostart` lo arranca si no corre. */
  connect: (options: { autostart: boolean }) => Promise<ClientLike>
  daemon: {
    stateDir(): string
    /** Localiza un daemon vivo (lanza `DiscoveryError` si no hay). */
    locate(): Promise<DaemonInfoLocation>
    /** Últimos bytes del registro del daemon, o `undefined` si no existe. */
    readLog(maxBytes: number): Promise<string | undefined>
  }
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  cwd: () => string
  /** Se cancela con Ctrl+C o al cerrarse la tubería de salida. */
  signal: AbortSignal
  /** Espera `ms` (cancelable); inyectable para pruebas. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export class Ctx {
  readonly deps: Deps
  readonly json: boolean
  readonly autostart: boolean
  readonly #clients: ClientLike[] = []
  #main: Promise<ClientLike> | undefined
  /** Código de salida si el comando termina sin lanzar (p. ej. status con el daemon detenido). */
  exitCode: ExitCode = 0

  constructor(deps: Deps, options: { json: boolean; autostart: boolean }) {
    this.deps = deps
    this.json = options.json
    this.autostart = options.autostart
  }

  get io(): Io {
    return this.deps.io
  }

  get signal(): AbortSignal {
    return this.deps.signal
  }

  /** Cliente principal (autoarranca el daemon salvo `--no-start`); se abre una sola vez. */
  client(): Promise<ClientLike> {
    this.#main ??= this.open(this.autostart)
    return this.#main
  }

  async open(autostart: boolean): Promise<ClientLike> {
    const client = await this.deps.connect({ autostart })
    this.#clients.push(client)
    return client
  }

  closeAll(): void {
    for (const c of this.#clients.splice(0)) {
      try {
        c.close()
      } catch {
        // ya cerrado
      }
    }
  }

  out(text: string): void {
    this.io.stdout.write(text)
  }

  /** Imprime un resultado: validado con su esquema y como JSON con `--json`, si no con `text()`. */
  emit<S extends z.ZodType>(schema: S, value: z.input<S>, text: () => string): void {
    if (this.json) {
      const parsed = schema.safeParse(value)
      if (!parsed.success) throw new CliError('DAEMON_ERROR', 'la salida JSON no cumple su esquema')
      this.out(`${JSON.stringify(parsed.data)}\n`)
    } else {
      const body = text()
      if (body !== '') this.out(body.endsWith('\n') ? body : `${body}\n`)
    }
  }

  /** Texto de una referencia del usuario para mensajes (saneado y acotado). */
  static show(value: string): string {
    return sanitize(value, 64)
  }
}
