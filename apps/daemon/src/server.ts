import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  type ErrorBody,
  EVENT_NAMES,
  type EventData,
  type EventName,
  LIMITS,
  type MethodParams,
  type MethodResult,
  parseRequest,
} from '@nexo/contracts'
import type { BusEvent, Dispatcher, EventBusPort, LoggerPort } from '@nexo/core'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'
import { parseSubprotocols, SUBPROTOCOL, tokensEqual } from './auth.ts'
import { isHostAllowed, isOriginAllowed } from './origin.ts'
import { DAEMON_HEADER } from './probe.ts'
import { RateLimiter } from './rate-limiter.ts'
import { createStaticHandler, sendText } from './static.ts'

/** `id` de las respuestas a mensajes sin `id` legible (JSON roto, binario...). */
export const UNKNOWN_REQUEST_ID = '0'

export type ConnectionHooks = {
  subscribe: (params: MethodParams<'events.subscribe'>) => MethodResult<'events.subscribe'>
  currentSeq: () => number
}

export type ServerOptions = {
  port: number
  token: string
  version: string
  dev: boolean
  webRoot?: string | undefined
  logger: LoggerPort
  bus: EventBusPort
  /** Crea el despachador de una conexión (`events.subscribe` y `snapshot` dependen de ella). */
  createDispatcher: (hooks: ConnectionHooks) => Dispatcher
  maxConnections?: number
  maxMessageBytes?: number
  authTimeoutMs?: number
  rate?: { max: number; windowMs: number }
  /** Sobre este `bufferedAmount` se descartan los `terminal.output` del cliente. */
  softBufferBytes?: number
  /** Sobre este `bufferedAmount` se corta la conexión. */
  hardBufferBytes?: number
  /** Tras tantos mensajes abusivos (binarios, demasiado grandes) se cierra la conexión. */
  maxStrikes?: number
}

type RuntimeLimits = {
  maxMessageBytes: number
  authTimeoutMs: number
  rate: { max: number; windowMs: number }
  softBufferBytes: number
  hardBufferBytes: number
  maxStrikes: number
}

export type ServerStats = {
  connections: number
  authenticated: number
  /** Mayor `bufferedAmount` entre los clientes conectados ahora mismo. */
  maxBuffered: number
  droppedOutputEvents: number
}

const ALL_EVENTS: ReadonlySet<EventName> = new Set<EventName>(EVENT_NAMES)

function guessId(text: string): string {
  const m = /"id"\s*:\s*"([^"\\]{1,128})"/.exec(text.slice(0, 1024))
  return m?.[1] ?? UNKNOWN_REQUEST_ID
}

class Connection {
  readonly ws: WebSocket
  authed: boolean
  seq = 0
  filter: ReadonlySet<EventName> | undefined
  dropped = 0
  strikes = 0
  readonly #server: DaemonServer
  readonly #limiter: RateLimiter
  readonly #dispatch: Dispatcher
  #authTimer: NodeJS.Timeout | undefined
  #resyncTimer: NodeJS.Timeout | undefined

  constructor(server: DaemonServer, ws: WebSocket, authed: boolean) {
    this.#server = server
    this.ws = ws
    this.authed = authed
    const limits = server.limits
    this.#limiter = new RateLimiter(limits.rate.max, limits.rate.windowMs)
    this.#dispatch = server.options.createDispatcher({
      subscribe: (params) => {
        this.filter = params.events === undefined ? ALL_EVENTS : new Set(params.events)
        return { seq: this.seq }
      },
      currentSeq: () => this.seq,
    })
    if (!authed) {
      this.#authTimer = setTimeout(() => this.close(1008, 'auth timeout'), limits.authTimeoutMs)
      this.#authTimer.unref()
    }
    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary))
    ws.on('close', () => this.dispose())
    ws.on('error', (error) => {
      server.options.logger.debug('error de websocket', { error: error.message })
    })
  }

  dispose(): void {
    clearTimeout(this.#authTimer)
    clearInterval(this.#resyncTimer)
    this.#resyncTimer = undefined
    this.#server.forget(this)
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(code, reason)
    // Si el cliente no completa el cierre, se corta.
    const t = setTimeout(() => this.ws.terminate(), 1000)
    t.unref()
  }

  reply(
    id: string,
    outcome: { ok: true; result: unknown } | { ok: false; error: ErrorBody },
  ): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    const body = outcome.ok
      ? { v: 1, id, ok: true, result: outcome.result }
      : { v: 1, id, ok: false, error: outcome.error }
    this.ws.send(JSON.stringify(body))
  }

  fail(id: string, code: ErrorBody['code'], message: string): void {
    this.reply(id, { ok: false, error: { code, message } })
  }

  deliver(event: BusEvent): void {
    if (!this.authed || this.filter === undefined || !this.filter.has(event.event)) return
    this.seq++
    const buffered = this.ws.bufferedAmount
    const limits = this.#server.limits
    if (buffered > limits.hardBufferBytes) {
      this.#server.options.logger.warn('cliente demasiado lento: conexión cortada')
      this.ws.terminate()
      return
    }
    if (event.event === 'terminal.output' && buffered > limits.softBufferBytes) {
      // El hueco en `seq` queda a la vista del cliente; `client.resync` se envía al vaciarse el búfer.
      this.dropped++
      this.#server.noteDropped()
      this.#armResync()
      return
    }
    this.#sendEvent(this.seq, event.event, event.data)
  }

  #sendEvent(seq: number, name: EventName, data: unknown): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(JSON.stringify({ v: 1, event: name, seq, data }))
  }

  #armResync(): void {
    if (this.#resyncTimer !== undefined) return
    this.#resyncTimer = setInterval(() => {
      if (this.ws.readyState !== this.ws.OPEN) return this.dispose()
      if (this.ws.bufferedAmount > this.#server.limits.softBufferBytes / 2) return
      clearInterval(this.#resyncTimer)
      this.#resyncTimer = undefined
      const dropped = this.dropped
      this.dropped = 0
      const data: EventData<'client.resync'> = { reason: 'backpressure', dropped }
      if (this.filter?.has('client.resync')) this.#sendEvent(++this.seq, 'client.resync', data)
    }, 25)
    this.#resyncTimer.unref()
  }

  #strike(code: number, reason: string): void {
    if (++this.strikes >= this.#server.limits.maxStrikes) this.close(code, reason)
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    const verdict = this.#limiter.take()
    if (verdict === 'abuse') {
      this.close(1008, 'rate limit')
      return
    }
    if (isBinary) {
      this.fail(UNKNOWN_REQUEST_ID, 'INVALID_PARAMS', 'el mensaje debe ser texto')
      this.#strike(1003, 'binary frames not supported')
      return
    }
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as Buffer).toString('utf8')
    if (verdict === 'limited') {
      this.fail(guessId(text), 'RATE_LIMITED', 'demasiados mensajes')
      return
    }
    const parsed = parseRequest(text, { maxBytes: this.#server.limits.maxMessageBytes })
    if (!parsed.ok) {
      this.fail(parsed.id ?? guessId(text), parsed.error.code, parsed.error.message)
      if (parsed.error.code === 'PAYLOAD_TOO_LARGE') this.#strike(1009, 'message too big')
      if (!this.authed) this.close(1008, 'unauthorized')
      return
    }
    const request = parsed.value
    if (!this.authed) {
      if (
        request.method === 'auth' &&
        tokensEqual(this.#server.options.token, request.params.token)
      ) {
        this.authed = true
        clearTimeout(this.#authTimer)
        this.reply(request.id, { ok: true, result: {} })
        return
      }
      this.fail(request.id, 'UNAUTHORIZED', 'autenticación requerida')
      this.close(1008, 'unauthorized')
      return
    }
    void this.#dispatch({ method: request.method, params: request.params } as never).then(
      (outcome) => this.reply(request.id, outcome),
      () => this.fail(request.id, 'INTERNAL', 'error interno'),
    )
  }
}

export class DaemonServer {
  readonly options: ServerOptions
  readonly limits: RuntimeLimits
  readonly #http: Server
  readonly #wss: WebSocketServer
  readonly #connections = new Set<Connection>()
  readonly #static: ReturnType<typeof createStaticHandler>
  readonly #maxConnections: number
  #unsubscribe: (() => void) | undefined
  #port = 0
  #droppedTotal = 0

  constructor(options: ServerOptions) {
    this.options = options
    this.limits = {
      maxMessageBytes: options.maxMessageBytes ?? LIMITS.maxMessageBytes,
      authTimeoutMs: options.authTimeoutMs ?? 5000,
      rate: options.rate ?? { max: 1000, windowMs: 1000 },
      softBufferBytes: options.softBufferBytes ?? 1024 * 1024,
      hardBufferBytes: options.hardBufferBytes ?? 16 * 1024 * 1024,
      maxStrikes: options.maxStrikes ?? 3,
    }
    this.#maxConnections = options.maxConnections ?? 128
    this.#static = createStaticHandler(options.webRoot)
    this.#http = createServer((req, res) => void this.#onHttp(req, res))
    // El margen sobre el tope permite responder PAYLOAD_TOO_LARGE; más allá `ws` cierra con 1009.
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.maxMessageBytes * 2,
      perMessageDeflate: false,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    })
    this.#http.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head))
    this.#http.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      else socket.destroy()
    })
  }

  get port(): number {
    return this.#port
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.#http.once('error', onError)
      this.#http.listen(this.options.port, '127.0.0.1', () => {
        this.#http.off('error', onError)
        const address = this.#http.address()
        this.#port = typeof address === 'object' && address !== null ? address.port : 0
        this.#unsubscribe = this.options.bus.subscribe((event) => {
          for (const c of this.#connections) c.deliver(event)
        })
        resolve(this.#port)
      })
    })
  }

  stats(): ServerStats {
    let maxBuffered = 0
    let authenticated = 0
    for (const c of this.#connections) {
      maxBuffered = Math.max(maxBuffered, c.ws.bufferedAmount)
      if (c.authed) authenticated++
    }
    return {
      connections: this.#connections.size,
      authenticated,
      maxBuffered,
      droppedOutputEvents: this.#droppedTotal,
    }
  }

  noteDropped(): void {
    this.#droppedTotal++
  }

  forget(connection: Connection): void {
    this.#connections.delete(connection)
  }

  async close(): Promise<void> {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    for (const c of [...this.#connections]) {
      c.ws.terminate()
      c.dispose()
    }
    this.#wss.close()
    await new Promise<void>((resolve) => {
      if (!this.#http.listening) return resolve()
      this.#http.close(() => resolve())
      this.#http.closeAllConnections()
    })
  }

  async #onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isHostAllowed(req.headers.host, this.#port)) {
        return sendText(res, 403, 'host no permitido')
      }
      const path = (req.url ?? '/').split(/[?#]/, 1)[0]
      if (path === '/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendText(res, 405, 'método no permitido')
        }
        res.setHeader(DAEMON_HEADER, '1')
        return sendText(
          res,
          200,
          JSON.stringify({ ok: true, version: this.options.version }),
          'application/json; charset=utf-8',
        )
      }
      if (!(await this.#static(req, res))) sendText(res, 404, 'no encontrado')
    } catch {
      if (!res.headersSent) sendText(res, 500, 'error interno')
      else res.destroy()
    }
  }

  #reject(socket: Duplex, status: string, why: string): undefined {
    this.options.logger.warn('conexión rechazada', { status, why })
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): undefined {
    socket.on('error', () => socket.destroy())
    const path = (req.url ?? '/').split(/[?#]/, 1)[0]
    if (path !== '/' && path !== '/ws') return this.#reject(socket, '404 Not Found', 'ruta')
    if (!isHostAllowed(req.headers.host, this.#port)) {
      return this.#reject(socket, '403 Forbidden', 'host')
    }
    const origin = req.headers.origin
    if (!isOriginAllowed(origin, this.options.dev)) {
      return this.#reject(socket, '403 Forbidden', `origin ${String(origin).slice(0, 100)}`)
    }
    if (this.#connections.size >= this.#maxConnections) {
      return this.#reject(socket, '503 Service Unavailable', 'demasiadas conexiones')
    }
    const header = req.headers['sec-websocket-protocol']
    const offer = parseSubprotocols(header)
    if (header !== undefined && (!offer.versionOffered || offer.tokenCount > 1)) {
      return this.#reject(socket, '400 Bad Request', 'subprotocolo')
    }
    let authed = false
    if (offer.token !== undefined) {
      if (!tokensEqual(this.options.token, offer.token)) {
        return this.#reject(socket, '401 Unauthorized', 'token')
      }
      authed = true
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.#connections.add(new Connection(this, ws, authed))
    })
    return undefined
  }
}
