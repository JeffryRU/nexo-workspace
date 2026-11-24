import { describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  ErrorBody,
  ErrorCode,
  EVENT_NAMES,
  LIMITS,
  METHOD_NAMES,
  PaneId,
  parseRequest,
  parseRequestValue,
  parseResult,
  parseServerMessage,
  parseServerMessageValue,
  TabId,
  TerminalId,
  utf8ByteLength,
  WorkspaceId,
} from './index.ts'

const req = (method: string, params?: unknown, id = 'r1') =>
  JSON.stringify({ v: 1, id, method, ...(params === undefined ? {} : { params }) })

describe('códigos de error', () => {
  it('son exactamente los del contrato', () => {
    expect([...ERROR_CODES]).toEqual([
      'INVALID_PARAMS',
      'NOT_FOUND',
      'UNAUTHORIZED',
      'CONFLICT',
      'INTERNAL',
      'PAYLOAD_TOO_LARGE',
      'RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
    ])
    expect(ErrorCode.safeParse('NOPE').success).toBe(false)
    expect(ErrorBody.safeParse({ code: 'CONFLICT', message: 'x', data: { a: 1 } }).success).toBe(true)
  })
})

describe('ids con marca', () => {
  it('aceptan ids válidos y rechazan vacíos, largos o con caracteres raros', () => {
    for (const schema of [WorkspaceId, TabId, PaneId, TerminalId]) {
      expect(schema.safeParse('abc-1_X').success).toBe(true)
      expect(schema.safeParse('').success).toBe(false)
      expect(schema.safeParse('a'.repeat(LIMITS.maxIdLength + 1)).success).toBe(false)
      expect(schema.safeParse('a b').success).toBe(false)
      expect(schema.safeParse('../x').success).toBe(false)
      expect(schema.safeParse(5).success).toBe(false)
    }
  })
})

describe('parseRequest', () => {
  it('acepta una petición sin params para métodos sin parámetros', () => {
    const r = parseRequest(req('daemon.info'))
    expect(r).toEqual({ ok: true, value: { v: 1, id: 'r1', method: 'daemon.info', params: {} } })
  })

  it('acepta cada método con params mínimos válidos', () => {
    const samples: Record<string, unknown> = {
      'daemon.info': {},
      snapshot: {},
      'events.subscribe': {},
      'workspace.list': {},
      'workspace.create': { name: 'w' },
      'workspace.rename': { workspaceId: 'w1', name: 'n' },
      'workspace.close': { workspaceId: 'w1' },
      'tab.create': { workspaceId: 'w1' },
      'tab.close': { tabId: 't1' },
      'tab.focus': { tabId: 't1' },
      'tab.move': { tabId: 't1', index: 0 },
      'tab.rename': { tabId: 't1', title: 'x' },
      'pane.split': { paneId: 'p1', direction: 'row' },
      'pane.close': { paneId: 'p1' },
      'pane.focus': { paneId: 'p1' },
      'pane.resize': { paneId: 'p1', delta: 0.1 },
      'pane.swap': { paneId: 'p1', otherPaneId: 'p2' },
      'terminal.spawn': { paneId: 'p1', cols: 80, rows: 24 },
      'terminal.write': { terminalId: 'x1', data: 'ls\r' },
      'terminal.resize': { terminalId: 'x1', cols: 1, rows: 1000 },
      'terminal.read': { terminalId: 'x1' },
      'terminal.kill': { terminalId: 'x1', signal: 'SIGTERM' },
    }
    expect(Object.keys(samples).sort()).toEqual([...METHOD_NAMES].sort())
    for (const [method, params] of Object.entries(samples)) {
      const r = parseRequest(req(method, params))
      expect(r.ok, method).toBe(true)
    }
  })

  it('el registro de eventos tiene los nombres de la F1', () => {
    expect([...EVENT_NAMES].sort()).toEqual(
      ['layout.changed', 'pane.attention', 'pane.title', 'terminal.exit', 'terminal.output'].sort(),
    )
  })

  it('método desconocido -> NOT_FOUND con el id de la petición', () => {
    const r = parseRequest(req('no.existe', {}, 'abc'))
    expect(r).toMatchObject({ ok: false, id: 'abc', error: { code: 'NOT_FOUND' } })
  })

  it('params inválidos -> INVALID_PARAMS con el id', () => {
    const r = parseRequest(req('terminal.write', { terminalId: 'x1', data: 7 }, 'q'))
    expect(r).toMatchObject({ ok: false, id: 'q', error: { code: 'INVALID_PARAMS' } })
  })

  it('sobre inválido: versión, id vacío, claves extra, JSON roto, no-texto', () => {
    const bad = [
      JSON.stringify({ v: 2, id: 'a', method: 'snapshot' }),
      JSON.stringify({ v: 1, id: '', method: 'snapshot' }),
      JSON.stringify({ v: 1, id: 'a', method: 'snapshot', extra: true }),
      '{no es json',
      'null',
      '[]',
    ]
    for (const text of bad) {
      const r = parseRequest(text)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('INVALID_PARAMS')
    }
    const notText = parseRequest(42 as unknown as string)
    expect(notText).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
  })

  it('PAYLOAD_TOO_LARGE respeta el máximo configurable y el valor por omisión (1 MiB)', () => {
    const text = req('terminal.write', { terminalId: 'x1', data: 'a'.repeat(100) })
    expect(parseRequest(text, { maxBytes: 50 })).toMatchObject({
      ok: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    })
    expect(parseRequest(text, { maxBytes: 10_000 }).ok).toBe(true)
    const huge = ' '.repeat(LIMITS.maxMessageBytes + 1)
    expect(parseRequest(huge)).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } })
  })

  it('el tope de bytes cuenta UTF-8, no unidades UTF-16', () => {
    const text = `"${'ñ'.repeat(30)}"` // 62 bytes, 32 unidades
    expect(parseRequest(text, { maxBytes: 40 })).toMatchObject({
      ok: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    })
  })
})

describe('límites de métodos', () => {
  const write = (data: string) => parseRequest(req('terminal.write', { terminalId: 'x1', data }))
  it('terminal.write: máximo 64 KiB en bytes UTF-8', () => {
    expect(write('a'.repeat(65536)).ok).toBe(true)
    expect(write('a'.repeat(65537)).ok).toBe(false)
    expect(write('ñ'.repeat(32768)).ok).toBe(true)
    expect(write('ñ'.repeat(32769)).ok).toBe(false)
    expect(write('😀'.repeat(16384)).ok).toBe(true)
    expect(write('😀'.repeat(16385)).ok).toBe(false)
  })

  it('cols/rows 1..1000 enteros', () => {
    const spawn = (cols: unknown, rows: unknown) =>
      parseRequest(req('terminal.spawn', { paneId: 'p1', cols, rows })).ok
    expect(spawn(1, 1)).toBe(true)
    expect(spawn(1000, 1000)).toBe(true)
    for (const bad of [0, 1001, -1, 1.5, '80', null]) {
      expect(spawn(bad, 24)).toBe(false)
      expect(spawn(80, bad)).toBe(false)
    }
  })

  it('títulos: máximo 256 caracteres, no vacíos, sin caracteres de control', () => {
    const rename = (title: string) => parseRequest(req('tab.rename', { tabId: 't1', title })).ok
    expect(rename('a'.repeat(256))).toBe(true)
    expect(rename('a'.repeat(257))).toBe(false)
    expect(rename('')).toBe(false)
    expect(rename('hola\u001b]0;x\u0007')).toBe(false)
    expect(rename('línea\nnueva')).toBe(false)
    expect(rename('con separador')).toBe(false)
  })

  it('pane.split: ratio en (0,1); pane.resize: delta en [-1,1]', () => {
    const split = (ratio: number) =>
      parseRequest(req('pane.split', { paneId: 'p1', direction: 'row', ratio })).ok
    expect(split(0.5)).toBe(true)
    expect(split(0)).toBe(false)
    expect(split(1)).toBe(false)
    const resize = (delta: number) => parseRequest(req('pane.resize', { paneId: 'p1', delta })).ok
    expect(resize(-1)).toBe(true)
    expect(resize(1.01)).toBe(false)
  })

  it('terminal.spawn: env con nombres reservados o inválidos se rechaza', () => {
    const spawn = (env: unknown) =>
      parseRequest(req('terminal.spawn', { paneId: 'p1', cols: 80, rows: 24, env })).ok
    expect(spawn({ PATH: '/bin' })).toBe(true)
    expect(parseRequest(req('terminal.spawn', JSON.parse('{"paneId":"p1","cols":80,"rows":24,"env":{"__proto__":"x"}}'))).ok).toBe(false)
    expect(spawn({ constructor: 'x' })).toBe(false)
    expect(spawn({ 'BAD NAME': 'x' })).toBe(false)
    expect(spawn({ A: 5 })).toBe(false)
    const many = Object.fromEntries(Array.from({ length: LIMITS.maxEnvEntries + 1 }, (_, i) => [`V${i}`, 'x']))
    expect(spawn(many)).toBe(false)
  })
})

describe('parseServerMessage', () => {
  it('respuestas ok y de error', () => {
    const ok = parseServerMessage(JSON.stringify({ v: 1, id: 'a', ok: true, result: { x: 1 } }))
    expect(ok).toMatchObject({ ok: true, value: { ok: true, id: 'a' } })
    const err = parseServerMessage(
      JSON.stringify({ v: 1, id: 'a', ok: false, error: { code: 'NOT_FOUND', message: 'no' } }),
    )
    expect(err).toMatchObject({ ok: true, value: { ok: false, error: { code: 'NOT_FOUND' } } })
  })

  it('eventos tipados; seq y data validados', () => {
    const good = parseServerMessage(
      JSON.stringify({
        v: 1,
        event: 'pane.title',
        seq: 3,
        data: { paneId: 'p1', title: 'hola' },
      }),
    )
    expect(good).toMatchObject({ ok: true, value: { event: 'pane.title', seq: 3 } })
    const badData = parseServerMessage(
      JSON.stringify({ v: 1, event: 'pane.title', seq: 3, data: { paneId: 'p1' } }),
    )
    expect(badData).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    const badSeq = parseServerMessage(
      JSON.stringify({ v: 1, event: 'pane.title', seq: -1, data: { paneId: 'p1', title: 'x' } }),
    )
    expect(badSeq.ok).toBe(false)
    const unknown = parseServerMessage(JSON.stringify({ v: 1, event: 'otro', seq: 1, data: {} }))
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('basura, JSON roto y exceso de tamaño', () => {
    expect(parseServerMessage('{"v":1}')).toMatchObject({ ok: false })
    expect(parseServerMessage('x')).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    expect(parseServerMessage('[1]'.padEnd(100), { maxBytes: 10 })).toMatchObject({
      ok: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    })
  })
})

describe('parseResult', () => {
  it('valida el result según el método', () => {
    expect(parseResult('terminal.spawn', { terminalId: 'x1' })).toEqual({
      ok: true,
      value: { terminalId: 'x1' },
    })
    expect(parseResult('terminal.spawn', { terminalId: '' })).toMatchObject({ ok: false })
    expect(parseResult('constructor' as never, {})).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
  })
})

describe('valores ya parseados', () => {
  it('parseRequestValue y parseServerMessageValue no lanzan con objetos exóticos', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const v of [undefined, null, 1, 'x', cyclic, Symbol('s'), () => 1, new Map()]) {
      expect(() => parseRequestValue(v)).not.toThrow()
      expect(() => parseServerMessageValue(v)).not.toThrow()
    }
  })

  it('utf8ByteLength cuenta sustitutos sueltos como 3 bytes', () => {
    expect(utf8ByteLength('a')).toBe(1)
    expect(utf8ByteLength('ñ')).toBe(2)
    expect(utf8ByteLength('€')).toBe(3)
    expect(utf8ByteLength('😀')).toBe(4)
    expect(utf8ByteLength('\ud800')).toBe(3)
    expect(utf8ByteLength('\ud800a')).toBe(4)
  })
})
