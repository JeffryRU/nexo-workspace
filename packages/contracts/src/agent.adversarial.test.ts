import { arbHostileString, hasProtoKey } from '@nexo/testkit'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  AgentDelta,
  AgentSession,
  Block,
  BlockDraft,
  LIMITS,
  methods,
  ProviderEvent,
  parseRequest,
  parseServerMessage,
  sanitizeBodyText,
} from './index.ts'

const base = { id: 'b1', index: 0, turn: 1, seq: 0, createdAt: 1 }
const text = (over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'text',
  text: 'hola',
  complete: false,
  ...over,
})
const delta = (over: Record<string, unknown> = {}) => ({
  sessionId: 's',
  blockId: 'b',
  field: 'text',
  seq: 1,
  text: 'x',
  ...over,
})

describe('adversarial: tamaños', () => {
  it('bloques gigantes se rechazan en cada campo', () => {
    const big = 'a'.repeat(LIMITS.maxBlockTextBytes + 1)
    expect(Block.safeParse(text({ text: big })).success).toBe(false)
    expect(Block.safeParse({ ...base, type: 'user', text: big }).success).toBe(false)
    const action = {
      ...base,
      type: 'action',
      kind: 'exec',
      status: 'ok',
      tool: 'Bash',
      title: 't',
    }
    expect(Block.safeParse({ ...action, output: big }).success).toBe(false)
    expect(
      Block.safeParse({ ...action, input: 'a'.repeat(LIMITS.maxBlockInputBytes + 1) }).success,
    ).toBe(false)
    const edit = { ...action, kind: 'edit', diff: { path: 'a', patch: big } }
    expect(Block.safeParse(edit).success).toBe(false)
    // justo en el tope sí
    expect(Block.safeParse(text({ text: 'a'.repeat(LIMITS.maxBlockTextBytes) })).success).toBe(true)
  })

  it('el tope es en bytes UTF-8, no en caracteres', () => {
    const wide = '€'.repeat(Math.floor(LIMITS.maxBlockTextBytes / 3) + 1)
    expect(wide.length).toBeLessThan(LIMITS.maxBlockTextBytes)
    expect(Block.safeParse(text({ text: wide })).success).toBe(false)
  })

  it('deltas sobre el límite o vacíos se rechazan', () => {
    expect(AgentDelta.safeParse(delta({ text: 'a'.repeat(LIMITS.maxDeltaBytes) })).success).toBe(
      true,
    )
    expect(
      AgentDelta.safeParse(delta({ text: 'a'.repeat(LIMITS.maxDeltaBytes + 1) })).success,
    ).toBe(false)
    expect(AgentDelta.safeParse(delta({ text: '' })).success).toBe(false)
    expect(AgentDelta.safeParse(delta({ seq: 1.5 })).success).toBe(false)
    expect(AgentDelta.safeParse(delta({ seq: Number.NaN })).success).toBe(false)
    expect(AgentDelta.safeParse(delta({ seq: -1 })).success).toBe(false)
  })

  it('listas desmesuradas se rechazan', () => {
    const opt = (i: number) => ({ id: `o${i}`, label: 'x', kind: 'allow-once' })
    const options = Array.from({ length: LIMITS.maxBlockOptions + 1 }, (_, i) => opt(i))
    const perm = { ...base, type: 'permission', tool: 'T', title: 't', state: 'pending' }
    expect(Block.safeParse({ ...perm, options }).success).toBe(false)
    expect(Block.safeParse({ ...perm, options: [] }).success).toBe(false)
    const entries = Array.from({ length: LIMITS.maxPlanEntries + 1 }, () => ({
      text: 'x',
      status: 'pending',
    }))
    expect(Block.safeParse({ ...base, type: 'plan', entries }).success).toBe(false)
    expect(
      methods['agent.snapshot'].result.safeParse({
        session: {},
        blocks: Array.from({ length: LIMITS.maxSnapshotBlocks + 1 }, () => text()),
        nextIndex: null,
      }).success,
    ).toBe(false)
  })

  it('índice y ids fuera de rango o enormes se rechazan', () => {
    expect(Block.safeParse(text({ index: LIMITS.maxBlocksPerSession })).success).toBe(false)
    expect(Block.safeParse(text({ index: LIMITS.maxBlocksPerSession - 1 })).success).toBe(true)
    for (const id of ['', 'x'.repeat(LIMITS.maxIdLength + 1), 'con espacio', 'a/b', '\u0000']) {
      expect(Block.safeParse(text({ id })).success, id).toBe(false)
    }
    expect(Block.safeParse(text({ id: 'x'.repeat(LIMITS.maxIdLength) })).success).toBe(true)
  })
})

describe('adversarial: uniones y enums', () => {
  it('uniones mal discriminadas', () => {
    for (const bad of [
      text({ type: undefined }),
      text({ type: 'TEXT' }),
      text({ type: ['text'] }),
      text({ type: null }),
      { ...text(), type: 'action' },
      { ...text(), type: 'user' },
      { ...base, type: 'permission', text: 'x' },
      [text()],
      null,
      'text',
      42,
    ]) {
      expect(Block.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
      expect(BlockDraft.safeParse(bad).success).toBe(false)
    }
  })

  it('enums desconocidos', () => {
    const action = { ...base, type: 'action', kind: 'exec', status: 'ok', tool: 'T', title: 't' }
    expect(Block.safeParse({ ...action, kind: 'delete' }).success).toBe(false)
    expect(Block.safeParse({ ...action, status: 'done' }).success).toBe(false)
    expect(
      Block.safeParse({ ...base, type: 'usage', stopReason: 'cansancio', usage: {} }).success,
    ).toBe(false)
    expect(ProviderEvent.safeParse({ type: 'turn-end', stopReason: 'x' }).success).toBe(false)
    for (const permissionMode of ['yolo', '', 'ASK', 1]) {
      const r = methods['agent.create'].params.safeParse({
        paneId: 'p',
        provider: 'c',
        permissionMode,
      })
      expect(r.success, String(permissionMode)).toBe(false)
    }
  })

  it('las peticiones con tipos de respuesta cruzados se rechazan', () => {
    const body = (params: unknown) =>
      JSON.stringify({ v: 1, id: '1', method: 'agent.respond', params })
    expect(
      parseRequest(body({ type: 'permission', sessionId: 's', blockId: 'b', answers: [] })).ok,
    ).toBe(false)
    expect(
      parseRequest(body({ type: 'question', sessionId: 's', blockId: 'b', optionId: 'a' })).ok,
    ).toBe(false)
    expect(parseRequest(body({ sessionId: 's', blockId: 'b', optionId: 'a' })).ok).toBe(false)
  })
})

describe('adversarial: __proto__, constructor y claves extra', () => {
  it('__proto__ en un mensaje JSON se rechaza antes de validar', () => {
    const raw =
      '{"v":1,"id":"1","method":"agent.send","params":{"sessionId":"s","text":"x","__proto__":{"polluted":true}}}'
    expect(parseRequest(raw)).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    const ev =
      '{"v":1,"event":"agent.block","seq":1,"data":{"sessionId":"s","block":{"__proto__":{"x":1}}}}'
    expect(parseServerMessage(ev).ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('claves __proto__/constructor/prototype como propias se rechazan', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const payload = JSON.parse(`{"${key}":{"polluted":true}}`) as Record<string, unknown>
      expect(Block.safeParse({ ...text(), ...payload }).success, key).toBe(false)
      expect(AgentSession.safeParse(payload).success).toBe(false)
      const poisoned = JSON.parse(
        `{"type":"exit","exitCode":0,"signal":null,"${key}":1}`,
      ) as unknown
      expect(ProviderEvent.safeParse(poisoned).success).toBe(false)
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('el filtro del testkit detecta __proto__ propio', () => {
    expect(hasProtoKey(JSON.parse('{"a":{"__proto__":1}}'))).toBe(true)
    expect(hasProtoKey({ a: 1 })).toBe(false)
  })

  it('claves extra anidadas se rechazan', () => {
    const q = {
      id: 'q',
      question: '?',
      options: [{ label: 'x', extra: 1 }],
      multiSelect: false,
      allowText: false,
    }
    expect(
      Block.safeParse({ ...base, type: 'question', questions: [q], state: 'pending' }).success,
    ).toBe(false)
    expect(Block.safeParse(text({ usage: {} })).success).toBe(false)
  })
})

describe('adversarial: caracteres de control y sustitutos', () => {
  it('NUL y sustitutos sueltos se rechazan en los campos de texto', () => {
    for (const bad of ['\u0000', 'a\u0000', '\ud800', '\udfff', 'x\ud83d', '\ude00y']) {
      expect(Block.safeParse(text({ text: bad })).success, JSON.stringify(bad)).toBe(false)
      expect(AgentDelta.safeParse(delta({ text: bad })).success).toBe(false)
      expect(Block.safeParse({ ...base, type: 'user', text: bad }).success).toBe(false)
      expect(Block.safeParse({ ...base, type: 'plan', entries: [], markdown: bad }).success).toBe(
        false,
      )
    }
  })

  it('los campos de una línea rechazan control, saltos y sustitutos', () => {
    const action = (over: Record<string, unknown>) => ({
      ...base,
      type: 'action',
      kind: 'read',
      status: 'ok',
      tool: 'Read',
      title: 'Leer',
      ...over,
    })
    for (const bad of ['a\nb', 'a\u001bb', '\u0007', 'a b', '\ud800', '']) {
      expect(Block.safeParse(action({ title: bad })).success, JSON.stringify(bad)).toBe(false)
      expect(Block.safeParse(action({ path: bad })).success).toBe(false)
      expect(Block.safeParse(action({ tool: bad })).success).toBe(false)
    }
  })

  it('texto hostil, tras sanitizar, siempre es válido', () => {
    fc.assert(
      fc.property(arbHostileString, (s) => {
        const clean = sanitizeBodyText(s)
        fc.pre(clean.length > 0 && clean.length < 4000)
        expect(Block.safeParse(text({ text: clean })).success).toBe(true)
      }),
    )
  })

  it('ANSI y OSC en el cuerpo se conservan como texto (la interfaz no los interpreta)', () => {
    const osc = '\u001b]52;c;ZXZpbA==\u0007\u001b[2J'
    expect(Block.parse(text({ text: osc }))).toMatchObject({ text: osc })
  })

  it('valores que no son cadena donde va texto', () => {
    for (const bad of [1, null, {}, [], true, Number.NaN]) {
      expect(Block.safeParse(text({ text: bad })).success).toBe(false)
    }
  })
})

describe('adversarial: entradas arbitrarias', () => {
  it('los esquemas nunca lanzan', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => ProviderEvent.safeParse(value)).not.toThrow()
        expect(() => Block.safeParse(value)).not.toThrow()
      }),
    )
  })
})
