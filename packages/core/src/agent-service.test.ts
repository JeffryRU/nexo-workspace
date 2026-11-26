import {
  type AgentSessionId,
  type BlockId,
  type ProviderEvent,
  utf8ByteLength,
} from '@nexo/contracts'
import { bootAgentHarness, type FakeStep, textTurn } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { DomainError } from './errors.ts'

export async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'OK'
}

export const emit = (event: ProviderEvent, delayMs?: number): FakeStep =>
  delayMs === undefined ? { type: 'emit', event } : { type: 'emit', event, delayMs }

export const textDraft = (text: string, complete = false) => ({
  type: 'text' as const,
  text,
  complete,
})

export const start = (ref: string, text = ''): FakeStep =>
  emit({ type: 'block-start', ref, block: textDraft(text) })
export const delta = (ref: string, text: string): FakeStep =>
  emit({ type: 'block-delta', ref, field: 'text', text })
export const end = (ref: string, text?: string): FakeStep =>
  emit({
    type: 'block-end',
    ref,
    ...(text === undefined ? {} : { block: textDraft(text, true) }),
  })

const PERMISSION = emit({
  type: 'permission-request',
  requestId: 'req-1',
  tool: 'Bash',
  title: 'Ejecutar ls',
  options: [
    { id: 'allow', label: 'Permitir', kind: 'allow-once' },
    { id: 'deny', label: 'Rechazar', kind: 'reject-once' },
  ],
})

const PERMISSION_EVENT: ProviderEvent = {
  type: 'permission-request',
  requestId: 'req-1',
  tool: 'Bash',
  title: 'Ejecutar ls',
  options: [
    { id: 'allow', label: 'Permitir', kind: 'allow-once' },
    { id: 'deny', label: 'Rechazar', kind: 'reject-once' },
  ],
}

const QUESTION = emit({
  type: 'question-request',
  requestId: 'q-1',
  questions: [
    {
      id: 'color',
      question: '¿Qué color?',
      options: [{ label: 'rojo' }, { label: 'azul' }],
      multiSelect: false,
      allowText: false,
    },
  ],
})

describe('AgentService: sesiones', () => {
  it('crea la sesión, la enlaza al panel y la anuncia', async () => {
    const t = await bootAgentHarness()
    const { session } = await t.create()
    expect(session).toMatchObject({
      provider: 'fake',
      paneId: t.paneId,
      permissionMode: 'ask',
      cwd: '/work',
      status: 'idle',
      turn: 0,
      blockCount: 0,
    })
    expect(session.providerSessionId).toBe('fake-session-1')
    const pane = t.layout.snapshot()[0]?.tabs[0]?.panes.find((p) => p.id === t.paneId)
    expect(pane?.agentSessionId).toBe(session.id)
    expect(t.bus.ofType('agent.session')).toEqual([{ session }])
    expect(t.service.list()).toEqual({ sessions: [session] })
  })

  it('rechaza proveedor desconocido, panel inexistente, panel de terminal y segunda sesión', async () => {
    const t = await bootAgentHarness()
    const terminalPane = t.tab.panes[0]?.id as typeof t.paneId
    expect(await codeOf(() => t.service.create({ paneId: t.paneId, provider: 'otro' }))).toBe(
      'PROVIDER_UNAVAILABLE',
    )
    expect(
      await codeOf(() => t.service.create({ paneId: 'nada' as typeof t.paneId, provider: 'fake' })),
    ).toBe('NOT_FOUND')
    expect(await codeOf(() => t.service.create({ paneId: terminalPane, provider: 'fake' }))).toBe(
      'CONFLICT',
    )
    await t.create()
    expect(await codeOf(() => t.service.create({ paneId: t.paneId, provider: 'fake' }))).toBe(
      'CONFLICT',
    )
  })

  it('traduce los errores del proveedor al abrir', async () => {
    const t = await bootAgentHarness()
    t.provider.available = false
    expect(await codeOf(() => t.service.create({ paneId: t.paneId, provider: 'fake' }))).toBe(
      'PROVIDER_UNAVAILABLE',
    )
    t.provider.available = true
    expect(
      await codeOf(() => t.service.create({ paneId: t.paneId, provider: 'fake', model: 'x' })),
    ).toBe('INVALID_PARAMS')
    expect(t.service.list().sessions).toEqual([])
  })

  it('agent.providers describe a cada proveedor y tolera uno roto', async () => {
    const t = await bootAgentHarness()
    const { providers } = await t.service.providers()
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({ id: 'fake', available: true })
    t.provider.caps = { ...t.provider.caps, models: [{ id: 'con espacios' }] }
    const broken = (await t.service.providers()).providers[0]
    expect(broken?.available).toBe(false)
    expect(broken?.capabilities.models).toEqual([])
  })

  it('agent.providers informa el motivo de un proveedor no disponible, saneado, y tolera que falle', async () => {
    const t = await bootAgentHarness()
    t.provider.available = false
    t.provider.reason = 'Ollama no responde\u001b[31m\ny m\u00e1s'
    const down = (await t.service.providers()).providers[0]
    expect(down).toMatchObject({ available: false, reason: 'Ollama no responde [31m y m\u00e1s' })
    t.provider.reason = 'x'.repeat(2000)
    expect((await t.service.providers()).providers[0]?.reason).toHaveLength(512)
    t.provider.reason = 'lanza'
    const failing = (await t.service.providers()).providers[0]
    expect(failing?.available).toBe(false)
    expect(failing?.reason).toBeUndefined()
    t.provider.available = true
    t.provider.reason = 'ya no aplica'
    expect((await t.service.providers()).providers[0]?.reason).toBeUndefined()
  })

  it('aplica el tope de sesiones, también con aperturas concurrentes', async () => {
    const t = await bootAgentHarness({ config: { maxSessions: 2 } })
    const panes = [t.paneId]
    for (let i = 0; i < 3; i++) {
      panes.push(t.workspaces.split({ paneId: t.paneId, direction: 'row', kind: 'agent' }).pane.id)
    }
    const codes = await Promise.all(
      panes.map((paneId) => codeOf(() => t.service.create({ paneId, provider: 'fake' }))),
    )
    expect(codes.filter((c) => c === 'OK')).toHaveLength(2)
    expect(codes.filter((c) => c === 'CONFLICT')).toHaveLength(2)
  })

  it('cerrar la sesión la quita, libera el panel y es una sola vez', async () => {
    const t = await bootAgentHarness()
    const { session, fake } = await t.create()
    await t.service.close({ sessionId: session.id })
    expect(fake.closed).toBe(true)
    expect(t.service.list().sessions).toEqual([])
    expect(t.bus.ofType('agent.session').at(-1)).toEqual({ sessionId: session.id, removed: true })
    const pane = t.layout.snapshot()[0]?.tabs[0]?.panes.find((p) => p.id === t.paneId)
    expect(pane?.agentSessionId).toBeUndefined()
    expect(await codeOf(() => t.service.close({ sessionId: session.id }))).toBe('NOT_FOUND')
    await t.create()
  })

  it('cerrar el panel (o su pestaña) cierra la sesión', async () => {
    const t = await bootAgentHarness()
    const { fake } = await t.create()
    t.workspaces.closePane({ paneId: t.paneId })
    await Promise.resolve()
    expect(fake.closed).toBe(true)
    expect(t.service.list().sessions).toEqual([])
    const again = await t.create(
      t.workspaces.split({
        paneId: t.tab.panes[0]?.id as typeof t.paneId,
        direction: 'row',
        kind: 'agent',
      }).pane.id,
    )
    t.workspaces.closeTab({ tabId: t.tab.id })
    await Promise.resolve()
    expect(again.fake.closed).toBe(true)
  })

  it('closeAll cierra todo', async () => {
    const t = await bootAgentHarness()
    const { fake } = await t.create()
    await t.service.closeAll()
    expect(fake.closed).toBe(true)
  })

  it('session-info actualiza modelo, ficha y título y lo anuncia', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [
      emit({ type: 'session-info', model: 'fake-2', title: 'Hola', permissionMode: 'plan' }),
      ...textTurn(['x']),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'hola' })
    t.settle()
    const latest = t.service.list().sessions[0]
    expect(latest).toMatchObject({ model: 'fake-2', title: 'Hola', permissionMode: 'plan' })
    expect(t.bus.ofType('agent.session').at(-1)).toMatchObject({
      session: { model: 'fake-2', title: 'Hola', permissionMode: 'plan' },
    })
  })
})

describe('AgentService: documento', () => {
  it('un turno de texto produce user, text y usage con index sin huecos y turn', async () => {
    const t = await bootAgentHarness()
    const { session } = await t.create()
    const sent = await t.service.send({ sessionId: session.id, text: 'hola' })
    expect(sent).toMatchObject({ index: 0, turn: 1 })
    t.settle()
    const snap = t.service.snapshot({ sessionId: session.id })
    expect(snap.blocks.map((b) => [b.index, b.type, b.turn])).toEqual([
      [0, 'user', 1],
      [1, 'text', 1],
      [2, 'usage', 1],
    ])
    expect(snap.blocks[1]).toMatchObject({ type: 'text', text: 'Hola mundo', complete: true })
    expect(snap.blocks[0]?.id).toBe(sent.blockId)
    expect(snap.session).toMatchObject({ status: 'done', turn: 1, blockCount: 3 })
    expect(snap.nextIndex).toBeNull()
  })

  it('un segundo turno continúa los index y sube el turn', async () => {
    const t = await bootAgentHarness()
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'uno' })
    t.settle()
    const second = await t.service.send({ sessionId: session.id, text: 'dos' })
    t.settle()
    expect(second).toMatchObject({ index: 3, turn: 2 })
    expect(t.service.snapshot({ sessionId: session.id }).blocks).toHaveLength(6)
  })

  it('agrupa los deltas por lote: pocos eventos para muchos deltas', async () => {
    const t = await bootAgentHarness({ config: { batchMs: 20 } })
    const parts = Array.from({ length: 50 }, (_, i) => `p${i} `)
    t.provider.script = () => [start('t'), ...parts.map((p) => delta('t', p)), end('t')]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const deltas = t.bus.ofType('agent.delta')
    expect(deltas.length).toBeLessThan(5)
    expect(deltas.map((d) => d.seq)).toEqual(deltas.map((_, i) => i + 1))
    expect(deltas.map((d) => d.text).join('')).toBe(parts.join(''))
    const block = t.service.snapshot({ sessionId: session.id }).blocks[1]
    expect(block).toMatchObject({ text: parts.join(''), seq: deltas.length, complete: true })
  })

  it('emite el lote al vencer el intervalo, no antes', async () => {
    const t = await bootAgentHarness({ config: { batchMs: 50 } })
    t.provider.script = () => [start('t'), delta('t', 'a'), delta('t', 'b'), { type: 'hang' }]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.clock.advance(10)
    expect(t.bus.ofType('agent.delta')).toHaveLength(0)
    t.clock.advance(60)
    expect(t.bus.ofType('agent.delta')).toEqual([
      { sessionId: session.id, blockId: expect.any(String), field: 'text', seq: 1, text: 'ab' },
    ])
  })

  it('parte un lote mayor que el tope de delta y respeta los caracteres', async () => {
    const t = await bootAgentHarness({ config: { maxDeltaBytes: 8 } })
    t.provider.script = () => [start('t'), delta('t', '😀😀😀😀😀'), end('t')]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const deltas = t.bus.ofType('agent.delta')
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.map((d) => d.text).join('')).toBe('😀😀😀😀😀')
    for (const d of deltas) expect(d.text).toMatch(/^(?:😀)+$/u)
  })

  it('un bloque de acción acumula su salida por deltas', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [
      emit({
        type: 'block-start',
        ref: 'c1',
        block: { type: 'action', kind: 'exec', status: 'running', tool: 'Bash', title: 'ls' },
      }),
      emit({ type: 'block-delta', ref: 'c1', field: 'output', text: 'a\n' }),
      emit({ type: 'block-delta', ref: 'c1', field: 'output', text: 'b\n' }),
      emit({
        type: 'block-end',
        ref: 'c1',
        block: {
          type: 'action',
          kind: 'exec',
          status: 'ok',
          tool: 'Bash',
          title: 'ls',
          output: 'a\nb\n',
          exitCode: 0,
        },
      }),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    expect(t.service.snapshot({ sessionId: session.id }).blocks[1]).toMatchObject({
      type: 'action',
      status: 'ok',
      output: 'a\nb\n',
      exitCode: 0,
    })
  })

  it('block-update sustituye el contenido conservando id, index y seq', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [
      start('t', 'a'),
      emit({ type: 'block-update', ref: 't', block: textDraft('nuevo') }),
      end('t'),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const blocks = t.bus.ofType('agent.block').map((e) => e.block)
    const ofText = blocks.filter((b) => b.type === 'text')
    expect(new Set(ofText.map((b) => b.id)).size).toBe(1)
    expect(ofText.map((b) => (b.type === 'text' ? b.text : ''))).toEqual(['a', 'nuevo', 'nuevo'])
    expect(ofText.at(-1)).toMatchObject({ complete: true })
  })

  it('al terminar el turno cierra lo que el proveedor dejó abierto', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [
      start('t', 'a'),
      emit({
        type: 'block-start',
        ref: 'c',
        block: { type: 'action', kind: 'read', status: 'running', tool: 'Read', title: 'x' },
      }),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const blocks = t.service.snapshot({ sessionId: session.id }).blocks
    expect(blocks[1]).toMatchObject({ type: 'text', complete: true })
    expect(blocks[2]).toMatchObject({ type: 'action', status: 'error' })
    expect(blocks[3]?.type).toBe('usage')
  })

  it('un error no fatal queda en el documento y el turno sigue', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [
      emit({
        type: 'error',
        error: { code: 'RATE', message: 'espera', fatal: false, retryable: true },
      }),
      ...textTurn(['ok']),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const blocks = t.service.snapshot({ sessionId: session.id }).blocks
    expect(blocks[1]).toMatchObject({ type: 'error', code: 'RATE', fatal: false, retryable: true })
    expect(blocks.at(-1)?.type).toBe('usage')
  })

  it('un turn-end con usage previo lo copia al bloque usage', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [
      emit({ type: 'usage', usage: { inputTokens: 7 } }),
      emit({ type: 'turn-end', stopReason: 'max-tokens' }),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    expect(t.service.snapshot({ sessionId: session.id }).blocks[1]).toMatchObject({
      type: 'usage',
      stopReason: 'max-tokens',
      usage: { inputTokens: 7 },
    })
  })
})

describe('AgentService: turnos', () => {
  it('un solo turno a la vez', async () => {
    const t = await bootAgentHarness()
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'long' })
    expect(await codeOf(() => t.service.send({ sessionId: session.id, text: 'otro' }))).toBe(
      'CONFLICT',
    )
    expect(
      await codeOf(() => t.service.send({ sessionId: 'no' as AgentSessionId, text: 'x' })),
    ).toBe('NOT_FOUND')
  })

  it('interrumpir termina el turno en reposo y deja enviar otro', async () => {
    const t = await bootAgentHarness()
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'long' })
    t.settle()
    await t.service.interrupt({ sessionId: session.id })
    t.settle()
    const snap = t.service.snapshot({ sessionId: session.id })
    expect(snap.session.status).toBe('idle')
    expect(snap.blocks.at(-1)).toMatchObject({ type: 'usage', stopReason: 'interrupted' })
    await t.service.interrupt({ sessionId: session.id })
    await t.service.send({ sessionId: session.id, text: 'otra' })
  })

  it('el estado de atención llega al panel y al evento pane.attention', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [PERMISSION, ...textTurn(['x'])]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const pane = () => t.layout.snapshot()[0]?.tabs[0]?.panes.find((p) => p.id === t.paneId)
    expect(pane()?.attention).toBe('needs-input')
    const block = t.service.snapshot({ sessionId: session.id }).blocks[1]
    await t.service.respond({
      type: 'permission',
      sessionId: session.id,
      blockId: block?.id as BlockId,
      optionId: 'allow',
    })
    t.settle()
    expect(pane()?.attention).toBe('done')
    expect(t.bus.ofType('pane.attention').map((e) => e.attention)).toEqual([
      'working',
      'needs-input',
      'working',
      'done',
    ])
    expect(t.bus.ofType('agent.status').map((e) => e.status)).toEqual([
      'working',
      'needs-input',
      'working',
      'done',
    ])
    await t.service.close({ sessionId: session.id })
    expect(pane()?.attention).toBe('idle')
  })

  it('un turn-end con error deja la sesión en error pero sigue abierta', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [emit({ type: 'turn-end', stopReason: 'error' })]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    expect(t.service.list().sessions[0]?.status).toBe('error')
    t.provider.script = () => textTurn(['ok'])
    await t.service.send({ sessionId: session.id, text: 'otra vez' })
    t.settle()
    expect(t.service.list().sessions[0]?.status).toBe('done')
  })

  it('send rechazado por el proveedor deja un error legible y la sesión usable', async () => {
    const t = await bootAgentHarness()
    const { session, fake } = await t.create()
    const original = fake.send.bind(fake)
    fake.send = async () => {
      throw new Error('boom\u0000\n')
    }
    expect(await codeOf(() => t.service.send({ sessionId: session.id, text: 'x' }))).toBe(
      'INTERNAL',
    )
    const blocks = t.service.snapshot({ sessionId: session.id }).blocks
    expect(blocks.map((b) => b.type)).toEqual(['user', 'error'])
    expect(t.service.list().sessions[0]?.status).toBe('error')
    fake.send = original
    await t.service.send({ sessionId: session.id, text: 'bien' })
  })

  it('send con la sesión del proveedor ya cerrada la deja en error', async () => {
    const t = await bootAgentHarness()
    const { session, fake } = await t.create()
    fake.crash()
    expect(await codeOf(() => t.service.send({ sessionId: session.id, text: 'x' }))).toBe(
      'CONFLICT',
    )
  })

  it('aplica maxBlocksPerSession con CONFLICT y deja las posiciones reservadas', async () => {
    const t = await bootAgentHarness({ config: { maxBlocksPerSession: 12, reservedBlocks: 4 } })
    const { session } = await t.create()
    let turns = 0
    for (;;) {
      const code = await codeOf(() => t.service.send({ sessionId: session.id, text: 'hola' }))
      if (code !== 'OK') {
        expect(code).toBe('CONFLICT')
        break
      }
      t.settle()
      if (++turns > 20) throw new Error('no se alcanzó el tope')
    }
    const snap = t.service.snapshot({ sessionId: session.id })
    expect(snap.blocks.length).toBeLessThanOrEqual(12)
    expect(snap.blocks.map((b) => b.index)).toEqual(snap.blocks.map((_, i) => i))
  })

  it('los bloques del proveedor que no caben se descartan y se cuentan', async () => {
    const t = await bootAgentHarness({ config: { maxBlocksPerSession: 6, reservedBlocks: 2 } })
    t.provider.script = () => [
      ...[1, 2, 3, 4, 5, 6].flatMap((n) => [
        start(`b${n}`, 'x'),
        delta(`b${n}`, 'y'),
        end(`b${n}`),
      ]),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const snap = t.service.snapshot({ sessionId: session.id })
    expect(snap.blocks.length).toBeLessThanOrEqual(6)
    expect(snap.blocks.at(-1)?.type).toBe('usage')
    expect(t.service.stats(session.id)?.droppedBlocks).toBeGreaterThan(0)
    expect(t.service.stats(session.id)?.invalidEvents).toBe(0)
  })
})

describe('AgentService: permisos y preguntas', () => {
  const permissionBlock = (t: Awaited<ReturnType<typeof bootAgentHarness>>, id: AgentSessionId) =>
    t.service.snapshot({ sessionId: id }).blocks.find((b) => b.type === 'permission')

  it('crea el bloque, responde al proveedor y lo resuelve', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [PERMISSION, ...textTurn(['listo'])]
    const { session, fake } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const block = permissionBlock(t, session.id)
    expect(block).toMatchObject({ type: 'permission', state: 'pending', tool: 'Bash' })
    await t.service.respond({
      type: 'permission',
      sessionId: session.id,
      blockId: block?.id as BlockId,
      optionId: 'allow',
    })
    expect(fake.responses).toEqual([{ type: 'permission', requestId: 'req-1', optionId: 'allow' }])
    expect(permissionBlock(t, session.id)).toMatchObject({
      state: 'accepted',
      selectedOptionId: 'allow',
    })
    t.settle()
    expect(t.service.list().sessions[0]?.status).toBe('done')
  })

  it('rechazar marca rejected', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [PERMISSION, ...textTurn(['listo'])]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    await t.service.respond({
      type: 'permission',
      sessionId: session.id,
      blockId: permissionBlock(t, session.id)?.id as BlockId,
      optionId: 'deny',
    })
    expect(permissionBlock(t, session.id)).toMatchObject({ state: 'rejected' })
  })

  it('errores tipados al responder: desconocido, doble, tipo, opción', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [PERMISSION, ...textTurn(['listo'])]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const id = permissionBlock(t, session.id)?.id as BlockId
    const permission = (blockId: BlockId, optionId = 'allow') =>
      t.service.respond({ type: 'permission', sessionId: session.id, blockId, optionId })
    expect(await codeOf(() => permission('nada' as BlockId))).toBe('NOT_FOUND')
    expect(await codeOf(() => permission(id, 'zzz'))).toBe('INVALID_PARAMS')
    expect(
      await codeOf(() =>
        t.service.respond({
          type: 'question',
          sessionId: session.id,
          blockId: id,
          answers: [{ questionId: 'a', selected: ['b'] }],
        }),
      ),
    ).toBe('INVALID_PARAMS')
    expect(
      await codeOf(() =>
        permission(t.service.snapshot({ sessionId: session.id }).blocks[0]?.id as BlockId),
      ),
    ).toBe('INVALID_PARAMS')
    await permission(id)
    expect(await codeOf(() => permission(id))).toBe('CONFLICT')
    expect(
      await codeOf(() =>
        t.service.respond({
          type: 'permission',
          sessionId: 'no' as AgentSessionId,
          blockId: id,
          optionId: 'allow',
        }),
      ),
    ).toBe('NOT_FOUND')
  })

  it('dos respuestas simultáneas: una gana y la otra recibe CONFLICT', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [PERMISSION, ...textTurn(['listo'])]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const blockId = permissionBlock(t, session.id)?.id as BlockId
    const go = (optionId: string) =>
      codeOf(() =>
        t.service.respond({ type: 'permission', sessionId: session.id, blockId, optionId }),
      )
    const codes = await Promise.all([go('allow'), go('deny')])
    expect(codes.sort()).toEqual(['CONFLICT', 'OK'])
  })

  it('una pregunta se responde con validateAnswers', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [QUESTION, ...textTurn(['listo'])]
    const { session, fake } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const block = t.service.snapshot({ sessionId: session.id }).blocks[1]
    expect(block).toMatchObject({ type: 'question', state: 'pending' })
    const respond = (selected: string[]) =>
      t.service.respond({
        type: 'question',
        sessionId: session.id,
        blockId: block?.id as BlockId,
        answers: [{ questionId: 'color', selected }],
      })
    expect(await codeOf(() => respond(['verde']))).toBe('INVALID_PARAMS')
    expect(await codeOf(() => respond(['rojo', 'azul']))).toBe('INVALID_PARAMS')
    await respond(['rojo'])
    expect(fake.responses[0]).toMatchObject({ type: 'question', requestId: 'q-1' })
    expect(t.service.snapshot({ sessionId: session.id }).blocks[1]).toMatchObject({
      state: 'answered',
      answers: [{ questionId: 'color', selected: ['rojo'] }],
    })
  })

  it('interrumpir cancela lo pendiente; responder después da CONFLICT', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [PERMISSION, QUESTION_AFTER]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const id = permissionBlock(t, session.id)?.id as BlockId
    await t.service.interrupt({ sessionId: session.id })
    t.settle()
    const blocks = t.service.snapshot({ sessionId: session.id }).blocks
    expect(blocks.filter((b) => b.type === 'permission')).toMatchObject([{ state: 'cancelled' }])
    expect(t.service.list().sessions[0]?.status).toBe('idle')
    expect(t.service.stats(session.id)?.invalidEvents).toBe(0)
    expect(
      await codeOf(() =>
        t.service.respond({
          type: 'permission',
          sessionId: session.id,
          blockId: id,
          optionId: 'allow',
        }),
      ),
    ).toBe('CONFLICT')
  })

  it('request-cancelled del proveedor cancela el bloque', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [
      { type: 'raw', value: PERMISSION_EVENT },
      emit({ type: 'request-cancelled', requestId: 'req-1' }),
      emit({ type: 'turn-end', stopReason: 'end-turn' }),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    expect(permissionBlock(t, session.id)).toMatchObject({ state: 'cancelled' })
  })

  it('el proveedor rechaza la respuesta con UNKNOWN_REQUEST: el bloque queda cancelado', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [PERMISSION]
    const { session, fake } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    fake.respond = async () => {
      const { AgentProviderError } = await import('./ports/agent.ts')
      throw new AgentProviderError('UNKNOWN_REQUEST', 'ya no existe')
    }
    expect(
      await codeOf(() =>
        t.service.respond({
          type: 'permission',
          sessionId: session.id,
          blockId: permissionBlock(t, session.id)?.id as BlockId,
          optionId: 'allow',
        }),
      ),
    ).toBe('CONFLICT')
    expect(permissionBlock(t, session.id)).toMatchObject({ state: 'cancelled' })
  })
})

const QUESTION_AFTER: FakeStep = QUESTION

describe('AgentService: cierre y fallos del proveedor', () => {
  it('exit sin pedirlo deja la sesión en error, sin más turnos, legible hasta cerrarla', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [start('t', 'a'), { type: 'die', exitCode: 3 }]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const snap = t.service.snapshot({ sessionId: session.id })
    expect(snap.session.status).toBe('error')
    expect(snap.blocks.map((b) => b.type)).toEqual(['user', 'text', 'error'])
    expect(snap.blocks[1]).toMatchObject({ complete: true })
    expect(snap.blocks[2]).toMatchObject({ code: 'EXITED', fatal: true })
    expect(await codeOf(() => t.service.send({ sessionId: session.id, text: 'y' }))).toBe(
      'CONFLICT',
    )
    await t.service.close({ sessionId: session.id })
  })

  it('un error fatal cierra la sesión del proveedor', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [
      emit({ type: 'error', error: { code: 'AUTH', message: 'sin sesión', fatal: true } }),
    ]
    const { session, fake } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    expect(t.service.list().sessions[0]).toMatchObject({ status: 'error' })
    expect(fake.closed).toBe(true)
    expect(t.bus.ofType('agent.status').at(-1)?.reason).toBe('sin sesión')
  })

  it('un proveedor que no responde a la interrupción pasa a error por tiempo', async () => {
    const t = await bootAgentHarness({ config: { interruptTimeoutMs: 100 } })
    const { session, fake } = await t.create()
    t.provider.script = () => [{ type: 'hang' }]
    await t.service.send({ sessionId: session.id, text: 'x' })
    fake.interrupt = async () => {}
    await t.service.interrupt({ sessionId: session.id })
    t.clock.advance(99)
    expect(t.service.list().sessions[0]?.status).toBe('working')
    t.clock.advance(5)
    expect(t.service.list().sessions[0]?.status).toBe('error')
    expect(fake.closed).toBe(true)
  })

  it('cerrar con un turno y deltas pendientes no emite nada más', async () => {
    const t = await bootAgentHarness({ config: { batchMs: 50 } })
    t.provider.script = () => [start('t'), delta('t', 'pendiente'), { type: 'hang' }]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    await t.service.close({ sessionId: session.id })
    const before = t.bus.events.length
    t.settle()
    expect(t.bus.events.length).toBe(before)
    expect(t.clock.pending).toBe(0)
  })
})

describe('AgentService: eventos inválidos', () => {
  it('descarta y cuenta los eventos inválidos sin romper la sesión', async () => {
    const t = await bootAgentHarness()
    t.provider.script = () => [
      { type: 'raw', value: { type: 'nada' } },
      { type: 'raw', value: 'texto' },
      { type: 'raw', value: null },
      ...textTurn(['ok']),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    expect(t.service.stats(session.id)?.invalidEvents).toBe(3)
    expect(t.service.list().sessions[0]?.status).toBe('done')
  })

  it('demasiados inválidos seguidos cierran la sesión en error', async () => {
    const t = await bootAgentHarness({ config: { maxConsecutiveInvalid: 5 } })
    t.provider.script = () => [
      ...Array.from({ length: 20 }, (): FakeStep => ({ type: 'raw', value: { basura: true } })),
      ...textTurn(['no llega']),
    ]
    const { session, fake } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    expect(t.service.list().sessions[0]?.status).toBe('error')
    expect(fake.closed).toBe(true)
    expect(t.service.stats(session.id)?.invalidEvents).toBe(5)
  })

  it('un evento válido corta la racha', async () => {
    const t = await bootAgentHarness({ config: { maxConsecutiveInvalid: 3 } })
    const bad: FakeStep = { type: 'raw', value: 1 }
    t.provider.script = () => [bad, bad, ...textTurn(['a']), bad, bad]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    expect(t.service.list().sessions[0]?.status).not.toBe('error')
  })
})

describe('AgentService: tamaño y paginación', () => {
  it('recorta un bloque cuyo JSON no cabe en un mensaje y lo marca truncated', async () => {
    const t = await bootAgentHarness({ config: { maxMessageBytes: 64 * 1024 } })
    const big = '\u001b'.repeat(30 * 1024)
    t.provider.script = () => [
      emit({
        type: 'block-start',
        ref: 'c',
        block: {
          type: 'action',
          kind: 'edit',
          status: 'ok',
          tool: 'Edit',
          title: 'e',
          output: big,
          diff: { path: 'a.ts', patch: big },
        },
      }),
      end('c'),
    ]
    t.provider.script = () => [
      emit({
        type: 'block-start',
        ref: 'c',
        block: {
          type: 'action',
          kind: 'edit',
          status: 'ok',
          tool: 'Edit',
          title: 'e',
          output: big,
          diff: { path: 'a.ts', patch: big },
        },
      }),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    for (const e of t.bus.ofType('agent.block')) {
      expect(utf8ByteLength(JSON.stringify(e))).toBeLessThanOrEqual(64 * 1024)
    }
    expect(t.service.snapshot({ sessionId: session.id }).blocks[1]).toMatchObject({
      type: 'action',
      truncated: true,
    })
  })

  it('un delta que haría pasar un bloque de acción del tamaño se envía como reemplazo recortado', async () => {
    const t = await bootAgentHarness({ config: { maxMessageBytes: 64 * 1024, batchMs: 1 } })
    const patch = '\u001b'.repeat(8 * 1024)
    t.provider.script = () => [
      emit({
        type: 'block-start',
        ref: 'c',
        block: {
          type: 'action',
          kind: 'edit',
          status: 'running',
          tool: 'Edit',
          title: 'e',
          diff: { path: 'a.ts', patch },
        },
      }),
      ...Array.from(
        { length: 6 },
        (): FakeStep =>
          emit(
            { type: 'block-delta', ref: 'c', field: 'output', text: '\u001b'.repeat(4 * 1024) },
            5,
          ),
      ),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const block = t.service.snapshot({ sessionId: session.id }).blocks[1]
    expect(block).toMatchObject({ truncated: true })
    expect(utf8ByteLength(JSON.stringify(block))).toBeLessThanOrEqual(64 * 1024)
  })

  it('agent.snapshot pagina por index y puede devolver menos que limit por tamaño', async () => {
    const t = await bootAgentHarness({ config: { maxMessageBytes: 24 * 1024 } })
    const text = 'x'.repeat(4 * 1024)
    t.provider.script = () => [
      ...[1, 2, 3, 4, 5].flatMap((n) => [start(`b${n}`, text), end(`b${n}`)]),
    ]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.settle()
    const total = t.service.snapshot({ sessionId: session.id, limit: 200 })
    expect(total.blocks.length).toBeLessThan(7)
    const seen: number[] = []
    let from: number | null = 0
    while (from !== null) {
      const page = t.service.snapshot({ sessionId: session.id, fromIndex: from, limit: 3 })
      expect(page.blocks.length).toBeGreaterThan(0)
      expect(page.blocks.length).toBeLessThanOrEqual(3)
      seen.push(...page.blocks.map((b) => b.index))
      from = page.nextIndex
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(t.service.snapshot({ sessionId: session.id, fromIndex: 99 })).toMatchObject({
      blocks: [],
      nextIndex: null,
    })
  })

  it('agent.snapshot vacía los deltas pendientes antes de leer', async () => {
    const t = await bootAgentHarness({ config: { batchMs: 1000 } })
    t.provider.script = () => [start('t'), delta('t', 'hola'), { type: 'hang' }]
    const { session } = await t.create()
    await t.service.send({ sessionId: session.id, text: 'x' })
    t.clock.advance(1)
    expect(t.service.snapshot({ sessionId: session.id }).blocks[1]).toMatchObject({ text: 'hola' })
  })
})

describe('AgentService: despachador', () => {
  it('con agents configurado, el despachador enruta agent.*', async () => {
    const t = await bootAgentHarness()
    const outcome = await t.dispatch({ method: 'agent.list', params: {} })
    expect(outcome).toMatchObject({ ok: true })
  })
})
