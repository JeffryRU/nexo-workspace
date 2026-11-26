import { describe, expect, it } from 'vitest'
import { ErrorCodes, RpcClosedError, RpcError, RpcTimeoutError } from '../src/index.ts'
import { harness, linked, tick } from './helpers.ts'

describe('JsonRpcConnection', () => {
  it('envía solicitudes con ids crecientes y resuelve con el resultado', async () => {
    const h = harness({ version: 'omit' })
    const a = h.conn.request('ping', { x: 1 })
    const b = h.conn.request('pong')
    expect(h.sent()).toEqual([
      { id: 1, method: 'ping', params: { x: 1 } },
      { id: 2, method: 'pong' },
    ])
    h.conn.feed('{"id":2,"result":"dos"}\n{"id":1,"result":{"ok":true}}\n')
    await expect(a).resolves.toEqual({ ok: true })
    await expect(b).resolves.toBe('dos')
    expect(h.conn.pendingCount).toBe(0)
  })

  it('añade jsonrpc 2.0 por omisión y lo omite con version omit', () => {
    const a = harness()
    a.conn.notify('n', [1])
    expect(a.sent()).toEqual([{ jsonrpc: '2.0', method: 'n', params: [1] }])
    const b = harness({ version: 'omit' })
    b.conn.notify('n')
    expect(b.sent()).toEqual([{ method: 'n' }])
  })

  it('un error del otro extremo rechaza con RpcError y conserva código y datos', async () => {
    const h = harness()
    const p = h.conn.request('x')
    h.conn.feed('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"mal","data":{"a":1}}}\n')
    const error = await p.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ code: -32602, message: 'mal', data: { a: 1 } })
  })

  it('entrega las notificaciones y acepta mensajes partidos en trozos', () => {
    const h = harness()
    const raw = '{"method":"a","params":{"n":1}}\n{"method":"b"}\n'
    for (const ch of raw) h.conn.feed(ch)
    expect(h.notifications).toEqual([
      { method: 'a', params: { n: 1 } },
      { method: 'b', params: undefined },
    ])
  })

  it('tolera CRLF, líneas vacías y una última línea sin salto al cerrar', () => {
    const h = harness()
    h.conn.feed('\r\n\n{"method":"a"}\r\n{"method":"b"}')
    expect(h.notifications.map((n) => n.method)).toEqual(['a'])
    h.conn.end()
    expect(h.notifications.map((n) => n.method)).toEqual(['a', 'b'])
  })

  it('responde a las solicitudes del servidor, también de forma diferida', async () => {
    const h = harness({
      version: 'omit',
      onRequest: ({ method, params }) => {
        if (method === 'sync') return { got: params }
        return new Promise((resolve) => setTimeout(() => resolve('tarde'), 5))
      },
    })
    h.conn.feed('{"id":"a","method":"sync","params":[1]}\n{"id":7,"method":"later"}\n')
    expect(h.sent()).toEqual([{ id: 'a', result: { got: [1] } }])
    expect(h.conn.inFlightCount).toBe(1)
    await tick(30)
    expect(h.sent()[1]).toEqual({ id: 7, result: 'tarde' })
    expect(h.conn.inFlightCount).toBe(0)
  })

  it('un resultado undefined se envía como null', () => {
    const h = harness({ onRequest: () => undefined })
    h.conn.feed('{"id":1,"method":"m"}\n')
    expect(h.sent()).toEqual([{ jsonrpc: '2.0', id: 1, result: null }])
  })

  it('un atendedor que lanza RpcError responde con ese código', () => {
    const h = harness({
      onRequest: () => {
        throw new RpcError(-32001, 'no', { why: 1 })
      },
    })
    h.conn.feed('{"id":1,"method":"m"}\n')
    expect(h.sent()[0]).toMatchObject({
      id: 1,
      error: { code: -32001, message: 'no', data: { why: 1 } },
    })
  })

  it('una excepción cualquiera del atendedor da error interno sin filtrar el mensaje', async () => {
    const h = harness({ onRequest: () => Promise.reject(new Error('secreto sk-123')) })
    h.conn.feed('{"id":1,"method":"m"}\n')
    await tick()
    expect(h.sent()[0]).toMatchObject({
      id: 1,
      error: { code: ErrorCodes.internalError, message: 'error interno' },
    })
    expect(h.issues[0]?.kind).toBe('handler-error')
  })

  it('un atendedor que lanza de forma síncrona también responde', () => {
    const h = harness({
      onRequest: () => {
        throw new Error('boom')
      },
    })
    h.conn.feed('{"id":1,"method":"m"}\n')
    expect(h.sent()[0]).toMatchObject({ error: { code: ErrorCodes.internalError } })
  })

  it('sin atendedor responde método no encontrado', () => {
    const h = harness()
    h.conn.feed('{"id":9,"method":"nadie"}\n')
    expect(h.sent()[0]).toMatchObject({ id: 9, error: { code: ErrorCodes.methodNotFound } })
  })

  it('una excepción en onNotification se informa y no rompe la conexión', () => {
    const h = harness({
      onNotification: () => {
        throw new Error('x')
      },
    })
    h.conn.feed('{"method":"a"}\n{"method":"b"}\n')
    expect(h.issues.map((i) => i.kind)).toEqual(['handler-error', 'handler-error'])
    expect(h.conn.closed).toBe(false)
  })

  it('vence el plazo de una solicitud con RpcTimeoutError y descarta la respuesta tardía', async () => {
    const h = harness()
    const p = h.conn.request('lento', undefined, { timeoutMs: 10 })
    await expect(p).rejects.toBeInstanceOf(RpcTimeoutError)
    expect(h.conn.pendingCount).toBe(0)
    h.conn.feed('{"id":1,"result":1}\n')
    expect(h.issues).toEqual([{ kind: 'unknown-response', detail: 'id 1' }])
  })

  it('el plazo por omisión viene de las opciones y 0 lo desactiva', async () => {
    const h = harness({ requestTimeoutMs: 10 })
    await expect(h.conn.request('a')).rejects.toBeInstanceOf(RpcTimeoutError)
    const p = h.conn.request('b', undefined, { timeoutMs: 0 })
    await tick(30)
    expect(h.conn.pendingCount).toBe(1)
    h.conn.end()
    await expect(p).rejects.toBeInstanceOf(RpcClosedError)
  })

  it('end rechaza todas las pendientes, avisa una vez y las siguientes solicitudes rechazan', async () => {
    const h = harness()
    const a = h.conn.request('a')
    const b = h.conn.request('b')
    h.conn.end(new Error('el proceso murió'))
    h.conn.end()
    h.conn.close()
    await expect(a).rejects.toThrow('el proceso murió')
    await expect(b).rejects.toBeInstanceOf(RpcClosedError)
    await expect(h.conn.request('c')).rejects.toBeInstanceOf(RpcClosedError)
    expect(h.closes).toHaveLength(1)
    h.conn.notify('x')
    expect(h.written).toHaveLength(2)
  })

  it('la respuesta que un atendedor entrega tras el cierre se descarta', async () => {
    let release: (v: unknown) => void = () => {}
    const h = harness({ onRequest: () => new Promise((r) => (release = r)) })
    h.conn.feed('{"id":1,"method":"m"}\n')
    h.conn.close()
    release('x')
    await tick()
    expect(h.written).toEqual([])
  })

  it('si write lanza, la conexión se cierra y la solicitud rechaza', async () => {
    const h = harness({
      write: () => {
        throw new Error('pipe roto')
      },
    })
    await expect(h.conn.request('a')).rejects.toBeInstanceOf(RpcClosedError)
    expect(h.conn.closed).toBe(true)
    expect(h.issues[0]?.kind).toBe('write-failed')
  })

  it('dos extremos conectados conversan en ambos sentidos', async () => {
    const { left, right } = linked(
      { onRequest: ({ params }) => ({ eco: params }) },
      {
        onRequest: async ({ method }) => {
          await tick(2)
          return method.toUpperCase()
        },
      },
    )
    await expect(right.request('hola', 1)).resolves.toEqual({ eco: 1 })
    await expect(left.request('abc')).resolves.toBe('ABC')
  })

  it('limita las solicitudes propias pendientes', async () => {
    const h = harness({ maxPendingRequests: 2, requestTimeoutMs: 0 })
    const a = h.conn.request('a')
    const b = h.conn.request('b')
    await expect(h.conn.request('c')).rejects.toMatchObject({ code: ErrorCodes.busy })
    h.conn.end()
    await Promise.allSettled([a, b])
  })
})
