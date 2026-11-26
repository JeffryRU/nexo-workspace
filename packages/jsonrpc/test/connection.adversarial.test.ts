import { describe, expect, it } from 'vitest'
import { ErrorCodes, parseLine, RpcClosedError } from '../src/index.ts'
import { harness, tick } from './helpers.ts'

describe('JsonRpcConnection: entradas hostiles', () => {
  it('JSON inválido se informa y la conexión sigue viva', () => {
    const h = harness()
    h.conn.feed('{no json\n[1,2]\n"texto"\n42\nnull\n{"method":"ok"}\n')
    expect(h.issues.map((i) => i.kind)).toEqual([
      'invalid-json',
      'invalid-message',
      'invalid-message',
      'invalid-message',
      'invalid-message',
    ])
    expect(h.notifications).toEqual([{ method: 'ok', params: undefined }])
    expect(h.conn.closed).toBe(false)
  })

  it('mensajes con forma imposible se rechazan', () => {
    const h = harness()
    const bad = [
      '{}',
      '{"jsonrpc":"1.0","method":"a"}',
      '{"method":""}',
      '{"method":5}',
      `{"method":"${'a'.repeat(300)}"}`,
      '{"id":1}',
      '{"id":1,"result":1,"error":{"code":1,"message":"x"}}',
      '{"id":1,"error":{"code":"x","message":"y"}}',
      '{"id":1,"error":"texto"}',
      '{"id":null,"error":{"code":-32700,"message":"parse"}}',
      '{"id":1.5,"method":"a"}',
      '{"id":{"a":1},"method":"a"}',
      '{"id":true,"result":1}',
    ]
    h.conn.feed(`${bad.join('\n')}\n`)
    expect(h.issues).toHaveLength(bad.length)
    expect(h.issues.every((i) => i.kind === 'invalid-message')).toBe(true)
    expect(h.written).toEqual([])
  })

  it('__proto__ y claves raras no contaminan nada', () => {
    const h = harness()
    h.conn.feed('{"method":"a","params":{"__proto__":{"polluted":true}}}\n')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(h.notifications).toHaveLength(1)
  })

  it('una respuesta sin solicitud, o repetida, se ignora y no rompe nada', async () => {
    const h = harness()
    h.conn.feed('{"id":99,"result":1}\n')
    const p = h.conn.request('a')
    h.conn.feed(
      '{"id":1,"result":"uno"}\n{"id":1,"result":"dos"}\n{"id":1,"error":{"code":1,"message":"x"}}\n',
    )
    await expect(p).resolves.toBe('uno')
    expect(h.issues.map((i) => i.kind)).toEqual([
      'unknown-response',
      'unknown-response',
      'unknown-response',
    ])
  })

  it('ids de respuesta de otro tipo no resuelven la solicitud', async () => {
    const h = harness({ requestTimeoutMs: 20 })
    const p = h.conn.request('a')
    h.conn.feed('{"id":"1","result":"x"}\n')
    await expect(p).rejects.toThrow()
    expect(h.issues[0]?.kind).toBe('unknown-response')
  })

  it('un id de solicitud del servidor repetido mientras sigue pendiente recibe error', async () => {
    let release: (v: unknown) => void = () => {}
    const h = harness({ onRequest: () => new Promise((r) => (release = r)) })
    h.conn.feed('{"id":5,"method":"a"}\n{"id":5,"method":"b"}\n')
    expect(h.sent()).toEqual([
      { jsonrpc: '2.0', id: 5, error: { code: ErrorCodes.invalidRequest, message: 'id repetido' } },
    ])
    release('ok')
    await tick()
    expect(h.sent()[1]).toEqual({ jsonrpc: '2.0', id: 5, result: 'ok' })
    // Una vez respondido, el mismo id se puede reutilizar.
    h.conn.feed('{"id":5,"method":"c"}\n')
    release('otra')
    await tick()
    expect(h.sent()).toHaveLength(3)
  })

  it('limita las solicitudes del servidor sin atender y no responde dos veces', async () => {
    const releases: ((v: unknown) => void)[] = []
    const h = harness({
      maxInFlightRequests: 2,
      onRequest: () => new Promise((r) => releases.push(r)),
    })
    h.conn.feed('{"id":1,"method":"a"}\n{"id":2,"method":"a"}\n{"id":3,"method":"a"}\n')
    expect(h.sent()).toEqual([
      {
        jsonrpc: '2.0',
        id: 3,
        error: { code: ErrorCodes.busy, message: 'demasiadas solicitudes a la vez' },
      },
    ])
    for (const r of releases) r(1)
    await tick()
    expect(h.sent()).toHaveLength(3)
  })

  it('solicitudes del servidor que nadie atiende reciben método no encontrado', () => {
    const h = harness({ version: 'omit' })
    h.conn.feed('{"id":"x","method":"item/tool/call","params":{}}\n')
    expect(h.sent()).toEqual([
      {
        id: 'x',
        error: { code: ErrorCodes.methodNotFound, message: 'método no soportado: item/tool/call' },
      },
    ])
  })

  it('una línea enorme se descarta entera, aunque llegue por trozos, y la siguiente se procesa', () => {
    const h = harness({ maxLineLength: 100 })
    h.conn.feed(`{"method":"${'x'.repeat(60)}`)
    h.conn.feed('y'.repeat(60))
    h.conn.feed('z'.repeat(1000))
    h.conn.feed('"}\n{"method":"ok"}\n')
    expect(h.issues.map((i) => i.kind)).toEqual(['line-too-large'])
    expect(h.notifications.map((n) => n.method)).toEqual(['ok'])
  })

  it('una línea sin salto que supera el tope no acumula memoria sin fin', () => {
    const h = harness({ maxLineLength: 1000, maxIssues: 1_000_000 })
    for (let i = 0; i < 1000; i++) h.conn.feed('a'.repeat(5000))
    expect(h.issues).toHaveLength(1)
  })

  it('al exceder maxIssues la conexión se cierra y rechaza lo pendiente', async () => {
    const h = harness({ maxIssues: 3, requestTimeoutMs: 0 })
    const p = h.conn.request('a')
    h.conn.feed('x\nx\nx\nx\nx\n')
    await expect(p).rejects.toBeInstanceOf(RpcClosedError)
    expect(h.conn.closed).toBe(true)
    expect(h.closes[0]?.message).toMatch(/demasiados/)
    expect(h.issues).toHaveLength(4)
  })

  it('las respuestas sin solicitud no cuentan para cerrar (una tardía no es hostil)', () => {
    const h = harness({ maxIssues: 2 })
    for (let i = 0; i < 50; i++) h.conn.feed(`{"id":${1000 + i},"result":1}\n`)
    expect(h.conn.closed).toBe(false)
  })

  it('el cierre a mitad de una línea no entrega media línea rota como mensaje', () => {
    const h = harness()
    h.conn.feed('{"method":"a')
    h.conn.end()
    expect(h.notifications).toEqual([])
    expect(h.issues.map((i) => i.kind)).toEqual(['invalid-json'])
  })

  it('después de cerrar, feed no hace nada', () => {
    const h = harness()
    h.conn.close()
    h.conn.feed('{"method":"a"}\n')
    expect(h.notifications).toEqual([])
  })

  it('parseLine acepta jsonrpc 2.0 y ids de texto o enteros', () => {
    expect(parseLine('{"jsonrpc":"2.0","id":"a","method":"m","params":[1]}')).toEqual({
      ok: true,
      message: { kind: 'request', id: 'a', method: 'm', params: [1] },
    })
    expect(parseLine('{"jsonrpc":"2.0","id":0,"result":null}')).toEqual({
      ok: true,
      message: { kind: 'response', id: 0, result: null },
    })
  })
})
