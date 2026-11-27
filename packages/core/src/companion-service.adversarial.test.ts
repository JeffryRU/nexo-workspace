import { AgentSessionId, LIMITS, PaneId } from '@nexo/contracts'
import {
  createFakeCompanions,
  encodeUtf8,
  FakeClock,
  FakeCompanionSelectionStore,
  FakeLogger,
  RecordingEventBus,
  tinyCompanion,
} from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { CompanionService } from './companion-service.ts'
import { DomainError } from './errors.ts'

/** Servicio de compañeros con falsos: reloj, bus, paquetes en memoria y persistencia en memoria. */
export async function rig(stored: string | null = null, ids: string[] = ['tiny']) {
  const clock = new FakeClock(5000)
  const bus = new RecordingEventBus()
  const { port, source } = createFakeCompanions()
  for (const id of ids) source.put(id, tinyCompanion({ id }))
  const store = new FakeCompanionSelectionStore(stored)
  const logger = new FakeLogger()
  const service = new CompanionService({ port, store, bus, clock, logger })
  await service.state()
  return { clock, bus, port, source, store, logger, service }
}

export const status = (
  sessionId: string,
  st: 'idle' | 'working' | 'needs-input' | 'done' | 'error',
) => ({
  event: 'agent.status' as const,
  data: { sessionId: AgentSessionId.parse(sessionId), status: st, updatedAt: 1 },
})

export const removed = (sessionId: string) => ({
  event: 'agent.session' as const,
  data: { sessionId: AgentSessionId.parse(sessionId), removed: true as const },
})

export const paneTitle = (paneId: string, title: string) => ({
  event: 'pane.title' as const,
  data: { paneId: PaneId.parse(paneId), title },
})

export async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'OK'
}

const hasControl = (s: string): boolean => [...s].some((c) => (c.codePointAt(0) as number) < 0x20)

describe('CompanionService: carreras de select', () => {
  it('selects concurrentes: gana el último y lo guardado coincide con lo mostrado', async () => {
    const { service, store } = await rig(null, ['uno', 'dos', 'tres'])
    const results = await Promise.all([
      service.select({ id: 'uno' }),
      service.select({ id: 'dos' }),
      service.select({ id: null }),
      service.select({ id: 'tres' }),
    ])
    expect(results.map((r) => r.selected)).toEqual(['uno', 'dos', null, 'tres'])
    expect(store.value).toBe('tres')
    expect((await service.state()).selected).toBe('tres')
    expect(store.saves).toEqual(['uno', 'dos', null, 'tres'])
  })

  it('un select que falla no rompe la cola ni los siguientes', async () => {
    const { service, store } = await rig(null, ['uno'])
    store.failNext = true
    const [a, b, c] = await Promise.allSettled([
      service.select({ id: 'uno' }),
      service.select({ id: 'nada' }),
      service.select({ id: 'uno' }),
    ])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('rejected')
    expect(c).toMatchObject({ status: 'fulfilled', value: { selected: 'uno' } })
    expect(store.value).toBe('uno')
  })

  it('un select lento no se adelanta a uno posterior', async () => {
    const { service, store } = await rig(null, ['uno', 'dos'])
    let release = () => {}
    store.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = service.select({ id: 'uno' })
    const second = service.select({ id: 'dos' })
    release()
    await Promise.all([first, second])
    expect(store.value).toBe('dos')
    expect((await service.state()).selected).toBe('dos')
  })

  it('select mientras se borra el paquete: NOT_FOUND y la elección anterior se conserva', async () => {
    const { service, source } = await rig(null, ['uno', 'dos'])
    await service.select({ id: 'uno' })
    source.remove('dos')
    expect(await code(service.select({ id: 'dos' }))).toBe('NOT_FOUND')
    expect((await service.state()).selected).toBe('uno')
  })
})

describe('CompanionService: entradas hostiles', () => {
  it('muchas sesiones y eventos repetidos no hacen crecer el estado ni parpadear', async () => {
    const { service, bus, clock } = await rig()
    for (let i = 0; i < 2000; i++)
      bus.publish(status(`s${i % 50}`, i % 2 === 0 ? 'working' : 'done'))
    clock.advance(60_000)
    const view = await service.state()
    expect(['busy', 'thinking', 'done', 'idle']).toContain(view.state)
    for (let i = 0; i < 50; i++) {
      bus.publish(removed(`s${i}`))
    }
    clock.advance(60_000)
    expect((await service.state()).state).toBe('idle')
    expect(clock.pending).toBe(0)
  })

  it('un listado enorme de carpetas se acota', async () => {
    const ids = Array.from(
      { length: LIMITS.maxCompanions + 30 },
      (_, i) => `c${String(i).padStart(3, '0')}`,
    )
    const { service } = await rig(null, ids)
    const list = await service.list()
    expect(list.companions).toHaveLength(LIMITS.maxCompanions)
  })

  it('paquetes no válidos no se cuelan en la lista de válidos y su motivo no lleva controles', async () => {
    const { service, source } = await rig()
    source.put('roto', { 'companion.json': encodeUtf8('{"x":1}') })
    source.putProblem('enlace', 'es un enlace\u001b[31m simbólico')
    const { companions, invalid } = await service.list()
    expect(companions.map((c) => c.id)).toEqual(['tiny'])
    expect(invalid.map((i) => i.id).sort()).toEqual(['enlace', 'roto'])
    for (const i of invalid) expect(hasControl(i.reason)).toBe(false)
  })

  it('asset con rutas hostiles nunca devuelve bytes', async () => {
    const { service } = await rig()
    for (const path of [
      '../tiny/idle.png',
      '/idle.png',
      'C:\\idle.png',
      'idle.png\u0000',
      'nul.png',
    ]) {
      const outcome = await code(service.asset({ id: 'tiny', path }))
      expect(['INVALID_PARAMS', 'NOT_FOUND']).toContain(outcome)
    }
  })

  it('un SVG con script en un paquete ya cargado no se sirve y el paquete no se puede elegir', async () => {
    const { service, source } = await rig()
    source.put('tiny', {
      ...tinyCompanion({ id: 'tiny' }),
      'error.svg': encodeUtf8(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    })
    expect(await code(service.asset({ id: 'tiny', path: 'error.svg' }))).toBe('INVALID_PARAMS')
    expect(await code(service.select({ id: 'tiny' }))).toBe('INVALID_PARAMS')
    expect((await service.state()).selected).toBeNull()
  })
})
