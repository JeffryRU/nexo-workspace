/** Interfaz mínima de transporte: el cliente solo conoce esto (permite un transporte falso en pruebas). */
export interface Transport {
  /** Abre la conexión. Debe rechazar si no se puede abrir o si se cierra antes de abrir. */
  connect(): Promise<void>
  send(text: string): void
  close(): void
  onMessage(handler: (text: string) => void): void
  onClose(handler: (info: { code?: number; reason?: string }) => void): void
  /** Token de la conexión: el cliente lo redacta de sus logs y, con `authMode: 'message'`, lo envía en `auth`. */
  readonly token?: string | undefined
  readonly authMode?: 'subprotocol' | 'message' | undefined
}

export type TransportFactory = () => Transport | Promise<Transport>

type WsEvent = { data?: unknown; code?: number; reason?: string }
export type WebSocketLike = {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: WsEvent) => void): void
}
export type WebSocketConstructor = new (url: string, protocols?: string[]) => WebSocketLike

export type WebSocketTransportOptions = {
  /** `ws://` o `wss://`. */
  url: string
  token?: string
  /** `subprotocol` (por omisión) envía el token en `Sec-WebSocket-Protocol`; `message` usa el mensaje `auth`. */
  auth?: 'subprotocol' | 'message'
  /** `globalThis.WebSocket` por omisión (navegador, WebView y Node 24). */
  WebSocket?: WebSocketConstructor
  connectTimeoutMs?: number
}

export const SUBPROTOCOL = 'nexo.v1'

export function webSocketTransport(options: WebSocketTransportOptions): Transport {
  const url = new URL(options.url)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError('la URL debe usar ws:// o wss://')
  }
  const Impl = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
  if (Impl === undefined) throw new Error('este entorno no tiene WebSocket')
  const authMode = options.auth ?? 'subprotocol'
  const token = options.token
  const protocols =
    authMode === 'subprotocol' && token !== undefined
      ? [SUBPROTOCOL, `nexo.token.${token}`]
      : [SUBPROTOCOL]
  const timeoutMs = options.connectTimeoutMs ?? 10_000

  let ws: WebSocketLike | undefined
  let opened = false
  let messageHandler: (text: string) => void = () => {}
  let closeHandler: (info: { code?: number; reason?: string }) => void = () => {}
  let closed = false

  const fireClose = (info: { code?: number; reason?: string }) => {
    if (closed) return
    closed = true
    closeHandler(info)
  }

  return {
    ...(token === undefined ? {} : { token }),
    authMode,
    connect() {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('tiempo agotado al conectar'))
          ws?.close()
        }, timeoutMs)
        let socket: WebSocketLike
        try {
          socket = new Impl(options.url, protocols)
        } catch {
          clearTimeout(timer)
          // El mensaje de la implementación puede incluir los subprotocolos, es decir, el token.
          reject(new Error('no se pudo abrir el WebSocket'))
          return
        }
        ws = socket
        socket.addEventListener('open', () => {
          clearTimeout(timer)
          opened = true
          resolve()
        })
        socket.addEventListener('message', (event) => {
          if (typeof event.data === 'string') messageHandler(event.data)
        })
        socket.addEventListener('error', () => {
          if (!opened) {
            clearTimeout(timer)
            reject(new Error('no se pudo conectar'))
          }
        })
        socket.addEventListener('close', (event) => {
          clearTimeout(timer)
          if (!opened) reject(new Error('conexión rechazada o cerrada antes de abrir'))
          fireClose({
            ...(event.code === undefined ? {} : { code: event.code }),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          })
        })
      })
    },
    send(text) {
      if (ws === undefined) throw new Error('transporte no conectado')
      ws.send(text)
    },
    close() {
      try {
        ws?.close(1000)
      } catch {
        // ya cerrado
      }
    },
    onMessage(handler) {
      messageHandler = handler
    },
    onClose(handler) {
      closeHandler = handler
    },
  }
}
