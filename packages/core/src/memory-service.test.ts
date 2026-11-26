import type { ObservationDraft, SummarizerUsage } from '@nexo/contracts'
import {
  agentBlock,
  createMemoryRig,
  FakeSummarizer,
  type MemoryRig,
  sampleObserveRequest,
  sleep,
  userBlock,
} from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { DomainError } from './errors.ts'
import { MemoryService, RECALL_MAX_BYTES } from './memory-service.ts'
import {
  type AbortSignalLike,
  type ObserveRequest,
  type SummarizeRequest,
  SummarizerError,
  type SummarizerPort,
} from './ports/memory.ts'

const PROJECT = '/work/app'

const usage = (over: Partial<SummarizerUsage> = {}): SummarizerUsage => ({
  model: 'fake',
  inputTokens: 100,
  outputTokens: 10,
  costUsd: 0.002,
  ...over,
})

/** Resumidor que escribe 3 observaciones largas por lote y reflexiona en una frase corta. */
function bigObserver(): FakeSummarizer {
  return new FakeSummarizer('fake', {
    handler: (request) =>
      request.kind === 'observe'
        ? {
            kind: 'observe',
            content: {
              format: 'text',
              text: [1, 2, 3]
                .map((n) => `- [media] [proyecto] Dato ${n} ${'x'.repeat(500)}`)
                .join('\n'),
            },
            usage: usage(),
          }
        : { kind: 'reflect', text: '- Resumen corto de todo.', usage: usage({ costUsd: 0.01 }) },
  })
}

async function observed(rig: MemoryRig, project = PROJECT) {
  return rig.store.load(project)
}

describe('MemoryService: lotes del Observador', () => {
  it('no llama al resumidor mientras no haya tokens suficientes en la sesión', async () => {
    const rig = createMemoryRig()
    const s = rig.open()
    rig.turn(s, 100)
    rig.idle(s)
    await rig.drain()
    expect(rig.fake?.requests).toHaveLength(0)
    expect((await observed(rig)).observations).toHaveLength(0)
  })

  it('al pasar el umbral observa el lote una sola vez y guarda observaciones con su rango', async () => {
    const rig = createMemoryRig()
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    rig.idle(s)
    await rig.drain()
    const requests = rig.fake?.requests ?? []
    expect(requests).toHaveLength(1)
    const request = requests[0] as ObserveRequest
    expect(request.kind).toBe('observe')
    expect(request.project).toBe(PROJECT)
    expect(request.sessionId).toBe(s)
    expect(request.range.from).toBe(0)
    expect(request.maxObservations).toBe(20)
    expect(request.transcript).toContain('[#0] usuario:')
    const memory = await observed(rig)
    expect(memory.observations.length).toBeGreaterThan(0)
    expect(memory.observations.every((o) => o.sessionId === s)).toBe(true)
    expect(memory.sessions[0]?.observedThrough).toBe(request.range.to)
    expect(rig.bus.ofType('memory.updated')).toEqual([
      expect.objectContaining({ cwd: PROJECT, kind: 'observe', generation: 0 }),
    ])
  })

  it('no repite lo ya observado: el siguiente lote empieza donde terminó el anterior', async () => {
    const rig = createMemoryRig()
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain()
    const first = ((rig.fake?.requests ?? [])[0] as ObserveRequest).range
    rig.turn(s, 50)
    rig.idle(s)
    await rig.drain()
    expect(rig.fake?.requests).toHaveLength(1)
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    rig.idle(s)
    await rig.drain()
    const second = rig.fake?.requests[1] as ObserveRequest
    expect(second.range.from).toBe(first.to + 1)
    expect(second.known.recent.length).toBeGreaterThan(0)
  })

  it('un bloque aún abierto no se observa y el rango queda antes de él', async () => {
    const rig = createMemoryRig()
    const s = rig.open()
    for (let i = 0; i < 3; i++) rig.turn(s, 400)
    rig.push(s, agentBlock(6, 'a'.repeat(3000), false))
    rig.idle(s)
    await rig.drain()
    const request = rig.fake?.requests[0] as ObserveRequest
    expect(request.range.to).toBe(5)
    expect(request.transcript).not.toContain('[#6]')
  })

  it('un documento largo se parte en varios lotes del tamaño máximo', async () => {
    const rig = createMemoryRig()
    const s = rig.open()
    for (let i = 0; i < 12; i++) rig.turn(s, 700)
    await rig.drain()
    const ranges = (rig.fake?.requests ?? []).map((r) => (r as ObserveRequest).range)
    expect(ranges.length).toBeGreaterThan(1)
    for (let i = 1; i < ranges.length; i++) {
      expect((ranges[i] as { from: number }).from).toBe((ranges[i - 1] as { to: number }).to + 1)
    }
  })

  it('nunca llama dentro del manejador del bus: el streaming no espera al resumidor', async () => {
    const rig = createMemoryRig()
    const s = rig.open()
    for (let i = 0; i < 6; i++) rig.turn(s, 600)
    // todo lo anterior ya publicó eventos, pero el resumidor aún no se ha tocado
    expect(rig.fake?.requests).toHaveLength(0)
    expect(rig.sessions.snapshots).toBe(0)
    await rig.drain()
    expect(rig.fake?.requests.length).toBeGreaterThan(0)
  })

  it('un resumidor lento no frena los eventos: siguen entrando y se observan después', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const slow = new FakeSummarizer('slow', {
      handler: async (request: SummarizeRequest) => {
        calls++
        if (calls === 1) await gate
        return request.kind === 'observe'
          ? {
              kind: 'observe',
              content: { format: 'text', text: `- [media] [proyecto] lote ${calls}` },
              usage: usage(),
            }
          : { kind: 'reflect', text: 'x', usage: usage() }
      },
    })
    const rig = createMemoryRig({ summarizer: slow })
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 500)
    await sleep(10)
    expect(calls).toBe(1)
    // mientras el primer lote sigue en curso, llegan más bloques: el bus los acepta sin esperar
    const t0 = Date.now()
    for (let i = 0; i < 200; i++) rig.turn(s, 30)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(calls).toBe(1)
    release()
    await rig.drain()
    expect(calls).toBeGreaterThan(1)
    const memory = await observed(rig)
    expect(memory.observations.map((o) => o.text)).toContain('lote 1')
  })
})

describe('MemoryService: cola por proyecto', () => {
  function tracked() {
    const state = { running: 0, max: 0, calls: 0 }
    const summarizer = new FakeSummarizer('t', {
      handler: async (request: SummarizeRequest) => {
        state.calls++
        state.running++
        state.max = Math.max(state.max, state.running)
        await sleep(15)
        state.running--
        return request.kind === 'observe'
          ? {
              kind: 'observe' as const,
              content: { format: 'text' as const, text: '- [media] [proyecto] algo' },
              usage: usage(),
            }
          : { kind: 'reflect' as const, text: 'x', usage: usage() }
      },
    })
    return { state, summarizer }
  }

  it('a lo sumo una llamada en curso por proyecto, aunque haya varias sesiones', async () => {
    const { state, summarizer } = tracked()
    const rig = createMemoryRig({ summarizer })
    const a = rig.open('a')
    const b = rig.open('b')
    const c = rig.open('c')
    for (const s of [a, b, c]) for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain()
    expect(state.calls).toBeGreaterThanOrEqual(3)
    expect(state.max).toBe(1)
  })

  it('proyectos distintos avanzan en paralelo', async () => {
    const { state, summarizer } = tracked()
    const rig = createMemoryRig({ summarizer })
    const a = rig.open('a', '/work/uno')
    const b = rig.open('b', '/work/dos')
    for (const s of [a, b]) for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain()
    expect(state.max).toBe(2)
    expect((await observed(rig, '/work/uno')).observations.length).toBeGreaterThan(0)
    expect((await observed(rig, '/work/dos')).observations.length).toBeGreaterThan(0)
  })

  it('la memoria es del proyecto: dos sesiones de una carpeta alimentan el mismo registro', async () => {
    const rig = createMemoryRig()
    const a = rig.open('a', 'C:\\Work\\App')
    const b = rig.open('b', 'c:/work/app/')
    for (const s of [a, b]) for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain()
    const memory = await rig.store.load('C:\\Work\\App')
    expect(new Set(memory.observations.map((o) => o.sessionId))).toEqual(new Set([a, b]))
    expect(memory.sessions).toHaveLength(2)
  })
})

describe('MemoryService: Reflector', () => {
  it('reflexiona al pasar el umbral: absorbe las observaciones y guarda la generación', async () => {
    const rig = createMemoryRig({ summarizer: bigObserver() })
    const s = rig.open()
    for (let i = 0; i < 30; i++) rig.turn(s, 500)
    rig.idle(s)
    await rig.drain()
    const memory = await observed(rig)
    expect(memory.reflection?.generation).toBeGreaterThanOrEqual(1)
    expect(memory.reflection?.text).toContain('Resumen corto')
    const events = rig.bus.ofType('memory.updated')
    expect(events.some((e) => e.kind === 'reflect' && e.generation >= 1)).toBe(true)
    const reflects = (rig.summarizer as FakeSummarizer).requests.filter((r) => r.kind === 'reflect')
    expect(reflects.length).toBeGreaterThanOrEqual(1)
  })

  it('no reflexiona por debajo del umbral', async () => {
    const rig = createMemoryRig({
      thresholds: { observerBatchTokens: 500, reflectorTokens: 200_000, maxBatchTokens: 2000 },
    })
    const s = rig.open()
    for (let i = 0; i < 10; i++) rig.turn(s, 400)
    await rig.drain()
    const kinds = (rig.fake?.requests ?? []).map((r) => r.kind)
    expect(kinds.length).toBeGreaterThan(0)
    expect(kinds.every((k) => k === 'observe')).toBe(true)
  })

  it('un Reflector que no acorta se descarta, se anota el uso y espera antes de volver a intentarlo', async () => {
    const summarizer = new FakeSummarizer('big', {
      handler: (request) =>
        request.kind === 'observe'
          ? {
              kind: 'observe',
              content: {
                format: 'text',
                text: [1, 2, 3]
                  .map((n) => `- [media] [proyecto] Dato ${n} ${'y'.repeat(500)}`)
                  .join('\n'),
              },
              usage: usage(),
            }
          : { kind: 'reflect', text: `- ${'z'.repeat(60_000)}`, usage: usage({ costUsd: 0.5 }) },
    })
    const rig = createMemoryRig({ summarizer, config: { reflectCooldownMs: 100_000 } })
    const s = rig.open()
    for (let i = 0; i < 30; i++) rig.turn(s, 500)
    await rig.drain()
    const memory = await observed(rig)
    expect(memory.reflection).toBeNull()
    expect(memory.observations.length).toBeGreaterThan(3)
    expect(memory.usage.costUsd).toBeGreaterThanOrEqual(0.5)
    const reflects = () => summarizer.requests.filter((r) => r.kind === 'reflect').length
    expect(reflects()).toBe(1)
    // durante la espera no se insiste aunque lleguen más lotes
    for (let i = 0; i < 4; i++) rig.turn(s, 500)
    await rig.drain()
    expect(reflects()).toBe(1)
    expect(rig.logger.entries.some((e) => e.message.includes('Reflector no acortó'))).toBe(true)
    // pasada la espera, vuelve a probar
    rig.clock.advance(100_001)
    for (let i = 0; i < 4; i++) rig.turn(s, 500)
    await rig.drain()
    expect(reflects()).toBe(2)
  })
})

describe('MemoryService: errores, reintentos y pausa', () => {
  it('reintenta un error retryable con espera y termina guardando el lote', async () => {
    const rig = createMemoryRig()
    rig.fake?.failNext(new SummarizerError('TIMEOUT', 'lento'))
    rig.fake?.failNext(new SummarizerError('UNAVAILABLE', 'caído'))
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain(50)
    expect(rig.fake?.requests).toHaveLength(3)
    expect((await observed(rig)).observations.length).toBeGreaterThan(0)
    const status = await rig.service.status({})
    expect(status.pausedReason).toBeUndefined()
  })

  it('agotados los reintentos pone la memoria en pausa con motivo, sin perder el lote', async () => {
    const rig = createMemoryRig()
    for (let i = 0; i < 3; i++) rig.fake?.failNext(new SummarizerError('UNAVAILABLE', 'sin red'))
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain(50)
    expect(rig.fake?.requests).toHaveLength(3)
    const memory = await observed(rig)
    expect(memory.observations).toHaveLength(0)
    expect(memory.sessions).toHaveLength(0)
    const status = await rig.service.status({})
    expect(status.pausedReason).toContain('sin red')
    // en pausa no hay más llamadas aunque lleguen eventos
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain()
    expect(rig.fake?.requests).toHaveLength(3)
    // pasada la pausa, el siguiente disparo retoma el trabajo pendiente desde el principio
    rig.clock.advance(1001)
    rig.turn(s, 400)
    rig.idle(s)
    await rig.drain()
    const after = await observed(rig)
    expect(after.observations.length).toBeGreaterThan(0)
    expect(((rig.fake?.requests ?? []).at(-1) as ObserveRequest).range.from).toBe(0)
    expect((await rig.service.status({})).pausedReason).toBeUndefined()
  })

  it('un error no retryable de UNAVAILABLE (modelo no instalado) pausa sin reintentar', async () => {
    const rig = createMemoryRig()
    rig.fake?.failNext(
      new SummarizerError('UNAVAILABLE', 'modelo no instalado', { retryable: false }),
    )
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain(50)
    expect(rig.fake?.requests).toHaveLength(1)
    expect((await rig.service.status({})).pausedReason).toContain('modelo no instalado')
  })

  it('un lote con salida inutilizable se reintenta una vez y luego se descarta para no atascarse', async () => {
    const rig = createMemoryRig()
    rig.fake?.failNext(new SummarizerError('INVALID_OUTPUT', 'basura'))
    rig.fake?.failNext(new SummarizerError('INVALID_OUTPUT', 'basura'))
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain()
    expect(rig.fake?.requests).toHaveLength(1)
    expect((await observed(rig)).sessions).toHaveLength(0)
    rig.turn(s, 400)
    rig.idle(s)
    await rig.drain()
    // el segundo fallo del mismo lote lo descarta: el progreso avanza sin observaciones
    expect(rig.fake?.requests).toHaveLength(2)
    const memory = await observed(rig)
    expect(memory.observations).toHaveLength(0)
    expect(memory.sessions[0]?.observedThrough).toBeGreaterThanOrEqual(7)
    expect(rig.logger.entries.some((e) => e.message.includes('lote descartado'))).toBe(true)
  })

  it('un resumidor no disponible deja la memoria en pausa con motivo y no hace llamadas', async () => {
    const fake = new FakeSummarizer()
    fake.available = false
    const rig = createMemoryRig({ summarizer: fake })
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain()
    expect(fake.requests).toHaveLength(0)
    const status = await rig.service.status({})
    expect(status.enabled).toBe(true)
    expect(status.pausedReason).toContain('no está disponible')
    // al volver, la siguiente señal tras la pausa lo retoma
    fake.available = true
    rig.clock.advance(1001)
    rig.turn(s, 400)
    rig.idle(s)
    await rig.drain()
    expect(fake.requests.length).toBeGreaterThan(0)
  })

  it('sin resumidor configurado: en pausa con el motivo dado, sin errores', async () => {
    const rig = createMemoryRig({ summarizer: null, pausedReason: 'falta NEXO_MEMORY_SUMMARIZER' })
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await rig.drain()
    const status = await rig.service.status({})
    expect(status.pausedReason).toBe('falta NEXO_MEMORY_SUMMARIZER')
    expect(status.summarizer).toBeUndefined()
    expect(rig.logger.entries.filter((e) => e.level === 'error')).toEqual([])
  })
})

describe('MemoryService: cierre', () => {
  it('stop() aborta la llamada en curso, no guarda nada y deja de escuchar', async () => {
    let signalSeen: AbortSignalLike | undefined
    const hanging: SummarizerPort = {
      id: 'h',
      isAvailable: async () => true,
      summarize: (_request, options) =>
        new Promise<never>((_resolve, reject) => {
          signalSeen = options?.signal
          options?.signal?.addEventListener('abort', () =>
            reject(new SummarizerError('ABORTED', 'cancelado')),
          )
        }),
    }
    const rig = createMemoryRig({ summarizer: hanging })
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await sleep(10)
    expect(rig.service.busy).toBe(true)
    await rig.service.stop()
    expect(signalSeen?.aborted).toBe(true)
    expect(rig.service.busy).toBe(false)
    expect((await observed(rig)).observations).toHaveLength(0)
    // tras el cierre los eventos ya no disparan nada
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await sleep(10)
    expect(rig.service.busy).toBe(false)
    await rig.service.stop()
  })

  it('stop() interrumpe la espera de un reintento', async () => {
    const rig = createMemoryRig({ config: { retryDelaysMs: [60_000] } })
    rig.fake?.failNext(new SummarizerError('UNAVAILABLE', 'caído'))
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await sleep(10)
    expect(rig.service.busy).toBe(true)
    await rig.service.stop()
    expect(rig.service.busy).toBe(false)
    expect(rig.fake?.requests).toHaveLength(1)
  })

  it('apagada (enabled: false) no escucha ni llama, pero sigue sirviendo lo guardado', async () => {
    const rig = createMemoryRig({ enabled: false })
    rig.service.start()
    const s = rig.open()
    for (let i = 0; i < 6; i++) rig.turn(s, 600)
    await sleep(10)
    expect(rig.fake?.requests).toHaveLength(0)
    expect(rig.sessions.snapshots).toBe(0)
    const status = await rig.service.status({})
    expect(status.enabled).toBe(false)
    expect(status.pausedReason).toBeUndefined()
    await rig.store.update(PROJECT, (m) => ({
      ...m,
      nextSeq: 2,
      observations: [
        {
          seq: 1,
          at: 1,
          priority: 'high',
          scope: 'project',
          sessionId: 's1' as never,
          range: { from: 0, to: 1 },
          text: 'dato viejo',
        },
      ],
    }))
    expect((await rig.service.list({ cwd: PROJECT })).observations).toHaveLength(1)
  })

  it('start() es idempotente y un servicio detenido no revive', async () => {
    const rig = createMemoryRig()
    rig.service.start()
    rig.service.start()
    expect(rig.bus.events).toHaveLength(0)
    await rig.service.stop()
    rig.service.start()
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    await sleep(10)
    expect(rig.fake?.requests).toHaveLength(0)
  })
})

describe('MemoryService: sesiones', () => {
  it('una sesión cerrada se olvida y no rompe la cola', async () => {
    const rig = createMemoryRig()
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 400)
    rig.sessions.remove(s) // el documento ya no existe cuando la cola lo va a leer
    rig.bus.publish({ event: 'agent.session', data: { sessionId: s, removed: true } })
    await rig.drain()
    expect(rig.fake?.requests).toHaveLength(0)
    expect(rig.logger.entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it('un bloque de una sesión desconocida se ignora; una conocida solo por list() se aprende', async () => {
    const rig = createMemoryRig()
    rig.bus.publish({
      event: 'agent.block',
      data: { sessionId: 'nadie' as never, block: userBlock(0, 'x'.repeat(5000)) },
    })
    rig.sessions.add('tarde' as never, PROJECT)
    rig.sessions.sessions.get('tarde' as never)?.blocks.push(userBlock(0, 'x'.repeat(5000)))
    rig.bus.publish({
      event: 'agent.block',
      data: { sessionId: 'tarde' as never, block: userBlock(0, 'x'.repeat(5000)) },
    })
    await rig.drain()
    expect(rig.fake?.requests).toHaveLength(1)
    expect(((rig.fake?.requests ?? [])[0] as ObserveRequest).sessionId).toBe('tarde')
  })

  it('al arrancar aprende las sesiones que ya existían', async () => {
    const rig = createMemoryRig({ enabled: false })
    rig.sessions.add('previa' as never, PROJECT)
    const service = new MemoryService({
      store: rig.store,
      bus: rig.bus,
      clock: rig.clock,
      summarizer: rig.summarizer,
      sessions: rig.sessions,
      enabled: true,
      thresholds: { observerBatchTokens: 500, reflectorTokens: 1000, maxBatchTokens: 2000 },
    })
    service.start()
    for (let i = 0; i < 4; i++) {
      rig.push(
        'previa' as never,
        userBlock(i * 2, `p ${'u'.repeat(400)}`),
        agentBlock(i * 2 + 1, 'a'.repeat(400)),
      )
    }
    for (let i = 0; i < 100 && (service.busy || (rig.fake?.requests.length ?? 0) === 0); i++) {
      await sleep(5)
    }
    expect(rig.fake?.requests.length).toBeGreaterThan(0)
    await service.stop()
  })
})

describe('MemoryService: contabilidad y métodos', () => {
  it('suma llamadas, tokens y costo por papel en status, y los guarda en el proyecto', async () => {
    const rig = createMemoryRig({ summarizer: bigObserver() })
    const s = rig.open()
    for (let i = 0; i < 30; i++) rig.turn(s, 500)
    await rig.drain()
    const status = await rig.service.status({ cwd: PROJECT })
    expect(status.enabled).toBe(true)
    expect(status.summarizer).toBe('fake')
    expect(status.thresholds).toEqual({ observerBatchTokens: 500, reflectorTokens: 1000 })
    const roles = status.roles
    expect(roles?.observer.calls).toBeGreaterThan(0)
    expect(roles?.reflector.calls).toBeGreaterThan(0)
    expect(roles?.observer.inputTokens).toBe(100 * (roles?.observer.calls ?? 0))
    expect(status.usage.calls).toBe((roles?.observer.calls ?? 0) + (roles?.reflector.calls ?? 0))
    expect(status.usage.costUsd).toBeCloseTo(
      0.002 * (roles?.observer.calls ?? 0) + 0.01 * (roles?.reflector.calls ?? 0),
      6,
    )
    expect(status.projectUsage?.calls).toBe(status.usage.calls)
    expect(status.project?.cwd).toBe(PROJECT)
    expect(status.project?.generation).toBeGreaterThanOrEqual(1)
    expect(status.project?.observations).toBeGreaterThanOrEqual(0)
  })

  it('status sin cwd no trae proyecto; con una carpeta sin memoria trae ceros', async () => {
    const rig = createMemoryRig()
    expect((await rig.service.status({})).project).toBeUndefined()
    const status = await rig.service.status({ cwd: '/otra/carpeta' })
    expect(status.project).toMatchObject({ observations: 0, generation: 0, sessions: 0 })
  })

  async function seeded() {
    const rig = createMemoryRig({ enabled: false })
    const drafts: ObservationDraft[] = [
      { text: 'usa pnpm para instalar', priority: 'high', scope: 'project' },
      { text: 'el test de pagos falla en CI', priority: 'medium', scope: 'session' },
      { text: 'se renombró la carpeta utils', priority: 'low', scope: 'project' },
      { text: 'pnpm lock actualizado', priority: 'medium', scope: 'project' },
    ]
    await rig.store.update(PROJECT, (m) => ({
      ...m,
      nextSeq: 5,
      observations: drafts.map((d, i) => ({
        seq: i + 1,
        at: 1000 + i,
        priority: d.priority ?? 'medium',
        scope: d.scope ?? 'session',
        sessionId: 's1' as never,
        range: { from: i, to: i + 1 },
        text: d.text,
      })),
      reflection: {
        generation: 2,
        createdAt: 5,
        coversThroughSeq: 0,
        text: 'Reflexión',
        sources: [],
      },
    }))
    return rig
  }

  it('memory.list: página con nextSeq, filtros y reflexión solo en la primera página', async () => {
    const rig = await seeded()
    const page1 = await rig.service.list({ cwd: PROJECT, limit: 2 })
    expect(page1.observations.map((o) => o.seq)).toEqual([1, 2])
    expect(page1.nextSeq).toBe(3)
    expect(page1.reflection?.generation).toBe(2)
    const page2 = await rig.service.list({ cwd: PROJECT, limit: 2, fromSeq: 3 })
    expect(page2.observations.map((o) => o.seq)).toEqual([3, 4])
    expect(page2.nextSeq).toBeNull()
    expect(page2.reflection).toBeNull()
    expect(
      (await rig.service.list({ cwd: PROJECT, scope: 'session' })).observations.map((o) => o.seq),
    ).toEqual([2])
    expect(
      (await rig.service.list({ cwd: PROJECT, minPriority: 'medium' })).observations.map(
        (o) => o.seq,
      ),
    ).toEqual([1, 2, 4])
    // la carpeta se normaliza
    expect((await rig.service.list({ cwd: '/work/app/' })).observations).toHaveLength(4)
    expect((await rig.service.list({ cwd: '/otra' })).observations).toEqual([])
  })

  it('memory.search: por términos, de más a menos relevante, con truncated', async () => {
    const rig = await seeded()
    const r = await rig.service.search({ cwd: PROJECT, query: 'pnpm' })
    expect(r.observations.map((o) => o.seq)).toEqual([1, 4])
    expect(r.truncated).toBe(false)
    const limited = await rig.service.search({ cwd: PROJECT, query: 'pnpm', limit: 1 })
    expect(limited.observations).toHaveLength(1)
    expect(limited.truncated).toBe(true)
    expect((await rig.service.search({ cwd: PROJECT, query: '!!!' })).observations).toEqual([])
  })

  it('memory.recall: devuelve el texto original del rango y lo acota', async () => {
    const rig = createMemoryRig()
    const s = rig.open()
    for (let i = 0; i < 4; i++) rig.turn(s, 40)
    const r = rig.service.recall({ sessionId: s, range: { from: 2, to: 4 } })
    expect(r.blocks.map((b) => b.index)).toEqual([2, 3, 4])
    expect(r.truncated).toBe(false)
    expect(r.blocks[0]).toMatchObject({ type: 'user' })
    // un rango que pasa del final devuelve lo que haya
    expect(rig.service.recall({ sessionId: s, range: { from: 6, to: 50 } }).blocks).toHaveLength(2)
    expect(rig.service.recall({ sessionId: s, range: { from: 20, to: 30 } }).blocks).toEqual([])
  })

  it('memory.recall: pasa de los bytes permitidos -> devuelve los primeros y truncated', async () => {
    const rig = createMemoryRig()
    const s = rig.open()
    const chunk = 'x'.repeat(100 * 1024)
    for (let i = 0; i < 10; i++) rig.push(s, userBlock(i, chunk))
    const r = rig.service.recall({ sessionId: s, range: { from: 0, to: 9 } })
    expect(r.truncated).toBe(true)
    expect(r.blocks.length).toBeGreaterThan(0)
    expect(r.blocks.length).toBeLessThan(10)
    expect(r.blocks.length * chunk.length).toBeLessThanOrEqual(RECALL_MAX_BYTES + chunk.length)
  })

  it('memory.recall: sesión inexistente es NOT_FOUND; sin sesiones configuradas, PROVIDER_UNAVAILABLE', () => {
    const rig = createMemoryRig()
    expect(() =>
      rig.service.recall({ sessionId: 'x' as never, range: { from: 0, to: 1 } }),
    ).toThrow(DomainError)
    try {
      rig.service.recall({ sessionId: 'x' as never, range: { from: 0, to: 1 } })
    } catch (error) {
      expect((error as DomainError).code).toBe('NOT_FOUND')
    }
    const none = createMemoryRig({ noSessions: true })
    try {
      none.service.recall({ sessionId: 'x' as never, range: { from: 0, to: 1 } })
      expect.unreachable()
    } catch (error) {
      expect((error as DomainError).code).toBe('PROVIDER_UNAVAILABLE')
    }
  })

  it('el despachador recibe los cuatro manejadores', () => {
    const rig = createMemoryRig()
    expect(Object.keys(rig.service.handlers).sort()).toEqual([
      'memory.list',
      'memory.recall',
      'memory.search',
      'memory.status',
    ])
  })

  it('usa la petición de ejemplo del testkit sin tocar nada (sanidad del rig)', () => {
    expect(sampleObserveRequest().kind).toBe('observe')
  })
})
