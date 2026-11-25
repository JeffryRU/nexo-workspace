import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectWebSocket } from './index.ts'
import { type WebSocketConstructor, type WebSocketLike, webSocketTransport } from './transport.ts'

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []
  static mode: 'open' | 'error' | 'close' | 'hang' | 'throw' = 'open'
  readonly listeners = new Map<string, Listener[]>()
  readonly sent: string[] = []
  closedWith: number | undefined
  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    if (FakeWebSocket.mode === 'throw') {
      throw new SyntaxError(`protocolo inválido ${protocols?.join(',')}`)
    }
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (FakeWebSocket.mode === 'open') this.emit('open', {})
      if (FakeWebSocket.mode === 'error') this.emit('error', {})
      if (FakeWebSocket.mode === 'close') this.emit('close', { code: 1006 })
    })
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, event: { data?: unknown; code?: number; reason?: string }): void {
    for (const l of this.listeners.get(type) ?? []) l(event)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(code?: number): void {
    this.closedWith = code
  }
}
const Impl = FakeWebSocket as unknown as WebSocketConstructor

afterEach(() => {
  FakeWebSocket.instances = []
  FakeWebSocket.mode = 'open'
  vi.useRealTimers()
})

describe('webSocketTransport', () => {
  it('envía el token por subprotocolo por omisión', async () => {
    const t = webSocketTransport({ url: 'ws://127.0.0.1:1/', token: 'abc', WebSocket: Impl })
    await t.connect()
    expect(FakeWebSocket.instances[0]?.protocols).toEqual(['nexo.v1', 'nexo.token.abc'])
    expect(t.authMode).toBe('subprotocol')
  })

  it('en modo message solo ofrece nexo.v1 y expone el token al cliente', async () => {
    const t = webSocketTransport({
      url: 'ws://127.0.0.1:1/',
      token: 'abc',
      auth: 'message',
      WebSocket: Impl,
    })
    await t.connect()
    expect(FakeWebSocket.instances[0]?.protocols).toEqual(['nexo.v1'])
    expect(t.token).toBe('abc')
    expect(t.authMode).toBe('message')
  })

  it('sin token ofrece solo nexo.v1', async () => {
    const t = webSocketTransport({ url: 'ws://127.0.0.1:1/', WebSocket: Impl })
    await t.connect()
    expect(FakeWebSocket.instances[0]?.protocols).toEqual(['nexo.v1'])
    expect(t.token).toBeUndefined()
  })

  it('entrega mensajes de texto, ignora binarios y reporta el cierre una vez', async () => {
    const t = webSocketTransport({ url: 'ws://127.0.0.1:1/', WebSocket: Impl })
    const got: string[] = []
    const closes: unknown[] = []
    t.onMessage((m) => got.push(m))
    t.onClose((i) => closes.push(i))
    await t.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.emit('message', { data: 'hola' })
    ws?.emit('message', { data: new Uint8Array(2) })
    ws?.emit('close', { code: 1001, reason: 'adiós' })
    ws?.emit('close', { code: 1001 })
    expect(got).toEqual(['hola'])
    expect(closes).toEqual([{ code: 1001, reason: 'adiós' }])
    ws?.emit('close', {})
  })

  it('send envía y close cierra; send sin conectar lanza', async () => {
    const t = webSocketTransport({ url: 'ws://127.0.0.1:1/', WebSocket: Impl })
    expect(() => t.send('x')).toThrow()
    await t.connect()
    t.send('x')
    t.close()
    expect(FakeWebSocket.instances[0]?.sent).toEqual(['x'])
    expect(FakeWebSocket.instances[0]?.closedWith).toBe(1000)
  })

  it('close tolera un socket que ya lanza al cerrar', async () => {
    const t = webSocketTransport({ url: 'ws://127.0.0.1:1/', WebSocket: Impl })
    await t.connect()
    const ws = FakeWebSocket.instances[0]
    if (ws) {
      ws.close = () => {
        throw new Error('ya cerrado')
      }
    }
    expect(() => t.close()).not.toThrow()
    expect(() =>
      webSocketTransport({ url: 'ws://127.0.0.1:1/', WebSocket: Impl }).close(),
    ).not.toThrow()
  })

  it('rechaza si hay error o cierre antes de abrir', async () => {
    FakeWebSocket.mode = 'error'
    await expect(
      webSocketTransport({ url: 'ws://127.0.0.1:1/', WebSocket: Impl }).connect(),
    ).rejects.toThrow('no se pudo conectar')
    FakeWebSocket.mode = 'close'
    await expect(
      webSocketTransport({ url: 'ws://127.0.0.1:1/', WebSocket: Impl }).connect(),
    ).rejects.toThrow('cerrada antes de abrir')
  })

  it('un error posterior a la apertura no rechaza nada', async () => {
    const t = webSocketTransport({ url: 'ws://127.0.0.1:1/', WebSocket: Impl })
    await t.connect()
    expect(() => FakeWebSocket.instances[0]?.emit('error', {})).not.toThrow()
  })

  it('rechaza por tiempo de conexión agotado', async () => {
    vi.useFakeTimers()
    FakeWebSocket.mode = 'hang'
    const p = webSocketTransport({
      url: 'ws://127.0.0.1:1/',
      WebSocket: Impl,
      connectTimeoutMs: 100,
    }).connect()
    const assertion = expect(p).rejects.toThrow('tiempo agotado')
    await vi.advanceTimersByTimeAsync(101)
    await assertion
    expect(FakeWebSocket.instances[0]?.closedWith).toBeUndefined()
  })

  it('un constructor que lanza no filtra el token en el mensaje', async () => {
    FakeWebSocket.mode = 'throw'
    const err = await webSocketTransport({
      url: 'ws://127.0.0.1:1/',
      token: 'SECRETO',
      WebSocket: Impl,
    })
      .connect()
      .catch((e: Error) => e)
    expect(String(err)).not.toContain('SECRETO')
  })

  it('exige ws:// o wss:// y un WebSocket disponible', () => {
    expect(() => webSocketTransport({ url: 'http://127.0.0.1:1/', WebSocket: Impl })).toThrow()
    expect(() => webSocketTransport({ url: 'no es url', WebSocket: Impl })).toThrow()
    vi.stubGlobal('WebSocket', undefined)
    try {
      expect(() => webSocketTransport({ url: 'ws://127.0.0.1:1/' })).toThrow('WebSocket')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('usa el WebSocket global por omisión y connectWebSocket conecta', async () => {
    vi.stubGlobal('WebSocket', Impl)
    try {
      const pending = connectWebSocket({ url: 'ws://127.0.0.1:1/', token: 'abc', auth: 'message' })
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
      const ws = FakeWebSocket.instances[0]
      await vi.waitFor(() => expect(ws?.sent).toHaveLength(1))
      const req = JSON.parse(ws?.sent[0] ?? '{}') as { id: string; method: string }
      expect(req.method).toBe('auth')
      ws?.emit('message', { data: JSON.stringify({ v: 1, id: req.id, ok: true, result: {} }) })
      const client = await pending
      expect(client.state).toBe('open')
      client.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
