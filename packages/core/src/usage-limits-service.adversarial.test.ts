import { FakeAgentProvider, FakeClock, FakeUsageLimits, RecordingEventBus } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { normalizeUsageReading, UsageLimitsService } from './usage-limits-service.ts'

function rig() {
  const clock = new FakeClock(1_000_000)
  const bus = new RecordingEventBus()
  const codex = new FakeUsageLimits('codex')
  const service = new UsageLimitsService({
    providers: [new FakeAgentProvider('codex', { usageLimits: codex })],
    bus,
    clock,
  })
  return { clock, bus, codex, service }
}

describe('límites de uso: salida hostil del proveedor', () => {
  it('query que devuelve basura da error unavailable, no revienta', async () => {
    for (const junk of [null, 5, 'x', [], {}, { windows: 'no' }, { windows: null }]) {
      const { codex, service } = rig()
      codex.current = junk
      const r = (await service.status({})).providers[0]
      expect(r?.status, JSON.stringify(junk)).toBe('unavailable')
    }
  })

  it('ventanas fuera de rango, sin id o con campos raros se descartan; las buenas se conservan', async () => {
    const { codex, service } = rig()
    codex.current = {
      windows: [
        { id: 'a', usedPercent: 101 },
        { id: 'b', usedPercent: -1 },
        { id: 'c', usedPercent: Number.NaN },
        { id: 'd', usedPercent: 'mucho' },
        { usedPercent: 5 },
        { id: '../../x', usedPercent: 5 },
        null,
        7,
        { id: 'ok', usedPercent: 33, label: 'x'.repeat(500), resetsAt: -4, windowMinutes: 0 },
        { id: 'ok2', usedPercent: 10, state: 'raro' },
      ],
    }
    const r = (await service.status({})).providers[0]
    expect(r?.status).toBe('ok')
    expect(r?.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ['ok', 33],
      ['ok2', 10],
    ])
    // Los campos opcionales hostiles se quitan, la ventana se queda.
    expect(r?.windows[0]).toEqual({ id: 'ok', usedPercent: 33 })
  })

  it('los campos de cuenta que el proveedor deje pasar no salen en el resultado ni en el evento', async () => {
    const { bus, codex, service } = rig()
    codex.current = {
      windows: [
        {
          id: 'primary',
          usedPercent: 5,
          email: 'yo@example.com',
          accountId: 'SECRETO',
          planType: 'plus',
        },
      ],
      email: 'yo@example.com',
      account: { name: 'Yo' },
    }
    const r = await service.status({})
    const text = JSON.stringify([r, bus.ofType('limits.updated')])
    expect(text).not.toMatch(/example|SECRETO|plus|account|email/)
  })

  it('fechas imposibles en observedAt no rompen: se usa el reloj del servicio', async () => {
    for (const observedAt of [-1, 1e300, Number.NaN, 'ayer', 9e15, 5_000_000_000]) {
      const { codex, service } = rig()
      codex.current = { windows: [{ id: 'p', usedPercent: 1 }], observedAt }
      const r = (await service.status({})).providers[0]
      expect(r?.observedAt).toBe(1_000_000)
    }
  })

  it('demasiadas ventanas se acotan a 16 y los duplicados se juntan (gana la última)', () => {
    const windows = Array.from({ length: 500 }, (_, i) => ({
      id: `w${i % 40}`,
      usedPercent: i % 100,
    }))
    const n = normalizeUsageReading({ windows })
    expect(n?.windows.length).toBeLessThanOrEqual(16)
    expect(new Set(n?.windows.map((w) => w.id)).size).toBe(n?.windows.length)
  })

  it('un aviso espontáneo malformado se ignora sin publicar', () => {
    const { bus, codex } = rig()
    for (const junk of [
      null,
      5,
      {},
      { windows: 5 },
      { windows: [null] },
      { windows: [{ id: 'x' }] },
    ]) {
      codex.emitRaw(junk)
    }
    expect(bus.ofType('limits.updated')).toHaveLength(0)
  })

  it('un proveedor que lanza en query no deja una consulta colgada (reintenta tras el TTL)', async () => {
    const { clock, codex, service } = rig()
    codex.failWith = new Error('boom')
    await service.status({})
    codex.failWith = undefined
    codex.set([{ id: 'p', usedPercent: 4 }])
    clock.advance(6000)
    expect((await service.status({})).providers[0]?.status).toBe('ok')
  })
})
