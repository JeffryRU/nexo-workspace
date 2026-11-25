import { type ChildProcess, fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { type LoggerPort, PtySpawnError } from '@nexo/core'
import { type HostEvent, type HostRequest, parseHostEvent } from './protocol.ts'

export const DEFAULT_HOST_ENTRY = fileURLToPath(new URL('./host.ts', import.meta.url))

export type HostDownInfo = {
  /** `crash`: el host murió solo; `protocol`: se mató por mensajes inválidos repetidos; `disposed`: parada pedida. */
  reason: 'crash' | 'protocol' | 'disposed'
  code: number | null
  signal: string | null
}

export type SupervisorOptions = {
  /** Script del host; por defecto `host.ts`. Las pruebas pasan sustitutos. */
  entry?: string
  execArgv?: readonly string[]
  /** Espera máxima al `ready` de un host recién lanzado. */
  readyTimeoutMs?: number
  /** Espera inicial tras una caída rápida; se duplica en cada caída consecutiva. */
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** Un host que vive al menos esto se considera estable y reinicia el contador de caídas. */
  stableMs?: number
  /** Caídas rápidas consecutivas tras las cuales se deja de relanzar durante `cooldownMs`. */
  maxConsecutiveFailures?: number
  cooldownMs?: number
  /** Mensajes inválidos del host tolerados antes de matarlo. */
  maxInvalidMessages?: number
  /** Tiempo que se da al host para cerrar ordenadamente antes de matarlo. */
  shutdownGraceMs?: number
  logger?: LoggerPort
  onEvent(generation: number, event: HostEvent): void
  onDown(generation: number, info: HostDownInfo): void
}

export type HostHandle = {
  readonly generation: number
  /**  cuando el host ya cayó: no se le puede enviar nada. */
  alive(): boolean
  send(request: HostRequest): void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Channel = { ref(): void; unref(): void }

/**
 * Mantiene vivo un único proceso host: lo lanza bajo demanda, detecta su caída, avisa y lo relanza
 * para las terminales nuevas con backoff exponencial y un tope (circuito abierto) si se cae en bucle.
 */
export class HostSupervisor {
  readonly #readyTimeoutMs: number
  readonly #backoffBaseMs: number
  readonly #backoffMaxMs: number
  readonly #stableMs: number
  readonly #maxFailures: number
  readonly #cooldownMs: number
  readonly #maxInvalid: number
  readonly #options: SupervisorOptions
  readonly #shutdownGraceMs: number
  #child: ChildProcess | undefined
  #handle: HostHandle | undefined
  #starting: Promise<HostHandle> | undefined
  #generation = 0
  #failures = 0
  #lastDownAt = 0
  #openUntil = 0
  #busy = false
  #disposed = false

  constructor(options: SupervisorOptions) {
    this.#options = options
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 15000
    this.#backoffBaseMs = options.backoffBaseMs ?? 250
    this.#backoffMaxMs = options.backoffMaxMs ?? 5000
    this.#stableMs = options.stableMs ?? 10000
    this.#maxFailures = options.maxConsecutiveFailures ?? 5
    this.#cooldownMs = options.cooldownMs ?? 30000
    this.#maxInvalid = options.maxInvalidMessages ?? 20
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 3000
  }

  get running(): boolean {
    return this.#handle !== undefined
  }

  get pid(): number | undefined {
    return this.#child?.pid
  }

  get consecutiveFailures(): number {
    return this.#failures
  }

  /** Mantiene el bucle de eventos vivo solo mientras hay terminales o lanzamientos pendientes. */
  setBusy(busy: boolean): void {
    this.#busy = busy
    this.#applyRef()
  }

  #applyRef(): void {
    const channel = (this.#child as { channel?: Channel } | undefined)?.channel
    if (this.#busy) channel?.ref()
    else channel?.unref()
  }

  ensure(): Promise<HostHandle> {
    if (this.#disposed) return Promise.reject(this.#stopped())
    if (this.#handle !== undefined) return Promise.resolve(this.#handle)
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  #stopped(): PtySpawnError {
    return new PtySpawnError('SPAWN_FAILED', 'el adaptador de PTY está detenido')
  }

  async #start(): Promise<HostHandle> {
    const now = Date.now()
    if (this.#failures >= this.#maxFailures) {
      if (now < this.#openUntil) {
        throw new PtySpawnError(
          'SPAWN_FAILED',
          `el proceso pty host se cayó ${this.#failures} veces seguidas; no se reintenta durante ${Math.ceil((this.#openUntil - now) / 1000)} s`,
        )
      }
      // Semiabierto: un único intento; si cae otra vez vuelve a abrirse.
      this.#failures = this.#maxFailures - 1
    }
    if (this.#failures > 0) {
      const delay = Math.min(this.#backoffBaseMs * 2 ** (this.#failures - 1), this.#backoffMaxMs)
      const wait = this.#lastDownAt + delay - now
      if (wait > 0) await sleep(wait)
      if (this.#disposed) throw this.#stopped()
    }
    return this.#launch()
  }

  #launch(): Promise<HostHandle> {
    const generation = ++this.#generation
    const startedAt = Date.now()
    const logger = this.#options.logger
    const child = fork(this.#options.entry ?? DEFAULT_HOST_ENTRY, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      ...(this.#options.execArgv === undefined ? {} : { execArgv: [...this.#options.execArgv] }),
    })
    this.#child = child
    let invalid = 0
    let ready = false
    let down = false
    let killedForProtocol = false

    return new Promise<HostHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        logger?.error('el pty host no respondió al arrancar', { generation })
        child.kill('SIGKILL')
      }, this.#readyTimeoutMs)

      const handle: HostHandle = {
        generation,
        alive: () => !down,
        send: (request) => {
          if (down || !child.connected) return
          try {
            child.send(request)
          } catch (error) {
            logger?.warn('no se pudo enviar al pty host', { error })
          }
        },
      }

      const goDown = (code: number | null, signal: string | null): void => {
        if (down) return
        down = true
        clearTimeout(timer)
        if (this.#child === child) {
          this.#child = undefined
          this.#handle = undefined
        }
        const reason: HostDownInfo['reason'] = this.#disposed
          ? 'disposed'
          : killedForProtocol
            ? 'protocol'
            : 'crash'
        if (reason !== 'disposed') {
          const uptime = Date.now() - startedAt
          this.#failures = ready && uptime >= this.#stableMs ? 0 : this.#failures + 1
          this.#lastDownAt = Date.now()
          if (this.#failures >= this.#maxFailures) this.#openUntil = Date.now() + this.#cooldownMs
          logger?.error('el pty host terminó de forma inesperada', {
            generation,
            code,
            signal,
            reason,
            consecutiveFailures: this.#failures,
          })
        }
        if (!ready) {
          reject(
            new PtySpawnError(
              'SPAWN_FAILED',
              `el proceso pty host terminó al arrancar (código ${code ?? '-'}, señal ${signal ?? '-'})`,
            ),
          )
          return
        }
        this.#options.onDown(generation, { reason, code, signal })
      }

      child.on('message', (raw: unknown) => {
        if (down) return
        const parsed = parseHostEvent(raw)
        if (!parsed.ok) {
          invalid++
          logger?.warn('mensaje inválido del pty host descartado', {
            generation,
            error: parsed.error,
          })
          if (invalid > this.#maxInvalid) {
            killedForProtocol = true
            child.kill('SIGKILL')
          }
          return
        }
        const event = parsed.value
        if (event.t === 'ready') {
          if (ready) return
          ready = true
          clearTimeout(timer)
          this.#handle = handle
          resolve(handle)
          return
        }
        if (ready) this.#options.onEvent(generation, event)
      })
      child.on('error', (error) => {
        logger?.error('error del proceso pty host', { generation, error })
        if (!child.connected) goDown(null, null)
      })
      child.on('exit', (code, signal) => goDown(code, signal))
      this.#applyRef()
    })
  }

  /** Detiene el host (las terminales mueren con él). Idempotente. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const child = this.#child
    if (child === undefined) return
    // Cierre ordenado (mata las terminales una a una); si no sale a tiempo, se mata el proceso.
    try {
      if (child.connected) child.send({ t: 'shutdown' })
    } catch {
      // Canal ya cerrado.
    }
    const hard = setTimeout(() => child.kill('SIGKILL'), this.#shutdownGraceMs)
    hard.unref()
    child.once('exit', () => clearTimeout(hard))
  }
}
