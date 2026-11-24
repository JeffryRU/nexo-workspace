import { describe, expect, it } from 'vitest'
import { LIMITS, LayoutSchema, parseRequest, parseServerMessage } from './index.ts'

const polluted = () => ({}) as Record<string, unknown>

describe('adversarial: tamaño y anidamiento', () => {
  it('JSON gigante -> PAYLOAD_TOO_LARGE sin parsear', () => {
    const big = `{"v":1,"id":"a","method":"snapshot","params":{"x":"${'a'.repeat(LIMITS.maxMessageBytes)}"}}`
    expect(parseRequest(big)).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(parseServerMessage(big)).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } })
  })

  it('anidamiento profundo (dentro del tope de tamaño) no lanza ni cuelga', () => {
    const depth = 100_000
    const text = `{"v":1,"id":"a","method":"snapshot","params":${'['.repeat(depth)}${']'.repeat(depth)}}`
    const started = Date.now()
    const r = parseRequest(text)
    expect(r.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(() => parseServerMessage('['.repeat(500_000))).not.toThrow()
  })

  it('anidamiento profundo dentro de params de tipo string/objeto se rechaza', () => {
    const nested = `{"v":1,"id":"a","method":"terminal.write","params":{"terminalId":"t1","data":${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}}}`
    expect(parseRequest(nested)).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
  })

  it('un Layout de 1000 niveles se valida sin desbordar la pila', () => {
    let node = '{"type":"leaf","paneId":"p0"}'
    for (let i = 1; i <= 1000; i++) {
      node = `{"type":"split","direction":"row","children":[${node},{"type":"leaf","paneId":"p${i}"}],"ratios":[0.5,0.5]}`
    }
    expect(() => LayoutSchema.safeParse(JSON.parse(node))).not.toThrow()
    expect(LayoutSchema.safeParse(JSON.parse(node)).success).toBe(true)
  })
})

describe('adversarial: prototipos', () => {
  it('__proto__ y constructor como claves no contaminan Object.prototype', () => {
    const texts = [
      '{"v":1,"id":"a","method":"snapshot","params":{"__proto__":{"polluted":true}}}',
      '{"__proto__":{"polluted":true},"v":1,"id":"a","method":"snapshot"}',
      '{"v":1,"id":"a","method":"terminal.spawn","params":{"paneId":"p1","cols":80,"rows":24,"env":{"__proto__":{"polluted":true}}}}',
      '{"v":1,"id":"a","method":"terminal.spawn","params":{"paneId":"p1","cols":80,"rows":24,"env":{"constructor":{"prototype":{"polluted":true}}}}}',
      '{"v":1,"id":"a","ok":true,"result":{"__proto__":{"polluted":true}}}',
      '{"v":1,"event":"pane.title","seq":1,"data":{"paneId":"p1","title":"x","__proto__":{"polluted":true}}}',
    ]
    for (const text of texts) {
      expect(() => parseRequest(text)).not.toThrow()
      expect(() => parseServerMessage(text)).not.toThrow()
    }
    expect(polluted().polluted).toBeUndefined()
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('una clave __proto__ propia se rechaza en cualquier posición del mensaje', () => {
    for (const text of [
      '{"v":1,"id":"a","ok":true,"result":{"__proto__":{"x":1}}}',
      '{"v":1,"id":"a","method":"snapshot","params":{"__proto__":1}}',
      '{"v":1,"id":"a","method":"terminal.spawn","params":{"paneId":"p1","cols":80,"rows":24,"env":{"__proto__":"x"}}}',
    ]) {
      expect(parseRequest(text).ok).toBe(false)
      expect(parseServerMessage(text).ok).toBe(false)
    }
  })

  it('métodos que coinciden con propiedades de Object.prototype no existen', () => {
    for (const method of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = parseRequest(JSON.stringify({ v: 1, id: 'a', method, params: {} }))
      expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    }
    const ev = parseServerMessage(
      JSON.stringify({ v: 1, event: 'constructor', seq: 0, data: {} }),
    )
    expect(ev).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('adversarial: valores y tipos', () => {
  const base = { v: 1, id: 'a' }
  const call = (method: string, params: unknown) => parseRequest(JSON.stringify({ ...base, method, params }))

  it('NaN, Infinity y negativos (JSON los vuelve null o los rechaza)', () => {
    // JSON.stringify convierte NaN/Infinity en null.
    expect(call('pane.resize', { paneId: 'p1', delta: Number.NaN }).ok).toBe(false)
    expect(call('pane.resize', { paneId: 'p1', delta: Number.POSITIVE_INFINITY }).ok).toBe(false)
    expect(call('pane.resize', { paneId: 'p1', delta: 1e999 }).ok).toBe(false)
    expect(parseRequest('{"v":1,"id":"a","method":"pane.resize","params":{"paneId":"p1","delta":NaN}}').ok).toBe(false)
    expect(call('tab.move', { tabId: 't1', index: -1 }).ok).toBe(false)
    expect(call('terminal.spawn', { paneId: 'p1', cols: -80, rows: 24 }).ok).toBe(false)
    expect(call('terminal.read', { terminalId: 't1', maxBytes: 0 }).ok).toBe(false)
    expect(call('terminal.read', { terminalId: 't1', maxBytes: LIMITS.maxReadBytes + 1 }).ok).toBe(false)
    expect(parseServerMessage('{"v":1,"event":"terminal.output","seq":-5,"data":{}}').ok).toBe(false)
    expect(
      parseServerMessage('{"v":1,"event":"terminal.output","seq":1.5,"data":{"terminalId":"t","offset":0,"data":""}}').ok,
    ).toBe(false)
  })

  it('ids vacíos o con caracteres peligrosos', () => {
    for (const id of ['', ' ', '../../x', 'a/b', 'a\u0000b', '\u001b[31m', 'a'.repeat(65), '__proto__ ']) {
      expect(call('pane.close', { paneId: id }).ok, JSON.stringify(id)).toBe(false)
    }
    expect(parseRequest(JSON.stringify({ v: 1, id: '', method: 'snapshot' })).ok).toBe(false)
    expect(parseRequest(JSON.stringify({ v: 1, id: 'x'.repeat(129), method: 'snapshot' })).ok).toBe(false)
  })

  it('tipos equivocados en cada nivel', () => {
    const wrong: unknown[] = [null, 0, true, [], [1], {}]
    for (const w of wrong) {
      expect(call('terminal.write', w).ok).toBe(false)
      expect(call('pane.split', { paneId: w, direction: 'row' }).ok).toBe(false)
    }
    expect(call('terminal.write', { terminalId: 't1', data: ['a'] }).ok).toBe(false)
    expect(call('terminal.spawn', { paneId: 'p1', cols: 80, rows: 24, args: 'ls' }).ok).toBe(false)
    expect(call('terminal.spawn', { paneId: 'p1', cols: 80, rows: 24, args: [1] }).ok).toBe(false)
    expect(call('snapshot', { extra: 1 }).ok).toBe(false)
    expect(parseRequest(JSON.stringify({ v: '1', id: 'a', method: 'snapshot' })).ok).toBe(false)
    expect(parseRequest(JSON.stringify({ v: 1, id: 'a', method: 5 })).ok).toBe(false)
    expect(parseRequest(JSON.stringify({ v: 1, id: 7, method: 'snapshot' })).ok).toBe(false)
  })

  it('escapes ANSI/OSC: se aceptan como datos de terminal pero no como títulos o nombres', () => {
    const osc = '\u001b]0;pwned\u0007'
    const csi = '\u001b[2J\u001b[31m'
    expect(call('terminal.write', { terminalId: 't1', data: osc + csi }).ok).toBe(true)
    for (const bad of [osc, csi, `ok${osc}`, '\u009b31m', '\u0000']) {
      expect(call('tab.rename', { tabId: 't1', title: bad }).ok, JSON.stringify(bad)).toBe(false)
      expect(call('workspace.create', { name: bad }).ok).toBe(false)
      expect(
        parseServerMessage(
          JSON.stringify({ v: 1, event: 'pane.title', seq: 0, data: { paneId: 'p1', title: bad } }),
        ).ok,
      ).toBe(false)
    }
  })

  it('cmd/args/cwd con valores enormes o NUL', () => {
    const spawn = (extra: Record<string, unknown>) =>
      call('terminal.spawn', { paneId: 'p1', cols: 80, rows: 24, ...extra }).ok
    expect(spawn({ args: Array.from({ length: LIMITS.maxArgs + 1 }, () => 'x') })).toBe(false)
    expect(spawn({ args: ['x'.repeat(LIMITS.maxArgLength + 1)] })).toBe(false)
    expect(spawn({ cwd: 'c'.repeat(LIMITS.maxPathLength + 1) })).toBe(false)
    expect(spawn({ cmd: '' })).toBe(false)
  })

  it('el id de una petición inválida se devuelve cuando es seguro para poder responder', () => {
    const r = parseRequest(JSON.stringify({ v: 1, id: 'seguro', method: 'snapshot', params: { x: 1 } }))
    expect(r).toMatchObject({ ok: false, id: 'seguro' })
    const noId = parseRequest(JSON.stringify({ v: 1, id: { evil: true }, method: 'snapshot' }))
    expect(noId.ok).toBe(false)
    if (!noId.ok) expect(noId.id).toBeUndefined()
  })
})
