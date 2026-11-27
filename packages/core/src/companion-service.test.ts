import { AgentSessionId, PaneId } from '@nexo/contracts'
import {
  createFakeCompanions,
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

describe('CompanionService', () => {
  it('sin mascota por omisión', async () => {
    const { service } = await rig()
    expect(await service.state()).toEqual({ state: 'idle', since: 5000, selected: null })
    expect((await service.list()).selected).toBeNull()
  })

  it('list, get y asset sirven el paquete', async () => {
    const { service } = await rig()
    const list = await service.list()
    expect(list.companions.map((c) => c.id)).toEqual(['tiny'])
    const detail = await service.get({ id: 'tiny' })
    expect(detail.companion.manifest.name).toBe('Tiny')
    const asset = await service.asset({ id: 'tiny', path: 'idle.png' })
    expect(asset.mime).toBe('image/png')
    expect(asset.bytes).toBeGreaterThan(0)
    expect(asset.data).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('select guarda, avisa por companion.state y «ninguno» vuelve a sin mascota', async () => {
    const { service, store, bus } = await rig()
    expect(await service.select({ id: 'tiny' })).toEqual({ selected: 'tiny' })
    expect(store.value).toBe('tiny')
    expect(bus.ofType('companion.state')).toEqual([
      { state: 'idle', since: 5000, selected: 'tiny' },
    ])
    expect((await service.list()).selected).toBe('tiny')
    await service.select({ id: 'tiny' })
    expect(bus.ofType('companion.state')).toHaveLength(1)
    expect(await service.select({ id: null })).toEqual({ selected: null })
    expect(store.value).toBeNull()
    expect(bus.ofType('companion.state')).toHaveLength(2)
  })

  it('carga la elección guardada al arrancar', async () => {
    const { service } = await rig('tiny')
    expect((await service.state()).selected).toBe('tiny')
  })

  it('una elección guardada que ya no es válida se ignora sin tocar el archivo', async () => {
    const { service, store, logger } = await rig('desaparecido')
    expect((await service.state()).selected).toBeNull()
    expect(store.value).toBe('desaparecido')
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true)
  })

  it('errores: id desconocido es NOT_FOUND, paquete roto INVALID_PARAMS, y no se guarda nada', async () => {
    const { service, store, source } = await rig()
    expect(await code(service.select({ id: 'nada' }))).toBe('NOT_FOUND')
    source.put('roto', { 'companion.json': new Uint8Array([123]) })
    expect(await code(service.select({ id: 'roto' }))).toBe('INVALID_PARAMS')
    expect(await code(service.get({ id: 'roto' }))).toBe('INVALID_PARAMS')
    expect(await code(service.asset({ id: 'tiny', path: 'extra.png' }))).toBe('NOT_FOUND')
    expect(store.saves).toEqual([])
  })

  it('si guardar falla, la elección no cambia y el error es INTERNAL', async () => {
    const { service, store, bus } = await rig()
    store.failNext = true
    expect(await code(service.select({ id: 'tiny' }))).toBe('INTERNAL')
    expect((await service.state()).selected).toBeNull()
    expect(bus.ofType('companion.state')).toEqual([])
  })

  it('traduce la atención de los agentes a estados y avisa de cada cambio', async () => {
    const { service, bus, clock } = await rig()
    await service.select({ id: 'tiny' })
    bus.publish(status('a', 'working'))
    expect((await service.state()).state).toBe('thinking')
    bus.publish(status('b', 'working'))
    expect((await service.state()).state).toBe('busy')
    bus.publish(status('b', 'needs-input'))
    expect((await service.state()).state).toBe('waiting')
    bus.publish(status('b', 'working'))
    clock.advance(2000)
    expect((await service.state()).state).toBe('busy')
    bus.publish(removed('b'))
    bus.publish(status('a', 'done'))
    clock.advance(1000)
    expect((await service.state()).state).toBe('done')
    clock.advance(10_000)
    expect((await service.state()).state).toBe('idle')
    expect(bus.ofType('companion.state').map((e) => e.state)).toEqual([
      'idle',
      'thinking',
      'busy',
      'waiting',
      'busy',
      'done',
      'idle',
    ])
  })

  it('ignora eventos que no son de agentes y altas de sesión', async () => {
    const { service, bus } = await rig()
    bus.publish(paneTitle('p1', 'x'))
    bus.publish({
      event: 'agent.session',
      data: { session: { id: 's' } as never },
    })
    expect((await service.state()).state).toBe('idle')
  })

  it('close deja de oír el bus y rechaza select', async () => {
    const { service, bus } = await rig()
    service.close()
    bus.publish(status('a', 'working'))
    expect((await service.state()).state).toBe('idle')
    expect(await code(service.select({ id: 'tiny' }))).toBe('PROVIDER_UNAVAILABLE')
  })
})
