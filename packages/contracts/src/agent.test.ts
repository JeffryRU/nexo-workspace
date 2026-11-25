import { describe, expect, it } from 'vitest'
import {
  AgentRespondParams,
  AgentSession,
  Block,
  BlockDraft,
  blockIssues,
  ProviderCapabilities,
  Question,
} from './agent.ts'
import { applyBlockDelta, validateAnswers } from './agent-blocks.ts'
import { ProviderEvent } from './agent-provider.ts'
import { EVENT_NAMES, events } from './events.ts'
import { LIMITS } from './limits.ts'
import { methods } from './methods.ts'
import { hasLoneSurrogate, sanitizeBodyText, truncateUtf8, utf8ByteLength } from './text.ts'

const base = { id: 'b1', index: 0, turn: 1, seq: 0, createdAt: 1 }
const text = (over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'text',
  text: 'hola',
  complete: false,
  ...over,
})

describe('Block', () => {
  it('acepta cada tipo de bloque', () => {
    const blocks = [
      { ...base, type: 'user', text: 'hola' },
      text(),
      { ...base, type: 'reasoning', text: 'pienso', complete: true },
      {
        ...base,
        type: 'action',
        kind: 'edit',
        status: 'ok',
        tool: 'Edit',
        title: 'Editar a.ts',
        diff: { path: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      },
      {
        ...base,
        type: 'action',
        kind: 'exec',
        status: 'error',
        tool: 'Bash',
        title: 'ls',
        output: 'x',
        exitCode: 2,
      },
      {
        ...base,
        type: 'permission',
        tool: 'Bash',
        title: 'Ejecutar',
        options: [
          { id: 'a', label: 'Sí', kind: 'allow-once' },
          { id: 'r', label: 'No', kind: 'reject-once' },
        ],
        state: 'accepted',
        selectedOptionId: 'a',
      },
      {
        ...base,
        type: 'question',
        questions: [
          {
            id: 'q',
            question: '¿Cuál?',
            options: [{ label: 'A' }],
            multiSelect: false,
            allowText: true,
          },
        ],
        state: 'answered',
        answers: [{ questionId: 'q', selected: ['A'] }],
      },
      { ...base, type: 'plan', entries: [{ text: 'paso', status: 'pending' }], markdown: '# plan' },
      { ...base, type: 'error', code: 'rate_limit', message: 'límite', fatal: false },
      { ...base, type: 'usage', stopReason: 'end-turn', usage: { inputTokens: 1, costUsd: 0.01 } },
    ]
    for (const b of blocks) expect(Block.safeParse(b).success, JSON.stringify(b)).toBe(true)
  })

  it('rechaza tipos desconocidos, claves extra y campos de otro tipo', () => {
    expect(Block.safeParse(text({ type: 'video' })).success).toBe(false)
    expect(Block.safeParse(text({ extra: 1 })).success).toBe(false)
    expect(Block.safeParse({ ...text(), kind: 'read' }).success).toBe(false)
    expect(Block.safeParse({ ...text(), id: '' }).success).toBe(false)
    expect(Block.safeParse({ ...text(), index: -1 }).success).toBe(false)
  })

  it('el borrador no lleva identidad y el bloque sí', () => {
    const { id, index, turn, seq, createdAt, ...draft } = text()
    expect([id, index, turn, seq, createdAt]).toHaveLength(5)
    expect(BlockDraft.safeParse(draft).success).toBe(true)
    expect(BlockDraft.safeParse(text()).success).toBe(false)
    expect(Block.safeParse(draft).success).toBe(false)
  })

  it('aplica las reglas entre campos', () => {
    const perm = (over: Record<string, unknown>) => ({
      ...base,
      type: 'permission',
      tool: 'T',
      title: 't',
      options: [
        { id: 'a', label: 'Sí', kind: 'allow-once' },
        { id: 'r', label: 'No', kind: 'reject-once' },
      ],
      state: 'pending',
      ...over,
    })
    expect(Block.safeParse(perm({ selectedOptionId: 'a' })).success).toBe(false)
    expect(Block.safeParse(perm({ state: 'accepted', selectedOptionId: 'zzz' })).success).toBe(
      false,
    )
    expect(Block.safeParse(perm({ state: 'accepted', selectedOptionId: 'r' })).success).toBe(false)
    expect(Block.safeParse(perm({ state: 'rejected', selectedOptionId: 'a' })).success).toBe(false)
    expect(Block.safeParse(perm({ state: 'rejected', selectedOptionId: 'r' })).success).toBe(true)
    const dup = [
      { id: 'a', label: 'x', kind: 'allow-once' },
      { id: 'a', label: 'y', kind: 'reject-once' },
    ]
    expect(Block.safeParse(perm({ options: dup })).success).toBe(false)
    const q = { id: 'q', question: '?', options: [], multiSelect: false, allowText: true }
    const quest = (over: Record<string, unknown>) => ({
      ...base,
      type: 'question',
      questions: [q],
      state: 'pending',
      ...over,
    })
    expect(Block.safeParse(quest({ state: 'answered' })).success).toBe(false)
    expect(Block.safeParse(quest({ answers: [{ questionId: 'q', selected: [] }] })).success).toBe(
      false,
    )
    expect(Block.safeParse(quest({ questions: [q, q] })).success).toBe(false)
    const act = (over: Record<string, unknown>) => ({
      ...base,
      type: 'action',
      kind: 'read',
      status: 'ok',
      tool: 'Read',
      title: 'Leer',
      ...over,
    })
    expect(Block.safeParse(act({ diff: { path: 'a', patch: 'x' } })).success).toBe(false)
    expect(Block.safeParse(act({ exitCode: 0 })).success).toBe(false)
    expect(blockIssues({ type: 'text' })).toEqual([])
  })

  it('acepta ANSI y saltos en texto, no NUL ni sustitutos sueltos', () => {
    expect(Block.safeParse(text({ text: '\u001b[31mx\u001b[0m\n\t😀' })).success).toBe(true)
    expect(Block.safeParse(text({ text: 'a\u0000b' })).success).toBe(false)
    expect(Block.safeParse(text({ text: '\ud800' })).success).toBe(false)
  })
})

describe('AgentSession y capacidades', () => {
  const session = {
    id: 's1',
    provider: 'claude',
    paneId: 'p1',
    permissionMode: 'ask',
    cwd: '/work',
    status: 'idle',
    turn: 0,
    blockCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  it('valida la sesión', () => {
    expect(AgentSession.safeParse(session).success).toBe(true)
    expect(AgentSession.safeParse({ ...session, status: 'dormido' }).success).toBe(false)
    expect(AgentSession.safeParse({ ...session, provider: 'Claude Code' }).success).toBe(false)
    expect(AgentSession.safeParse({ ...session, model: 'llama3.2:3b' }).success).toBe(true)
    expect(AgentSession.safeParse({ ...session, model: 'con espacio' }).success).toBe(false)
  })
  it('valida las capacidades', () => {
    const caps = {
      models: [{ id: 'm' }],
      efforts: [],
      permissionModes: ['ask'],
      resume: false,
      warmup: false,
      streaming: true,
    }
    expect(ProviderCapabilities.safeParse(caps).success).toBe(true)
    expect(ProviderCapabilities.safeParse({ ...caps, permissionModes: [] }).success).toBe(false)
  })
})

describe('métodos y eventos de agente', () => {
  it('agent.respond distingue permiso y pregunta', () => {
    expect(
      AgentRespondParams.safeParse({
        type: 'permission',
        sessionId: 's',
        blockId: 'b',
        optionId: 'a',
      }).success,
    ).toBe(true)
    expect(
      AgentRespondParams.safeParse({
        type: 'question',
        sessionId: 's',
        blockId: 'b',
        answers: [{ questionId: 'q', selected: ['x'] }],
      }).success,
    ).toBe(true)
    expect(
      AgentRespondParams.safeParse({
        type: 'permission',
        sessionId: 's',
        blockId: 'b',
        answers: [],
      }).success,
    ).toBe(false)
    expect(
      AgentRespondParams.safeParse({ type: 'otro', sessionId: 's', blockId: 'b' }).success,
    ).toBe(false)
  })
  it('agent.snapshot acota la página', () => {
    const p = methods['agent.snapshot'].params
    expect(p.safeParse({ sessionId: 's', limit: LIMITS.maxSnapshotBlocks }).success).toBe(true)
    expect(p.safeParse({ sessionId: 's', limit: LIMITS.maxSnapshotBlocks + 1 }).success).toBe(false)
    expect(p.safeParse({ sessionId: 's', fromIndex: -1 }).success).toBe(false)
  })
  it('agent.send exige texto no vacío y acotado', () => {
    const p = methods['agent.send'].params
    expect(p.safeParse({ sessionId: 's', text: '' }).success).toBe(false)
    expect(
      p.safeParse({ sessionId: 's', text: 'x'.repeat(LIMITS.maxBlockTextBytes + 1) }).success,
    ).toBe(false)
  })
  it('el evento agent.delta exige seq positivo y delta acotado', () => {
    const d = events['agent.delta']
    const ok = { sessionId: 's', blockId: 'b', field: 'text', seq: 1, text: 'x' }
    expect(d.safeParse(ok).success).toBe(true)
    expect(d.safeParse({ ...ok, seq: 0 }).success).toBe(false)
    expect(d.safeParse({ ...ok, text: '' }).success).toBe(false)
    expect(d.safeParse({ ...ok, field: 'input' }).success).toBe(false)
    expect(EVENT_NAMES).toContain('agent.status')
  })
  it('agent.session admite alta y cierre', () => {
    const e = events['agent.session']
    expect(e.safeParse({ sessionId: 's', removed: true }).success).toBe(true)
    expect(e.safeParse({ sessionId: 's', removed: false }).success).toBe(false)
  })
})

describe('ProviderEvent', () => {
  it('acepta los tipos y rechaza desconocidos', () => {
    expect(
      ProviderEvent.safeParse({
        type: 'block-start',
        ref: 'r',
        block: { type: 'text', text: '', complete: false },
      }).success,
    ).toBe(true)
    expect(ProviderEvent.safeParse({ type: 'turn-end', stopReason: 'end-turn' }).success).toBe(true)
    expect(ProviderEvent.safeParse({ type: 'turn-end', stopReason: 'quizá' }).success).toBe(false)
    expect(ProviderEvent.safeParse({ type: 'magia' }).success).toBe(false)
    expect(ProviderEvent.safeParse({ type: 'exit', exitCode: null, signal: null }).success).toBe(
      true,
    )
  })
})

describe('applyBlockDelta', () => {
  const block = Block.parse(text())
  const delta = (over: Record<string, unknown>) => ({
    sessionId: 's' as never,
    blockId: 'b1' as never,
    field: 'text' as const,
    seq: 1,
    text: ' mundo',
    ...over,
  })
  it('añade texto y avanza seq', () => {
    const r = applyBlockDelta(block, delta({}))
    expect(r).toMatchObject({ status: 'applied', block: { text: 'hola mundo', seq: 1 } })
  })
  it('ignora repetidos, detecta huecos y rechaza lo que no corresponde', () => {
    const applied = applyBlockDelta(block, delta({}))
    if (applied.status !== 'applied') throw new Error('esperaba applied')
    expect(applyBlockDelta(applied.block, delta({ seq: 1 })).status).toBe('duplicate')
    expect(applyBlockDelta(block, delta({ seq: 3 })).status).toBe('gap')
    expect(applyBlockDelta(block, delta({ blockId: 'otro' })).status).toBe('invalid')
    expect(applyBlockDelta(block, delta({ field: 'output' })).status).toBe('invalid')
    expect(applyBlockDelta(Block.parse(text({ complete: true })), delta({})).status).toBe('invalid')
  })
  it('recorta en el tope sin partir caracteres y marca truncated', () => {
    const full = Block.parse(text({ text: 'a'.repeat(LIMITS.maxBlockTextBytes - 2) }))
    const r = applyBlockDelta(full, delta({ text: '😀😀' }))
    if (r.status !== 'applied') throw new Error('esperaba applied')
    expect(r.block).toMatchObject({ truncated: true, seq: 1 })
    if (r.block.type !== 'text') throw new Error('tipo')
    expect(utf8ByteLength(r.block.text)).toBeLessThanOrEqual(LIMITS.maxBlockTextBytes)
    expect(hasLoneSurrogate(r.block.text)).toBe(false)
    const again = applyBlockDelta(r.block, delta({ seq: 2 }))
    expect(again).toMatchObject({ status: 'applied', block: { seq: 2, truncated: true } })
  })
  it('añade salida a una acción en curso y no a una terminada', () => {
    const act = Block.parse({
      ...base,
      type: 'action',
      kind: 'exec',
      status: 'running',
      tool: 'Bash',
      title: 'ls',
    })
    const r = applyBlockDelta(act, delta({ field: 'output', text: 'x\n' }))
    expect(r).toMatchObject({ status: 'applied', block: { output: 'x\n' } })
    const done = Block.parse({ ...act, status: 'ok' })
    expect(applyBlockDelta(done, delta({ field: 'output' })).status).toBe('invalid')
  })
})

describe('validateAnswers', () => {
  const qs = [
    Question.parse({
      id: 'a',
      question: '¿A?',
      options: [{ label: 'x' }, { label: 'y' }],
      multiSelect: false,
      allowText: false,
    }),
    Question.parse({
      id: 'b',
      question: '¿B?',
      options: [{ label: 'x' }, { label: 'y' }],
      multiSelect: true,
      allowText: true,
    }),
  ]
  it('acepta respuestas completas y coherentes', () => {
    expect(
      validateAnswers(qs, [
        { questionId: 'a', selected: ['x'] },
        { questionId: 'b', selected: ['x', 'y'], text: 'más' },
      ]),
    ).toBeNull()
  })
  it('rechaza lo incoherente', () => {
    const a = { questionId: 'a', selected: ['x'] }
    const b = { questionId: 'b', selected: ['y'] }
    expect(validateAnswers(qs, [a])).toMatch(/faltan/)
    expect(validateAnswers(qs, [a, a, b])).toMatch(/dos veces/)
    expect(validateAnswers(qs, [{ questionId: 'z', selected: [] }])).toMatch(/desconocida/)
    expect(validateAnswers(qs, [{ ...a, selected: ['q'] }, b])).toMatch(/opción desconocida/)
    expect(validateAnswers(qs, [{ ...a, selected: ['x', 'y'] }, b])).toMatch(/una sola/)
    expect(validateAnswers(qs, [{ ...a, selected: ['x', 'x'] }, b])).toMatch(/repetida/)
    expect(validateAnswers(qs, [{ ...a, text: 'libre' }, b])).toMatch(/texto libre/)
    expect(validateAnswers(qs, [{ questionId: 'a', selected: [] }, b])).toMatch(/sin respuesta/)
  })
})

describe('utilidades de texto', () => {
  it('sanitizeBodyText reemplaza NUL y sustitutos sueltos', () => {
    expect(sanitizeBodyText('a\u0000b\ud800c\udc00d😀')).toBe('a�b�c�d😀')
    expect(hasLoneSurrogate(sanitizeBodyText('\ud83d'))).toBe(false)
  })
  it('truncateUtf8 respeta el tope', () => {
    expect(truncateUtf8('abc', 10)).toBe('abc')
    expect(truncateUtf8('añb', 2)).toBe('a')
    expect(truncateUtf8('😀😀', 5)).toBe('😀')
  })
})
