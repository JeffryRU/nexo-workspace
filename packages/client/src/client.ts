import {
  type EventData,
  type EventName,
  LIMITS,
  type MethodName,
  type MethodParams,
  type MethodResult,
  parseRequestValue,
  parseResult,
  parseServerMessage,
  utf8ByteLength,
} from '@nexo/contracts'
import { type BackoffOptions, backoffDelay } from './backoff.ts'
import { NexoClientError } from './errors.ts'
import type { Transport, TransportFactory } from './transport.ts'

export type ClientState = 'connecting' | 'open' | 'reconnecting' | 'closed'
export type ResyncReason = 'gap' | 'backpressure' | 'reconnect'
export type ResyncInfo = { reason: ResyncReason; expected?: number; got?: number; dropped?: number }
export type Snapshot = MethodResult<'snapshot'>

export type ReconnectOptions = BackoffOptions & {
  /** Intentos fallidos seguidos antes de rendirse y cerrar (infinito por omisión). */
  maxAttempts?: number
  /** Una conexión abierta al menos este tiempo reinicia el backoff (ms). */
  stableMs?: number
}

export type ClientOptions = {
  transport: TransportFactory
  /** Tiempo máximo por llamada (ms). 10 s por omisión. */
  callTimeoutMs?: number
  /** `false` desactiva la reconexión. */
  reconnect?: false | Partial<ReconnectOptions>
  /** Ante un `resync` pide `snapshot` y lo entrega a `onSnapshot`. */
  autoResync?: boolean
  onSnapshot?: (snapshot: Snapshot, info: ResyncInfo) => void
  /** Recibe líneas ya redactadas (sin el token). */
  logger?: (level: 'debug' | 'warn' | 'error', message: string) => void
  random?: () => number
}

export type CallOptions = { timeoutMs?: number; signal?: AbortSignal }

type EventHandler<E extends EventName> = (data: EventData<E>, seq: number) => void
type AnyHandler = (...args: never[]) => void

type Pending = {
  method: MethodName
  resolve: (value: unknown) => void
  reject: (error: NexoClientError) => void
  cleanup: () => void
}

const DEFAULT_RECONNECT: ReconnectOptions = { baseMs: 250, maxMs: 15_000, stableMs: 5_000 }

export class NexoClient {
  readonly #options: ClientOptions
  readonly #reconnect: ReconnectOptions | undefined
  readonly #pending = new Map<string, Pending>()
  readonly #handlers = new Map<string, Set<AnyHandler>>()
  readonly #secrets = new Set<string>()
  #state: ClientState = 'connecting'
  #transport: Transport | undefined
  #ready = false
  #closing = false
  #nextId = 0
  #lastSeq: number | undefined
  #subscription: { events?: EventName[] } | undefined
  #attempt = 0
  #openedAt = 0
  #resyncing = false
  #connectPromise: Promise<void> | undefined
  #abortHandshake: ((error: NexoClientError) => void) | undefined
  #sleeper: { timer: ReturnType<typeof setTimeout>; wake: () => void } | undefined

  constructor(options: ClientOptions) {
    this.#options = options
    this.#reconnect =
      options.reconnect === false ? undefined : { ...DEFAULT_RECONNECT, ...options.reconnect }
  }

  get state(): ClientState {
    return this.#state
  }

  /** Abre la primera conexión. Si falla, el cliente queda cerrado y la promesa rechaza. */
  connect(): Promise<void> {
    this.#connectPromise ??= this.#establish().then(
      () => {},
      (error: unknown) => {
        this.#terminate()
        throw error
      },
    )
    return this.#connectPromise
  }

  /** Cierre definitivo: no reconecta; las llamadas pendientes fallan con `CLOSED`. */
  close(): void {
    this.#terminate()
  }

  /** Llamada tipada al daemon: valida `params` antes de enviar y el resultado al recibirlo. */
  call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options: CallOptions = {},
  ): Promise<MethodResult<M>> {
    if (this.#state === 'closed') {
      return Promise.reject(new NexoClientError('CLOSED', 'el cliente está cerrado'))
    }
    if (!this.#ready) {
      return Promise.reject(new NexoClientError('DISCONNECTED', 'sin conexión con el daemon'))
    }
    return this.#request(method, params, options)
  }

  /** Suscribe a eventos (todos si se omite la lista) y recuerda la suscripción al reconectar. */
  async subscribe(events?: EventName[]): Promise<MethodResult<'events.subscribe'>> {
    const params = events === undefined ? {} : { events }
    const result = await this.call('events.subscribe', params)
    this.#subscription = params
    this.#lastSeq = result.seq
    return result
  }

  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void
  on(event: 'resync', handler: (info: ResyncInfo) => void): () => void
  on(event: 'state', handler: (state: ClientState) => void): () => void
  on(event: 'error', handler: (error: NexoClientError) => void): () => void
  on(event: string, handler: AnyHandler): () => void {
    let set = this.#handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.#handlers.set(event, set)
    }
    set.add(handler)
    return () => {
      this.#handlers.get(event)?.delete(handler)
    }
  }

  // ---- internos ----

  #emit(event: string, ...args: unknown[]): void {
    const set = this.#handlers.get(event)
    if (set === undefined) return
    for (const handler of [...set]) {
      try {
        ;(handler as (...a: unknown[]) => void)(...args)
      } catch (error) {
        this.#log('error', `un manejador de "${event}" lanzó: ${String(error)}`)
      }
    }
  }

  #log(level: 'debug' | 'warn' | 'error', message: string): void {
    const sink = this.#options.logger
    if (sink === undefined) return
    let text = message.replace(/nexo\.token\.[^\s,]+/g, 'nexo.token.[redactado]')
    for (const secret of this.#secrets) text = text.split(secret).join('[redactado]')
    try {
      sink(level, text)
    } catch {
      // un logger defectuoso no debe romper el cliente
    }
  }

  #reportError(error: NexoClientError): void {
    this.#log('warn', `${error.code}: ${error.message}`)
    this.#emit('error', error)
  }

  #setState(state: ClientState): void {
    if (this.#state === state) return
    this.#state = state
    this.#emit('state', state)
  }

  #failPending(code: 'DISCONNECTED' | 'CLOSED', message: string): void {
    for (const [id, p] of [...this.#pending]) {
      this.#pending.delete(id)
      p.cleanup()
      p.reject(new NexoClientError(code, message))
    }
  }

  #terminate(): void {
    this.#closing = true
    this.#ready = false
    this.#wake()
    this.#abortHandshake?.(new NexoClientError('CLOSED', 'el cliente se cerró'))
    const transport = this.#transport
    this.#transport = undefined
    try {
      transport?.close()
    } catch {
      // ya cerrado
    }
    this.#failPending('CLOSED', 'el cliente se cerró')
    this.#setState('closed')
  }

  #wake(): void {
    const s = this.#sleeper
    if (s === undefined) return
    clearTimeout(s.timer)
    this.#sleeper = undefined
    s.wake()
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#sleeper = { timer: setTimeout(() => this.#wake(), ms), wake: resolve }
    })
  }

  async #establish(): Promise<void> {
    let transport: Transport
    try {
      transport = await this.#options.transport()
    } catch (error) {
      throw new NexoClientError('DISCONNECTED', `no se pudo crear el transporte: ${String(error)}`)
    }
    if (transport.token !== undefined) this.#secrets.add(transport.token)
    if (this.#closing) {
      transport.close()
      throw new NexoClientError('CLOSED', 'el cliente se cerró')
    }
    this.#transport = transport
    transport.onMessage((text) => {
      if (this.#transport === transport) this.#onMessage(text)
    })
    transport.onClose((info) => {
      if (this.#transport === transport) this.#onClose(info.code)
    })

    const aborted = new Promise<never>((_, reject) => {
      this.#abortHandshake = reject
    })
    aborted.catch(() => {})
    try {
      await Promise.race([this.#handshake(transport), aborted])
    } catch (error) {
      if (this.#transport === transport) this.#transport = undefined
      try {
        transport.close()
      } catch {
        // ya cerrado
      }
      this.#failPending('DISCONNECTED', 'la conexión no se completó')
      throw error instanceof NexoClientError
        ? error
        : new NexoClientError('DISCONNECTED', 'no se pudo conectar con el daemon')
    } finally {
      this.#abortHandshake = undefined
    }
  }

  async #handshake(transport: Transport): Promise<void> {
    await transport.connect()
    this.#assertOpen()
    if (transport.authMode === 'message' && transport.token !== undefined) {
      await this.#request('auth', { token: transport.token }, {})
    }
    if (this.#subscription !== undefined) {
      const result = await this.#request('events.subscribe', this.#subscription, {})
      this.#lastSeq = result.seq
    } else {
      this.#lastSeq = undefined
    }
    this.#assertOpen()
    this.#ready = true
    this.#openedAt = Date.now()
    this.#setState('open')
  }

  #assertOpen(): void {
    if (this.#closing) throw new NexoClientError('CLOSED', 'el cliente se cerró')
  }

  #onClose(code: number | undefined): void {
    this.#log('debug', `conexión cerrada${code === undefined ? '' : ` (${code})`}`)
    if (!this.#ready) {
      // Cierre durante el handshake: #establish rechaza y limpia.
      this.#abortHandshake?.(new NexoClientError('DISCONNECTED', 'la conexión se cerró'))
      return
    }
    this.#ready = false
    this.#transport = undefined
    this.#failPending('DISCONNECTED', 'se perdió la conexión')
    if (this.#closing) return
    if (this.#reconnect === undefined) {
      this.#terminate()
      return
    }
    if (Date.now() - this.#openedAt >= (this.#reconnect.stableMs ?? 5_000)) this.#attempt = 0
    void this.#reconnectLoop(this.#reconnect)
  }

  async #reconnectLoop(options: ReconnectOptions): Promise<void> {
    this.#setState('reconnecting')
    let failures = 0
    while (!this.#closing) {
      const delay = backoffDelay(this.#attempt++, options, this.#options.random)
      this.#log('debug', `reconectando en ${Math.round(delay)} ms`)
      await this.#sleep(delay)
      if (this.#closing) return
      try {
        await this.#establish()
        void this.#resync({ reason: 'reconnect' })
        return
      } catch (error) {
        if (this.#closing) return
        failures++
        this.#log('debug', `intento de reconexión fallido: ${String(error)}`)
        if (options.maxAttempts !== undefined && failures >= options.maxAttempts) {
          this.#terminate()
          return
        }
      }
    }
  }

  async #resync(info: ResyncInfo): Promise<void> {
    this.#emit('resync', info)
    if (this.#options.autoResync !== true || this.#resyncing) return
    this.#resyncing = true
    try {
      const snapshot = await this.call('snapshot', {})
      this.#lastSeq = snapshot.seq
      this.#options.onSnapshot?.(snapshot, info)
    } catch (error) {
      this.#log('warn', `no se pudo resincronizar: ${String(error)}`)
    } finally {
      this.#resyncing = false
    }
  }

  #request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options: CallOptions,
  ): Promise<MethodResult<M>> {
    const transport = this.#transport
    if (transport === undefined) {
      return Promise.reject(new NexoClientError('DISCONNECTED', 'sin conexión con el daemon'))
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new NexoClientError('ABORTED', 'llamada cancelada'))
    }
    const id = `c${++this.#nextId}`
    const parsed = parseRequestValue({ v: 1, id, method, params })
    if (!parsed.ok) {
      return Promise.reject(new NexoClientError(parsed.error.code, parsed.error.message))
    }
    const text = JSON.stringify(parsed.value)
    if (utf8ByteLength(text) > LIMITS.maxMessageBytes) {
      return Promise.reject(
        new NexoClientError('PAYLOAD_TOO_LARGE', 'la petición supera el tamaño máximo'),
      )
    }
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.#options.callTimeoutMs ?? 10_000
      const onAbort = () => this.#fail(id, new NexoClientError('ABORTED', 'llamada cancelada'))
      const timer = setTimeout(
        () =>
          this.#fail(
            id,
            new NexoClientError('TIMEOUT', `${method} no respondió en ${timeoutMs} ms`),
          ),
        timeoutMs,
      )
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
        },
      })
      try {
        transport.send(text)
      } catch {
        this.#fail(id, new NexoClientError('DISCONNECTED', 'no se pudo enviar'))
      }
    })
  }

  #fail(id: string, error: NexoClientError): void {
    const p = this.#pending.get(id)
    if (p === undefined) return
    this.#pending.delete(id)
    p.cleanup()
    p.reject(error)
  }

  #succeed(id: string, value: unknown): void {
    const p = this.#pending.get(id)
    if (p === undefined) return
    this.#pending.delete(id)
    p.cleanup()
    p.resolve(value)
  }

  #onMessage(text: string): void {
    const parsed = parseServerMessage(text)
    if (!parsed.ok) {
      if (parsed.id !== undefined && this.#pending.has(parsed.id)) {
        this.#fail(
          parsed.id,
          new NexoClientError('INVALID_RESPONSE', `respuesta inválida: ${parsed.error.message}`),
        )
      } else if (parsed.error.code !== 'NOT_FOUND') {
        // NOT_FOUND = evento de un daemon más nuevo: se ignora (compatibilidad hacia delante).
        this.#reportError(
          new NexoClientError('INVALID_RESPONSE', `mensaje descartado: ${parsed.error.message}`),
        )
      }
      return
    }
    const message = parsed.value
    if ('event' in message) {
      this.#onEvent(message.event, message.seq, message.data)
      return
    }
    const pending = this.#pending.get(message.id)
    if (pending === undefined) {
      this.#log('debug', 'respuesta con id desconocido descartada')
      return
    }
    if (!message.ok) {
      this.#fail(
        message.id,
        new NexoClientError(message.error.code, message.error.message, message.error.data),
      )
      return
    }
    const result = parseResult(pending.method, message.result)
    if (!result.ok) {
      this.#fail(
        message.id,
        new NexoClientError('INVALID_RESPONSE', `resultado inválido: ${result.error.message}`),
      )
      return
    }
    this.#succeed(message.id, result.value)
  }

  #onEvent(event: EventName, seq: number, data: unknown): void {
    const last = this.#lastSeq
    if (last !== undefined && seq <= last) {
      this.#log('debug', `evento ${event} con seq ${seq} repetido o desordenado descartado`)
      return
    }
    this.#lastSeq = seq
    if (last !== undefined && seq > last + 1) {
      void this.#resync({ reason: 'gap', expected: last + 1, got: seq })
    }
    this.#emit(event, data, seq)
    if (event === 'client.resync') {
      const dropped = (data as { dropped?: number }).dropped
      void this.#resync({ reason: 'backpressure', ...(dropped === undefined ? {} : { dropped }) })
    }
  }
}
