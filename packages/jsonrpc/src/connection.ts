import { ErrorCodes, RpcClosedError, RpcError, RpcTimeoutError } from './errors.ts'
import { type JsonRpcId, parseLine } from './messages.ts'

/** Temporizadores inyectados (el paquete no usa `node:*` ni globales de entorno). */
export type Timers = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type IncomingRequest = { id: JsonRpcId; method: string; params: unknown }
export type IncomingNotification = { method: string; params: unknown }

/** Algo anómalo que no rompió la conexión. Los tres primeros cuentan para `maxIssues`. */
export type ProtocolIssue = {
  kind:
    | 'invalid-json'
    | 'invalid-message'
    | 'line-too-large'
    | 'unknown-response'
    | 'duplicate-request-id'
    | 'handler-error'
    | 'write-failed'
  detail: string
}

export type ConnectionOptions = {
  /** Entrega una línea completa (con su `\n` final) al otro extremo. Si lanza, la conexión se cierra. */
  write(line: string): void
  timers: Timers
  /** `'2.0'` (por omisión) añade `"jsonrpc":"2.0"` a lo que se envía; `'omit'` lo deja fuera (Codex). */
  version?: '2.0' | 'omit'
  /** Tope de una línea en caracteres (UTF-16). Una línea mayor se descarta entera. Por omisión 4 Mi. */
  maxLineLength?: number
  /** Plazo por omisión de `request` en ms (0 = sin plazo). Por omisión 30 000. */
  requestTimeoutMs?: number
  /** Solicitudes propias pendientes a la vez. Por omisión 1 024. */
  maxPendingRequests?: number
  /** Solicitudes del otro extremo sin responder a la vez. Por omisión 256. */
  maxInFlightRequests?: number
  /** Líneas hostiles (JSON roto, mensajes inválidos, líneas enormes) toleradas antes de cerrar. Por omisión 100. */
  maxIssues?: number
  /** Atiende una solicitud del otro extremo. Sin atendedor se responde «método no encontrado». */
  onRequest?(request: IncomingRequest): unknown | Promise<unknown>
  onNotification?(notification: IncomingNotification): void
  onIssue?(issue: ProtocolIssue): void
  /** Una sola vez, al cerrarse (por `end`, `close` o exceso de líneas hostiles). */
  onClose?(reason: Error | undefined): void
}

type Pending = {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: unknown
}

const COUNTED: ReadonlySet<ProtocolIssue['kind']> = new Set([
  'invalid-json',
  'invalid-message',
  'line-too-large',
])

/**
 * Extremo de una conexión JSON-RPC 2.0 por líneas (una línea = un mensaje JSON). Es simétrico: envía
 * solicitudes y notificaciones, y recibe solicitudes y notificaciones del otro extremo (cuya respuesta
 * puede tardar: el atendedor devuelve una promesa). El dueño del transporte llama a `feed` con lo que
 * llega (ya decodificado a texto) y a `end` cuando el transporte se cierra.
 *
 * No tiene E/S propia. Garantías: un id propio recibe como mucho una respuesta; una respuesta sin
 * solicitud, repetida o tardía se ignora y se informa; `end`/`close` rechazan todas las pendientes; las
 * respuestas que un atendedor entrega tras el cierre se descartan; la memoria está acotada por los topes.
 */
export class JsonRpcConnection {
  readonly #o: ConnectionOptions
  readonly #maxLine: number
  readonly #pending = new Map<JsonRpcId, Pending>()
  readonly #inFlight = new Set<JsonRpcId>()
  #nextId = 1
  #parts: string[] = []
  #len = 0
  #discarding = false
  #issues = 0
  #closed = false

  constructor(options: ConnectionOptions) {
    this.#o = options
    this.#maxLine = options.maxLineLength ?? 4 * 1024 * 1024
  }

  get closed(): boolean {
    return this.#closed
  }
  /** Solicitudes propias sin respuesta. */
  get pendingCount(): number {
    return this.#pending.size
  }
  /** Solicitudes del otro extremo que aún no se respondieron. */
  get inFlightCount(): number {
    return this.#inFlight.size
  }

  request(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new RpcClosedError())
    if (this.#pending.size >= (this.#o.maxPendingRequests ?? 1024)) {
      return Promise.reject(new RpcError(ErrorCodes.busy, 'demasiadas solicitudes pendientes'))
    }
    const id = this.#nextId++
    return new Promise<unknown>((resolve, reject) => {
      const ms = options.timeoutMs ?? this.#o.requestTimeoutMs ?? 30_000
      const entry: Pending = { method, resolve, reject, timer: undefined }
      if (ms > 0) {
        entry.timer = this.#o.timers.setTimeout(() => {
          if (this.#pending.delete(id)) reject(new RpcTimeoutError(method, ms))
        }, ms)
      }
      this.#pending.set(id, entry)
      this.#write({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown): void {
    this.#write({ method, ...(params === undefined ? {} : { params }) })
  }

  /** Procesa texto recibido del transporte (en trozos arbitrarios). */
  feed(chunk: string): void {
    let start = 0
    while (!this.#closed) {
      const nl = chunk.indexOf('\n', start)
      if (nl === -1) {
        this.#append(chunk.slice(start))
        return
      }
      this.#append(chunk.slice(start, nl))
      this.#endLine()
      start = nl + 1
    }
  }

  /** El transporte se cerró (EOF, proceso muerto). Entrega lo que quedaba y rechaza las pendientes. */
  end(reason?: Error): void {
    if (this.#closed) return
    if (!this.#discarding && this.#len > 0) this.#endLine()
    this.#shutdown(reason)
  }

  /** Cierra desde este lado. Idempotente. El dueño del transporte debe cerrarlo también. */
  close(reason?: Error): void {
    this.#shutdown(reason)
  }

  #shutdown(reason: Error | undefined): void {
    if (this.#closed) return
    this.#closed = true
    this.#parts = []
    this.#len = 0
    const error = new RpcClosedError(reason?.message ?? 'la conexión JSON-RPC se cerró')
    for (const [id, entry] of [...this.#pending]) {
      this.#pending.delete(id)
      this.#o.timers.clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#inFlight.clear()
    this.#o.onClose?.(reason)
  }

  #issue(issue: ProtocolIssue): void {
    this.#o.onIssue?.(issue)
    if (COUNTED.has(issue.kind) && ++this.#issues > (this.#o.maxIssues ?? 100)) {
      this.#shutdown(new Error('demasiados mensajes inválidos del otro extremo'))
    }
  }

  #append(piece: string): void {
    if (this.#discarding || piece === '') return
    this.#len += piece.length
    if (this.#len > this.#maxLine) {
      this.#discarding = true
      this.#parts = []
      this.#len = 0
      this.#issue({ kind: 'line-too-large', detail: `línea de más de ${this.#maxLine} caracteres` })
      return
    }
    this.#parts.push(piece)
  }

  #endLine(): void {
    if (this.#discarding) {
      this.#discarding = false
      return
    }
    const line = this.#parts.join('').replace(/\r$/, '')
    this.#parts = []
    this.#len = 0
    if (line.trim() === '') return
    this.#handle(line)
  }

  #handle(line: string): void {
    const parsed = parseLine(line)
    if (!parsed.ok) {
      this.#issue({ kind: parsed.reason, detail: parsed.detail })
      return
    }
    const m = parsed.message
    switch (m.kind) {
      case 'response': {
        const entry = this.#settle(m.id)
        if (entry === undefined) {
          this.#issue({ kind: 'unknown-response', detail: `id ${String(m.id)}` })
        } else entry.resolve(m.result)
        return
      }
      case 'error': {
        const entry = this.#settle(m.id)
        if (entry === undefined) {
          this.#issue({ kind: 'unknown-response', detail: `id ${String(m.id)}` })
        } else entry.reject(new RpcError(m.error.code, m.error.message, m.error.data))
        return
      }
      case 'notification':
        try {
          this.#o.onNotification?.({ method: m.method, params: m.params })
        } catch (error) {
          this.#issue({ kind: 'handler-error', detail: errorText(error) })
        }
        return
      case 'request':
        this.#serve({ id: m.id, method: m.method, params: m.params })
    }
  }

  #settle(id: JsonRpcId): Pending | undefined {
    const entry = this.#pending.get(id)
    if (entry === undefined) return undefined
    this.#pending.delete(id)
    this.#o.timers.clearTimeout(entry.timer)
    return entry
  }

  #serve(request: IncomingRequest): void {
    const { id } = request
    if (this.#inFlight.has(id)) {
      this.#issue({ kind: 'duplicate-request-id', detail: `id ${String(id)} repetido` })
      this.#error(id, ErrorCodes.invalidRequest, 'id repetido')
      return
    }
    if (this.#inFlight.size >= (this.#o.maxInFlightRequests ?? 256)) {
      this.#error(id, ErrorCodes.busy, 'demasiadas solicitudes a la vez')
      return
    }
    const handler = this.#o.onRequest
    if (handler === undefined) {
      this.#error(id, ErrorCodes.methodNotFound, `método no soportado: ${request.method}`)
      return
    }
    this.#inFlight.add(id)
    let result: unknown
    try {
      result = handler(request)
    } catch (error) {
      this.#fail(id, error)
      return
    }
    if (isPromiseLike(result)) {
      result.then(
        (value) => this.#succeed(id, value),
        (error: unknown) => this.#fail(id, error),
      )
    } else {
      this.#succeed(id, result)
    }
  }

  #succeed(id: JsonRpcId, value: unknown): void {
    // Tras el cierre `inFlight` está vacío: la respuesta tardía de un atendedor se descarta.
    if (this.#inFlight.delete(id)) this.#write({ id, result: value === undefined ? null : value })
  }

  #fail(id: JsonRpcId, error: unknown): void {
    if (!this.#inFlight.delete(id)) return
    if (error instanceof RpcError) {
      this.#error(id, error.code, error.message, error.data)
    } else {
      this.#issue({ kind: 'handler-error', detail: errorText(error) })
      this.#error(id, ErrorCodes.internalError, 'error interno')
    }
  }

  #error(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.#write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }

  #write(message: Record<string, unknown>): void {
    if (this.#closed) return
    const body = this.#o.version === 'omit' ? message : { jsonrpc: '2.0', ...message }
    try {
      this.#o.write(`${JSON.stringify(body)}\n`)
    } catch (error) {
      this.#issue({ kind: 'write-failed', detail: errorText(error) })
      this.#shutdown(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
