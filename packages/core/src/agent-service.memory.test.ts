import type { AgentSessionId, Block } from '@nexo/contracts'
import { bootAgentHarness, FakeMemoryInjection, sleep, textTurn } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import type { AgentMemorySource } from './agent-service.ts'
import { buildMemoryBlock } from './memory-inject.ts'

const BLOCK = (
  buildMemoryBlock({
    project: '/work',
    observations: [],
    reflection: {
      generation: 1,
      createdAt: 1,
      coversThroughSeq: 0,
      text: 'Usamos pnpm.',
      sources: [],
    },
  }) as { text: string }
).text

type Calls = {
  newSession: string[]
  renewal: { cwd: string; id: AgentSessionId; blocks: number }[]
}

function source(over: Partial<AgentMemorySource> = {}): { src: AgentMemorySource; calls: Calls } {
  const calls: Calls = { newSession: [], renewal: [] }
  const src: AgentMemorySource = {
    newSession: async (cwd) => {
      calls.newSession.push(cwd)
      return BLOCK
    },
    renewal: async (cwd, id, blocks: readonly Block[]) => {
      calls.renewal.push({ cwd, id, blocks: blocks.length })
      return BLOCK
    },
    ...over,
  }
  return { src, calls }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await sleep(0)
}

const big = (n: number) => 'palabra '.repeat(n)

describe('AgentService: inyección de memoria al abrir', () => {
  it('con memoria y proveedor con inyección, el bloque llega en open().memory', async () => {
    const { src, calls } = source()
    const t = await bootAgentHarness({
      provider: { memoryInjection: new FakeMemoryInjection() },
      memory: src,
    })
    await t.create()
    expect(calls.newSession).toEqual(['/work'])
    expect(t.provider.opened[0]?.memory).toBe(BLOCK)
  })

  it('sin memoria (fuente que devuelve null) no cambia nada: open sin la clave memory', async () => {
    const { src } = source({ newSession: async () => null })
    const t = await bootAgentHarness({
      provider: { memoryInjection: new FakeMemoryInjection() },
      memory: src,
    })
    await t.create()
    expect('memory' in (t.provider.opened[0] ?? {})).toBe(false)
  })

  it('sin fuente de memoria o sin inyección del proveedor no se consulta ni se pasa nada', async () => {
    const a = await bootAgentHarness({ provider: { memoryInjection: new FakeMemoryInjection() } })
    await a.create()
    expect('memory' in (a.provider.opened[0] ?? {})).toBe(false)
    const { src, calls } = source()
    const b = await bootAgentHarness({ memory: src })
    await b.create()
    expect(calls.newSession).toEqual([])
    expect('memory' in (b.provider.opened[0] ?? {})).toBe(false)
  })

  it('un fallo de la memoria o de la preparación nunca impide abrir la sesión', async () => {
    const boom = source({
      newSession: async () => {
        throw new Error('almacén roto')
      },
    })
    const a = await bootAgentHarness({
      provider: { memoryInjection: new FakeMemoryInjection() },
      memory: boom.src,
    })
    await a.create()
    expect('memory' in (a.provider.opened[0] ?? {})).toBe(false)
    const bad = source({ newSession: async () => 'no es un bloque' })
    const b = await bootAgentHarness({
      provider: { memoryInjection: new FakeMemoryInjection() },
      memory: bad.src,
    })
    const { session } = await b.create()
    expect(session.status).toBe('idle')
    expect('memory' in (b.provider.opened[0] ?? {})).toBe(false)
  })

  it('una sesión reanudada no recibe memoria', async () => {
    const { src, calls } = source()
    const t = await bootAgentHarness({
      provider: { memoryInjection: new FakeMemoryInjection() },
      memory: src,
    })
    await t.service
      .create({ paneId: t.paneId, provider: 'fake', resume: 'fake-session-9' })
      .catch(() => undefined)
    expect(calls.newSession).toEqual([])
  })
})

describe('AgentService: renovación de sesión', () => {
  const setup = async (
    renewAtTokens: number | undefined,
    over: Partial<AgentMemorySource> = {},
  ) => {
    const s = source(over)
    const t = await bootAgentHarness({
      provider: { memoryInjection: new FakeMemoryInjection() },
      memory: s.src,
      config: renewAtTokens === undefined ? {} : { renewAtTokens },
    })
    t.provider.script = () => textTurn([big(300)])
    return { t, ...s }
  }
  const turn = async (
    t: Awaited<ReturnType<typeof setup>>['t'],
    id: AgentSessionId,
    text = 'hola',
  ) => {
    await t.service.send({ sessionId: id, text })
    t.settle()
    await flush()
  }

  it('apagada por omisión: aunque el contexto crezca no se reabre', async () => {
    const { t } = await setup(undefined)
    const { session } = await t.create()
    for (let i = 0; i < 4; i++) await turn(t, session.id)
    expect(t.provider.opened).toHaveLength(1)
  })

  it('al pasar el umbral reabre sembrada: misma sesión y panel, proveedor nuevo, el anterior cerrado', async () => {
    const { t, calls } = await setup(1000)
    const { session, fake } = await t.create()
    await turn(t, session.id)
    await turn(t, session.id)
    expect(t.provider.opened).toHaveLength(2)
    expect(t.provider.opened[1]).toMatchObject({ cwd: '/work', memory: BLOCK })
    expect(calls.renewal).toHaveLength(1)
    expect(calls.renewal[0]?.id).toBe(session.id)
    expect(fake.closed).toBe(true)
    const view = t.service.list().sessions[0]
    expect(view?.id).toBe(session.id)
    expect(view?.paneId).toBe(t.paneId)
    expect(view?.providerSessionId).toBe(t.provider.sessions[1]?.providerSessionId)
    // el documento sigue y se puede seguir hablando con la sesión nueva
    await turn(t, session.id, 'sigue')
    expect(
      t.service.snapshot({ sessionId: session.id }).blocks.filter((b) => b.type === 'user'),
    ).toHaveLength(3)
    expect(t.provider.sessions[1]?.closed).toBe(false)
  })

  it('tras renovar el contexto cuenta desde la siembra: no renueva en cada turno', async () => {
    const { t, calls } = await setup(1000)
    const { session } = await t.create()
    for (let i = 0; i < 3; i++) await turn(t, session.id)
    expect(calls.renewal).toHaveLength(1)
    expect(t.service.contextTokens(session.id)).toBeGreaterThan(0)
  })

  it('si abrir la sesión nueva falla, sigue la actual y no se reintenta', async () => {
    const { t, calls } = await setup(1000)
    const { session, fake } = await t.create()
    await turn(t, session.id)
    t.provider.available = false
    await turn(t, session.id)
    t.provider.available = true
    await turn(t, session.id)
    await turn(t, session.id)
    expect(calls.renewal).toHaveLength(1)
    expect(fake.closed).toBe(false)
    expect(t.service.list().sessions[0]?.status).toBe('done')
  })

  it('sin nada que sembrar (la fuente da null) no renueva ni reintenta', async () => {
    const { t, calls } = await setup(1000, { renewal: async () => null })
    const { session, fake } = await t.create()
    for (let i = 0; i < 4; i++) await turn(t, session.id)
    expect(t.provider.opened).toHaveLength(1)
    expect(fake.closed).toBe(false)
    expect(calls.newSession).toHaveLength(1)
  })

  it('no se puede enviar mientras se renueva, y cerrar durante la renovación cierra también la nueva', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { t } = await setup(1000, {
      renewal: async () => {
        await gate
        return BLOCK
      },
    })
    const { session } = await t.create()
    await turn(t, session.id)
    await t.service.send({ sessionId: session.id, text: 'otra' })
    t.settle()
    await flush()
    await expect(t.service.send({ sessionId: session.id, text: 'x' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await t.service.close({ sessionId: session.id })
    release()
    await flush()
    expect(t.provider.sessions.every((s) => s.closed)).toBe(true)
  })
})
