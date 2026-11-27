import type { NexoClient } from '@nexo/client'
import { DiscoveryError } from '@nexo/client/node'
import type { EventData, EventName } from '@nexo/contracts'
import { DaemonUnavailableError, daemonDownMessage } from './errors.ts'
import { oneLine, redact } from './text.ts'

/** Lo mínimo del cliente que usa el servidor (así se inyecta uno falso en las pruebas). */
export type LinkClient = Pick<NexoClient, 'call' | 'on' | 'subscribe' | 'close'>

/** Eventos del daemon que importan a los recursos. `terminal.output` no entra: sería una avalancha. */
export const WATCHED_EVENTS = [
  'pane.attention',
  'agent.status',
  'agent.session',
  'limits.updated',
  'layout.changed',
  'workspace.changed',
] as const satisfies readonly EventName[]

export type WatchedName = (typeof WATCHED_EVENTS)[number]

export type LinkEvent =
  | { [E in WatchedName]: { name: E; data: EventData<E> } }[WatchedName]
  /** Se perdió la continuidad (reconexión, hueco, contrapresión): todo puede haber cambiado. */
  | { name: 'resync' }

export type LinkOptions = {
  connect: () => Promise<LinkClient>
  logger: (message: string) => void
  now?: () => number
  /** Tras un fallo de conexión, no se reintenta antes de este plazo (evita martillar el daemon). */
  failureCooldownMs?: number
}

/**
 * Conexión perezosa y compartida con el daemon. Una sola conexión; si el daemon cae, el cliente reconecta
 * solo (redescubriendo puerto y token). Los fallos devuelven `DaemonUnavailableError` con un mensaje claro.
 */
export class DaemonLink {
  readonly #options: LinkOptions
  readonly #now: () => number
  readonly #listeners = new Set<(event: LinkEvent) => void>()
  #current: Promise<LinkClient> | undefined
  #client: LinkClient | undefined
  #failedAt = Number.NEGATIVE_INFINITY
  #lastFailure: DaemonUnavailableError | undefined
  #closed = false

  constructor(options: LinkOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  get connected(): boolean {
    return this.#client !== undefined
  }

  /** Cliente listo para usar, conectando si hace falta. */
  get(): Promise<LinkClient> {
    if (this.#closed) return Promise.reject(new DaemonUnavailableError('el servidor MCP se cerró'))
    if (this.#current !== undefined) return this.#wrap(this.#current)
    const cooldown = this.#options.failureCooldownMs ?? 1000
    if (this.#lastFailure !== undefined && this.#now() - this.#failedAt < cooldown) {
      return Promise.reject(this.#lastFailure)
    }
    const attempt = this.#open()
    this.#current = attempt
    attempt.then(
      (client) => {
        this.#client = client
        this.#lastFailure = undefined
      },
      (error: unknown) => {
        this.#current = undefined
        this.#failedAt = this.#now()
        this.#lastFailure = error instanceof DaemonUnavailableError ? error : this.#translate(error)
        this.#options.logger(`no se pudo conectar con el daemon: ${this.#lastFailure.message}`)
      },
    )
    return this.#wrap(attempt)
  }

  #wrap(attempt: Promise<LinkClient>): Promise<LinkClient> {
    return attempt.catch((error: unknown) => {
      throw error instanceof DaemonUnavailableError
        ? error
        : (this.#lastFailure ?? this.#translate(error))
    })
  }

  onEvent(listener: (event: LinkEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  close(): void {
    this.#closed = true
    const client = this.#client
    this.#client = undefined
    this.#current = undefined
    try {
      client?.close()
    } catch {
      // ya cerrado
    }
  }

  #translate(error: unknown): DaemonUnavailableError {
    if (error instanceof DiscoveryError) return new DaemonUnavailableError(daemonDownMessage(error))
    const detail =
      error instanceof Error ? oneLine(redact(error.message), 200) : 'error desconocido'
    return new DaemonUnavailableError(`no se pudo conectar con el daemon de Nexo (${detail})`)
  }

  async #open(): Promise<LinkClient> {
    const client = await this.#options.connect()
    try {
      this.#hook(client)
      await client.subscribe([...WATCHED_EVENTS])
    } catch (error) {
      try {
        client.close()
      } catch {
        // ya cerrado
      }
      throw error
    }
    return client
  }

  #hook(client: LinkClient): void {
    const forward = <E extends WatchedName>(name: E) =>
      client.on(name, (data: EventData<E>) => {
        this.#emit({ name, data } as LinkEvent)
      })
    for (const name of WATCHED_EVENTS) forward(name)
    client.on('resync', () => this.#emit({ name: 'resync' }))
    client.on('state', (state) => {
      // Cierre definitivo (el cliente se rindió): la siguiente llamada vuelve a conectar.
      if (state === 'closed' && this.#client === client) {
        this.#client = undefined
        this.#current = undefined
        this.#emit({ name: 'resync' })
      }
    })
  }

  #emit(event: LinkEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#options.logger(
          `un oyente de eventos falló: ${error instanceof Error ? oneLine(error.message, 120) : '?'}`,
        )
      }
    }
  }
}
