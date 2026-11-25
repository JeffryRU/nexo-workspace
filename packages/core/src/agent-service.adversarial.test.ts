import type {
  AgentSessionId,
  Block,
  BlockId,
  PaneId,
  ProviderCapabilities,
  ProviderEvent,
} from '@nexo/contracts'
import { utf8ByteLength } from '@nexo/contracts'
import { FakeClock, RecordingEventBus, SequentialIds } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { AgentService, type AgentServiceConfig } from './agent-service.ts'
import { DomainError } from './errors.ts'
import { LayoutService } from './layout-service.ts'
import type { AgentProviderPort, AgentProviderSession, AgentResponse } from './ports/agent.ts'
import type { BusEvent, EventBusPort, IdPort } from './ports/misc.ts'

// Un proveedor que emite lo que la prueba quiera, cuando quiera: sin guion ni protocolo.
class ManualSession implements AgentProviderSession {
  readonly providerSessionId = 'manual-1'
  readonly listeners = new Set<(event: ProviderEvent) => void>()
  readonly responses: AgentResponse[] = []
  closed = false
  interruptError: Error | undefined
  respondError: Error | undefined
  respondHook: (() => Promise<void>) | undefined
  onEvent(listener: (event: ProviderEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  emit(value: unknown): void {
    for (const l of [...this.listeners]) l(value as ProviderEvent)
  }
  async send(): Promise<void> {}
  async interrupt(): Promise<void> {
    if (this.interruptError !== undefined) throw this.interruptError
  }
  async respond(response: AgentResponse): Promise<void> {
    if (this.respondHook !== undefined) await this.respondHook()
    if (this.respondError !== undefined) throw this.respondError
    this.responses.push(response)
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

const caps: ProviderCapabilities = {
  models: [],
  efforts: [],
  permissionModes: ['ask'],
  resume: false,
  warmup: false,
  streaming: true,
}

class ManualProvider implements AgentProviderPort {
  readonly id = 'manual'
  readonly displayName = 'Manual'
  readonly sessions: ManualSession[] = []
  async isAvailable() {
    return true
  }
  async capabilities() {
    return caps
  }
  async open() {
    const s = new ManualSession()
    this.sessions.push(s)
    return s
  }
}

class CountingBus implements EventBusPort {
  counts = new Map<string, number>()
  publish(event: BusEvent) {
    this.counts.set(event.event, (this.counts.get(event.event) ?? 0) + 1)
  }
  subscribe() {
    return () => {}
  }
}

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'OK'
}

type Options = { config?: AgentServiceConfig; ids?: IdPort; bus?: EventBusPort }
type T = Awaited<ReturnType<typeof setup>>

async function setup(options: Options = {}) {
  const clock = new FakeClock()
  const recording = new RecordingEventBus()
  const bus = options.bus ?? recording
  const ids = options.ids ?? new SequentialIds()
  const layout = new LayoutService({ ids: new SequentialIds(), bus: recording })
  const ws = layout.createWorkspace('w', '/work')
  const tab = layout.createTab(ws.id)
  const first = tab.panes[0]?.id as PaneId
  const paneId = layout.split(first, 'row', 'agent').id
  const provider = new ManualProvider()
  const service = new AgentService({
    providers: [provider],
    bus,
    clock,
    ids,
    panes: layout,
    ...(options.config === undefined ? {} : { config: options.config }),
  })
  const { session } = await service.create({ paneId, provider: 'manual' })
  const raw = provider.sessions[0] as ManualSession
  const turn = async () => service.send({ sessionId: session.id, text: 'hola' })
  const blocks = () => {
    const all: Block[] = []
    for (let from: number | null = 0; from !== null; ) {
      const page = service.snapshot({ sessionId: session.id, fromIndex: from, limit: 200 })
      all.push(...page.blocks)
      from = page.nextIndex
    }
    return all
  }
  const invalid = () => service.stats(session.id)?.invalidEvents
  const status = () => service.list().sessions[0]?.status
  return {
    clock,
    bus: recording,
    layout,
    first,
    paneId,
    provider,
    service,
    session,
    raw,
    turn,
    blocks,
    invalid,
    status,
  }
}

const textStart = (ref: string): ProviderEvent => ({
  type: 'block-start',
  ref,
  block: { type: 'text', text: '', complete: false },
})
const textDelta = (ref: string, text: string): ProviderEvent => ({
  type: 'block-delta',
  ref,
  field: 'text',
  text,
})
const permissionRequest = (requestId: string, ids = ['a', 'b']): ProviderEvent => ({
  type: 'permission-request',
  requestId,
  tool: 'x',
  title: 't',
  options: ids.map((id, i) => ({
    id,
    label: id,
    kind: i === 0 ? ('allow-once' as const) : ('reject-once' as const),
  })),
})

describe('AgentService (adversarial): eventos fuera de orden', () => {
  it('descarta deltas, updates y ends de una ref desconocida', async () => {
    const t = await setup({ config: { maxConsecutiveInvalid: 1000 } })
    await t.turn()
    t.raw.emit(textDelta('nada', 'x'))
    t.raw.emit({ type: 'block-end', ref: 'nada' })
    t.raw.emit({
      type: 'block-update',
      ref: 'nada',
      block: { type: 'text', text: 'a', complete: false },
    })
    expect(t.invalid()).toBe(3)
    expect(t.blocks()).toHaveLength(1)
  })

  it('descarta una ref repetida mientras sigue abierta y deja reutilizarla tras block-end', async () => {
    const t = await setup()
    await t.turn()
    t.raw.emit(textStart('a'))
    t.raw.emit(textStart('a'))
    expect(t.invalid()).toBe(1)
    t.raw.emit({ type: 'block-end', ref: 'a' })
    t.raw.emit(textStart('a'))
    expect(t.invalid()).toBe(1)
    expect(t.blocks().map((b) => b.type)).toEqual(['user', 'text', 'text'])
  })

  it('eventos de bloque fuera de un turno, y un turn-end de más, se descartan', async () => {
    const t = await setup()
    t.raw.emit(textStart('a'))
    t.raw.emit({ type: 'turn-end', stopReason: 'end-turn' })
    t.raw.emit({ type: 'usage', usage: {} })
    t.raw.emit({ type: 'request-cancelled', requestId: 'x' })
    expect(t.invalid()).toBe(4)
    expect(t.blocks()).toEqual([])
    await t.turn()
    t.raw.emit({ type: 'turn-end', stopReason: 'end-turn' })
    t.raw.emit({ type: 'turn-end', stopReason: 'end-turn' })
    expect(t.invalid()).toBe(5)
  })

  it('el proveedor no puede abrir bloques user, permission ni question', async () => {
    const t = await setup()
    await t.turn()
    t.raw.emit({ type: 'block-start', ref: 'u', block: { type: 'user', text: 'yo' } })
    t.raw.emit({
      type: 'block-start',
      ref: 'p',
      block: {
        type: 'permission',
        tool: 'x',
        title: 'x',
        options: [{ id: 'a', label: 'a', kind: 'allow-once' }],
        state: 'accepted',
        selectedOptionId: 'a',
      },
    })
    expect(t.invalid()).toBe(2)
  })

  it('un end que cambia el tipo del bloque se descarta', async () => {
    const t = await setup()
    await t.turn()
    t.raw.emit(textStart('a'))
    t.raw.emit({
      type: 'block-end',
      ref: 'a',
      block: { type: 'error', code: 'X', message: 'm', fatal: false },
    })
    expect(t.invalid()).toBe(1)
    expect(t.blocks()[1]).toMatchObject({ type: 'text' })
  })

  it('un delta de output a un bloque de texto, o a uno ya cerrado, se descarta', async () => {
    const t = await setup()
    await t.turn()
    t.raw.emit(textStart('a'))
    t.raw.emit({ type: 'block-delta', ref: 'a', field: 'output', text: 'x' })
    t.raw.emit({ type: 'block-end', ref: 'a' })
    t.raw.emit(textDelta('a', 'tarde'))
    expect(t.invalid()).toBe(2)
  })

  it('solicitudes con id repetido, opciones repetidas o preguntas repetidas se descartan', async () => {
    const t = await setup()
    await t.turn()
    t.raw.emit(permissionRequest('r', ['a', 'a']))
    t.raw.emit(permissionRequest('r'))
    t.raw.emit(permissionRequest('r'))
    t.raw.emit({
      type: 'question-request',
      requestId: 'q',
      questions: [
        { id: 'x', question: '?', options: [], multiSelect: false, allowText: true },
        { id: 'x', question: '?', options: [], multiSelect: false, allowText: true },
      ],
    })
    expect(t.invalid()).toBe(3)
    expect(t.blocks().filter((b) => b.type === 'permission')).toHaveLength(1)
  })

  it('request-cancelled de una solicitud ya cancelada por interrupción no cuenta como inválido', async () => {
    const t = await setup()
    await t.turn()
    t.raw.emit(permissionRequest('r'))
    await t.service.interrupt({ sessionId: t.session.id })
    t.raw.emit({ type: 'request-cancelled', requestId: 'r' })
    t.raw.emit({ type: 'turn-end', stopReason: 'interrupted' })
    expect(t.invalid()).toBe(0)
  })
})

describe('AgentService (adversarial): basura del proveedor', () => {
  it('sobrevive a valores hostiles y cuenta cada uno', async () => {
    const t = await setup({ config: { maxConsecutiveInvalid: 1_000_000 } })
    await t.turn()
    const circular: Record<string, unknown> = { type: 'block-start' }
    circular.self = circular
    const hostile = [
      undefined,
      null,
      0,
      'x'.repeat(1_000_000),
      [],
      circular,
      JSON.parse('{"__proto__":{"a":1},"type":"turn-end","stopReason":"end-turn"}'),
      { type: 'block-start', ref: 'x', block: { type: 'text', text: '\u0000', complete: false } },
      { type: 'block-delta', ref: 'a'.repeat(10_000), field: 'text', text: 'x' },
      { type: 'constructor' },
      { type: 'exit', exitCode: 1.5, signal: null },
    ]
    for (const value of hostile) t.raw.emit(value)
    expect(t.invalid()).toBe(hostile.length)
    expect(t.status()).toBe('working')
  })

  it('demasiados eventos inválidos seguidos cierran la sesión y ya no se atienden más', async () => {
    const t = await setup({ config: { maxConsecutiveInvalid: 10 } })
    await t.turn()
    for (let i = 0; i < 1000; i++) t.raw.emit({ basura: i })
    expect(t.invalid()).toBe(10)
    expect(t.status()).toBe('error')
    expect(t.raw.closed).toBe(true)
    expect(t.raw.listeners.size).toBe(0)
  })

  it('un error interno al aplicar un evento cierra la sesión, no el daemon', async () => {
    let calls = 0
    const base = new SequentialIds()
    const ids: IdPort = {
      workspace: () => base.workspace(),
      tab: () => base.tab(),
      pane: () => base.pane(),
      terminal: () => base.terminal(),
      agentSession: () => base.agentSession(),
      block: () => {
        if (++calls > 1) throw new Error('ids rotos')
        return base.block()
      },
    }
    const t = await setup({ ids })
    await t.turn()
    t.raw.emit(textStart('a'))
    expect(t.status()).toBe('error')
    expect(t.raw.closed).toBe(true)
  })
})

describe('AgentService (adversarial): ids repetidos', () => {
  it('un IdPort que repite el id de bloque deja la sesión en error sin corromper el documento', async () => {
    const base = new SequentialIds()
    const ids: IdPort = {
      workspace: () => base.workspace(),
      tab: () => base.tab(),
      pane: () => base.pane(),
      terminal: () => base.terminal(),
      agentSession: () => base.agentSession(),
      block: () => 'siempre' as BlockId,
    }
    const t = await setup({ ids })
    await t.turn()
    t.raw.emit(textStart('a'))
    const blocks = t.blocks()
    expect(t.status()).toBe('error')
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length)
    expect(blocks.map((b) => b.index)).toEqual(blocks.map((_, i) => i))
  })

  it('un IdPort que repite el id de sesión da CONFLICT sin dejar sesiones de más', async () => {
    const base = new SequentialIds()
    const ids: IdPort = {
      workspace: () => base.workspace(),
      tab: () => base.tab(),
      pane: () => base.pane(),
      terminal: () => base.terminal(),
      agentSession: () => 'igual' as AgentSessionId,
      block: () => base.block(),
    }
    const t = await setup({ ids })
    const second = t.layout.split(t.first, 'row', 'agent').id
    expect(await codeOf(() => t.service.create({ paneId: second, provider: 'manual' }))).toBe(
      'CONFLICT',
    )
    expect(t.service.list().sessions).toHaveLength(1)
  })
})

describe('AgentService (adversarial): respuestas dobles y tardías', () => {
  const permission = (t: T) => {
    t.raw.emit(permissionRequest('r'))
    return t.blocks().find((b) => b.type === 'permission')?.id as BlockId
  }
  const reply = (t: T, blockId: BlockId, optionId = 'a') =>
    t.service.respond({ type: 'permission', sessionId: t.session.id, blockId, optionId })

  it('responder dos veces o a un bloque que no es una solicitud da error tipado', async () => {
    const t = await setup()
    await t.turn()
    const id = permission(t)
    await reply(t, id)
    expect(await codeOf(() => reply(t, id))).toBe('CONFLICT')
    const user = t.blocks()[0]?.id as BlockId
    expect(await codeOf(() => reply(t, user))).toBe('INVALID_PARAMS')
    expect(t.raw.responses).toHaveLength(1)
  })

  it('responder tras el exit del proveedor o tras cerrar: error tipado, sin crash', async () => {
    const t = await setup()
    await t.turn()
    const id = permission(t)
    t.raw.emit({ type: 'exit', exitCode: 1, signal: null })
    expect(await codeOf(() => reply(t, id))).toBe('CONFLICT')
    await t.service.close({ sessionId: t.session.id })
    expect(await codeOf(() => reply(t, id))).toBe('NOT_FOUND')
  })

  it('si el proveedor falla al responder, el bloque sigue pendiente y se puede reintentar', async () => {
    const t = await setup()
    await t.turn()
    const id = permission(t)
    t.raw.respondError = new Error('red')
    expect(await codeOf(() => reply(t, id))).toBe('INTERNAL')
    expect(t.blocks().find((b) => b.id === id)).toMatchObject({ state: 'pending' })
    t.raw.respondError = undefined
    await reply(t, id)
  })

  it('una respuesta que llega mientras se interrumpe deja el bloque cancelado', async () => {
    const t = await setup()
    await t.turn()
    const id = permission(t)
    let release: () => void = () => {}
    t.raw.respondHook = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const pending = reply(t, id)
    await t.service.interrupt({ sessionId: t.session.id })
    release()
    await pending
    expect(t.blocks().find((b) => b.id === id)).toMatchObject({ state: 'cancelled' })
  })

  it('interrumpir con un proveedor que falla igual cancela lo pendiente', async () => {
    const t = await setup()
    await t.turn()
    const id = permission(t)
    t.raw.interruptError = new Error('no puedo')
    expect(await codeOf(() => t.service.interrupt({ sessionId: t.session.id }))).toBe('INTERNAL')
    expect(t.blocks().find((b) => b.id === id)).toMatchObject({ state: 'cancelled' })
  })
})

describe('AgentService (adversarial): proveedor que no para', () => {
  it('deltas sin fin: el bloque queda en 128 KiB, truncated, y los eventos acotados', async () => {
    const bus = new CountingBus()
    const t = await setup({ bus })
    await t.turn()
    t.raw.emit(textStart('a'))
    const chunk = 'é'.repeat(16 * 1024)
    for (let i = 0; i < 2000; i++) t.raw.emit(textDelta('a', chunk))
    const block = t.blocks()[1]
    expect(block).toMatchObject({ type: 'text', truncated: true })
    expect(utf8ByteLength(block?.type === 'text' ? block.text : '')).toBeLessThanOrEqual(128 * 1024)
    expect(bus.counts.get('agent.delta') ?? 0).toBeLessThan(10)
    expect(t.service.stats(t.session.id)?.droppedDeltas).toBeGreaterThan(1000)
  })

  it('bloques nuevos sin fin: el documento se detiene en el tope', async () => {
    const t = await setup({ config: { maxBlocksPerSession: 100, reservedBlocks: 10 } })
    await t.turn()
    for (let i = 0; i < 20_000; i++) {
      t.raw.emit(textStart(`b${i}`))
      t.raw.emit(textDelta(`b${i}`, 'x'))
    }
    expect(t.service.stats(t.session.id)?.droppedBlocks).toBeGreaterThan(1000)
    expect(t.blocks().length).toBeLessThanOrEqual(90)
  })

  it('solicitudes de permiso sin fin: al llenar el documento la sesión pasa a error', async () => {
    const t = await setup({ config: { maxBlocksPerSession: 40, reservedBlocks: 4 } })
    await t.turn()
    for (let i = 0; i < 500; i++) t.raw.emit(permissionRequest(`r${i}`, ['a']))
    expect(t.status()).toBe('error')
    expect(t.blocks().length).toBeLessThanOrEqual(40)
    expect(t.raw.closed).toBe(true)
  })

  it('cerrar con el proveedor colgado a mitad de delta no deja temporizadores ni eventos', async () => {
    const t = await setup({ config: { batchMs: 100 } })
    await t.turn()
    t.raw.emit(textStart('a'))
    t.raw.emit(textDelta('a', 'x'))
    await t.service.close({ sessionId: t.session.id })
    expect(t.raw.closed).toBe(true)
    expect(t.clock.pending).toBe(0)
    t.raw.emit(textDelta('a', 'y'))
    expect(t.bus.ofType('agent.delta')).toHaveLength(0)
  })

  it('el exit llega con deltas pendientes: se vacían antes de registrar el error', async () => {
    const t = await setup({ config: { batchMs: 100 } })
    await t.turn()
    t.raw.emit(textStart('a'))
    t.raw.emit(textDelta('a', 'visto'))
    t.raw.emit({ type: 'exit', exitCode: 9, signal: 'SIGKILL' })
    const blocks = t.blocks()
    expect(blocks[1]).toMatchObject({ text: 'visto', complete: true })
    expect(blocks.at(-1)).toMatchObject({ type: 'error', code: 'EXITED' })
  })
})

describe('AgentService (adversarial): muchas sesiones', () => {
  it('cientos de intentos: solo caben las del tope y no se abren procesos de más', async () => {
    const t = await setup()
    const results: string[] = []
    for (let i = 0; i < 300; i++) {
      const pane = t.layout.split(t.first, 'row', 'agent').id
      results.push(await codeOf(() => t.service.create({ paneId: pane, provider: 'manual' })))
    }
    expect(results.filter((r) => r === 'OK')).toHaveLength(63)
    expect(results.filter((r) => r === 'CONFLICT')).toHaveLength(237)
    expect(t.provider.sessions).toHaveLength(64)
    expect(t.service.list().sessions).toHaveLength(64)
    await t.service.closeAll()
    expect(t.service.list().sessions).toEqual([])
    expect(t.provider.sessions.every((s) => s.closed)).toBe(true)
  })

  it('creaciones simultáneas sobre el mismo panel: solo una', async () => {
    const t = await setup()
    const pane = t.layout.split(t.first, 'row', 'agent').id
    const codes = await Promise.all(
      Array.from({ length: 50 }, () =>
        codeOf(() => t.service.create({ paneId: pane, provider: 'manual' })),
      ),
    )
    expect(codes.filter((c) => c === 'OK')).toHaveLength(1)
    expect(t.provider.sessions).toHaveLength(2)
  })
})

describe('AgentService (adversarial): tamaño', () => {
  it('dos campos de 128 KiB con escapes (768 KiB cada uno) se recortan para caber en un mensaje', async () => {
    const t = await setup()
    await t.turn()
    const big = '\u001b'.repeat(128 * 1024)
    t.raw.emit({
      type: 'block-start',
      ref: 'e',
      block: {
        type: 'action',
        kind: 'edit',
        status: 'ok',
        tool: 'Edit',
        title: 'e',
        output: big,
        diff: { path: 'a', patch: big },
      },
    })
    for (const e of t.bus.ofType('agent.block')) {
      expect(utf8ByteLength(JSON.stringify(e))).toBeLessThan(1024 * 1024 - 4096)
    }
    expect(t.blocks()[1]).toMatchObject({ type: 'action', truncated: true })
    expect(
      utf8ByteLength(JSON.stringify(t.service.snapshot({ sessionId: t.session.id }))),
    ).toBeLessThan(1024 * 1024)
  })

  it('el recorte no parte caracteres astrales', async () => {
    const t = await setup({ config: { maxMessageBytes: 16 * 1024 } })
    await t.turn()
    t.raw.emit({
      type: 'block-start',
      ref: 'a',
      block: {
        type: 'action',
        kind: 'other',
        status: 'ok',
        tool: 'x',
        title: 'x',
        output: '😀'.repeat(20_000),
      },
    })
    const block = t.blocks()[1]
    const text = block?.type === 'action' ? (block.output ?? '') : ''
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/^(?:😀)+$/u)
  })
})
