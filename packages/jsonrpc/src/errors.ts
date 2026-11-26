/** Códigos de error reservados por JSON-RPC 2.0. */
export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Rango de errores del servidor (-32000 a -32099): demasiadas solicitudes a la vez. */
  busy: -32000,
} as const

/** Error devuelto por el otro extremo, o que un atendedor lanza para responder con un código concreto. */
export class RpcError extends Error {
  readonly code: number
  readonly data?: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/** La solicitud no recibió respuesta a tiempo. */
export class RpcTimeoutError extends Error {
  readonly method: string
  constructor(method: string, ms: number) {
    super(`«${method}» no respondió en ${ms} ms`)
    this.name = 'RpcTimeoutError'
    this.method = method
  }
}

/** La conexión se cerró (o ya estaba cerrada) antes de recibir la respuesta. */
export class RpcClosedError extends Error {
  constructor(message = 'la conexión JSON-RPC está cerrada') {
    super(message)
    this.name = 'RpcClosedError'
  }
}
