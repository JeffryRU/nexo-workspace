import { FakeAgentProvider, FakeClock, FakeUsageLimits, RecordingEventBus } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { DomainError } from './errors.ts'
import { UsageLimitsError } from './ports/usage-limits.ts'
import { UsageLimitsService } from './usage-limits-service.ts'

const W = (usedPercent: number, over: Record<string, unknown> = {}) => ({
  id: 'primary',
  bucket: 'codex',
  usedPercent,
  ...over,
})

function rig(config = {}) {
  const clock = new FakeClock(1_000_000)
  const bus = new RecordingEventBus()
  const codex = new FakeUsageLimits('codex')
  const claude = new FakeUsageLimits('claude', { queryable: false })
  const providers = [
    new FakeAgentProvider('codex', { displayName: 'Codex', usageLimits: codex }),
    new FakeAgentProvider('claude', { displayName: 'Claude', usageLimits: claude }),
    new FakeAgentProvider('ollama', { displayName: 'Ollama' }),
  ]
  const service = new UsageLimitsService({ providers, bus, clock, config })
  return { clock, bus, codex, claude, service }
}

const byId = (r: { providers: { provider: string }[] }, id: string) =>
  r.providers.find((p) => p.provider === id) as never as Record<string, unknown>

describe('UsageLimitsService.status', () => {
  it('consulta a Codex, deja a Claude desconocido y marca los que no tienen límites', async () => {
    const { codex, service } = rig()
    codex.set([W(42, { resetsAt: 2_000_000 }), W(7, { id: 'secondary' })])
    const r = await service.status({})
    expect(byId(r, 'codex')).toMatchObject({
      status: 'ok',
      source: 'query',
      observedAt: 1_000_000,
      fresh: true,
    })
    expect((byId(r, 'codex').windows as unknown[]).length).toBe(2)
    expect(byId(r, 'claude')).toMatchObject({ status: 'unknown', windows: [] })
    expect(String(byId(r, 'claude').reason)).toContain('durante una sesión')
    expect(byId(r, 'ollama')).toMatchObject({ status: 'unsupported' })
  })

  it('filtra por proveedor y rechaza uno desconocido', async () => {
    const { service } = rig()
    expect((await service.status({ provider: 'codex' })).providers).toHaveLength(1)
    await expect(service.status({ provider: 'nada' })).rejects.toBeInstanceOf(DomainError)
  })

  it('reutiliza la consulta mientras dure la caché y refresh la salta', async () => {
    const { clock, codex, service } = rig()
    codex.set([W(1)])
    await service.status({})
    await service.status({})
    expect(codex.calls.query).toBe(1)
    await service.status({ refresh: true })
    expect(codex.calls.query).toBe(2)
    clock.advance(31_000)
    await service.status({})
    expect(codex.calls.query).toBe(3)
  })

  it('las consultas simultáneas comparten una sola', async () => {
    const { codex, service } = rig()
    codex.set([W(1)])
    await Promise.all([service.status({}), service.status({}), service.status({ refresh: true })])
    expect(codex.calls.query).toBe(1)
  })

  it('un fallo se recuerda poco y, si ya había dato, se muestra el último con el motivo', async () => {
    const { clock, codex, service } = rig()
    codex.set([W(10)])
    await service.status({})
    codex.failWith = new UsageLimitsError('UNAVAILABLE', 'sin sesión')
    const r = await service.status({ refresh: true })
    expect(byId(r, 'codex')).toMatchObject({
      status: 'ok',
      reason: 'no se pudo refrescar: sin sesión',
    })
    const calls = codex.calls.query
    await service.status({})
    expect(codex.calls.query).toBe(calls)
    clock.advance(31_000)
    await service.status({})
    expect(codex.calls.query).toBe(calls + 1)
  })

  it('sin dato previo un fallo sale como unavailable; un error genérico no filtra su mensaje', async () => {
    const { codex, service } = rig()
    codex.failWith = new UsageLimitsError('UNAVAILABLE', 'sin sesión')
    expect(byId(await service.status({}), 'codex')).toMatchObject({
      status: 'unavailable',
      reason: 'sin sesión',
    })
    const other = rig()
    other.codex.failWith = new Error('correo yo@example.com')
    const r = byId(await other.service.status({}), 'codex')
    expect(r.status).toBe('error')
    expect(JSON.stringify(r)).not.toContain('example.com')
  })

  it('un proveedor que no responde agota el plazo sin bloquear a los demás', async () => {
    const { clock, codex, service } = rig({ queryTimeoutMs: 5000 })
    codex.hang = true
    const pending = service.status({})
    await Promise.resolve()
    clock.advance(5001)
    const r = await pending
    expect(byId(r, 'codex')).toMatchObject({ status: 'timeout' })
    expect(byId(r, 'claude')).toMatchObject({ status: 'unknown' })
  })

  it('fresh es false con el dato viejo o con una ventana que ya se reinició', async () => {
    const { clock, codex, claude, service } = rig()
    codex.set([W(50, { resetsAt: 1_000_000 + 60_000 })])
    expect(byId(await service.status({}), 'codex').fresh).toBe(true)
    clock.advance(61_000)
    expect(byId(await service.status({}), 'codex').fresh).toBe(false)
    // Sin ventana de reinicio, lo que lo hace viejo es el tiempo (Claude: solo avisos, sin consulta).
    claude.report([{ id: 'five_hour', usedPercent: 50 }])
    expect(byId(await service.status({}), 'claude').fresh).toBe(true)
    clock.advance(16 * 60_000)
    expect(byId(await service.status({}), 'claude').fresh).toBe(false)
  })

  it('close rechaza lo nuevo y cancela las consultas en curso', async () => {
    const { codex, service } = rig()
    codex.hang = true
    const pending = service.status({})
    await Promise.resolve()
    service.close()
    await expect(pending).resolves.toBeDefined()
    await expect(service.status({})).rejects.toBeInstanceOf(DomainError)
  })
})

describe('UsageLimitsService: limits.updated', () => {
  it('publica lo que el proveedor informa por su cuenta (Claude: origen session)', () => {
    const { bus, claude } = rig()
    claude.report([{ id: 'five_hour', usedPercent: 80, state: 'warning' }])
    expect(bus.ofType('limits.updated')).toEqual([
      expect.objectContaining({ provider: 'claude', status: 'ok', source: 'session', fresh: true }),
    ])
  })

  it('Codex avisa con origen notification', () => {
    const { bus, codex } = rig()
    codex.report([W(5)])
    expect(bus.ofType('limits.updated')[0]).toMatchObject({
      provider: 'codex',
      source: 'notification',
    })
  })

  it('una avalancha se contiene: uno al instante, uno al final del intervalo con el último dato', () => {
    const { clock, bus, codex } = rig()
    for (let i = 1; i <= 500; i++) codex.report([W(i % 100)])
    expect(bus.ofType('limits.updated')).toHaveLength(1)
    expect(clock.pending).toBe(1)
    clock.advance(500)
    const events = bus.ofType('limits.updated')
    expect(events).toHaveLength(2)
    expect(events[1]?.windows[0]?.usedPercent).toBe(0)
    clock.advance(10_000)
    expect(bus.ofType('limits.updated')).toHaveLength(2)
  })

  it('no repite un evento si nada cambió', () => {
    const { clock, bus, codex } = rig()
    codex.report([W(5)])
    clock.advance(1000)
    codex.report([W(5)])
    clock.advance(1000)
    expect(bus.ofType('limits.updated')).toHaveLength(1)
  })

  it('una consulta que trae datos nuevos también publica', async () => {
    const { bus, codex, service } = rig()
    codex.set([W(9)])
    await service.status({})
    expect(bus.ofType('limits.updated')).toHaveLength(1)
  })

  it('tras close ya no publica ni escucha', () => {
    const { bus, codex, service } = rig()
    service.close()
    codex.report([W(5)])
    expect(bus.ofType('limits.updated')).toHaveLength(0)
  })
})
