import { limitsApi, NexoClient, NexoClientError, webSocketTransport } from '@nexo/client'
import type { ProviderLimits } from '@nexo/contracts'
import { UsageLimitsError } from '@nexo/core'
import { FakeAgentProvider, FakeUsageLimits } from '@nexo/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDaemon, type TestDaemon } from './test-helpers.ts'

const daemons: TestDaemon[] = []
const clients: NexoClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.cleanup()
})

async function until(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error(`tiempo agotado: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function boot(options: { timeoutMs?: number } = {}) {
  const codex = new FakeUsageLimits('codex')
  const claude = new FakeUsageLimits('claude', { queryable: false })
  const providers = [
    new FakeAgentProvider('codex', { displayName: 'Codex', usageLimits: codex }),
    new FakeAgentProvider('claude', { displayName: 'Claude', usageLimits: claude }),
    new FakeAgentProvider('ollama', { displayName: 'Ollama' }),
  ]
  const daemon = await startTestDaemon({
    agentProviders: providers,
    limits: {
      emitIntervalMs: 50,
      ...(options.timeoutMs === undefined ? {} : { queryTimeoutMs: options.timeoutMs }),
    },
  })
  daemons.push(daemon)
  const client = new NexoClient({
    transport: () =>
      webSocketTransport({ url: `ws://127.0.0.1:${daemon.port}/`, token: daemon.token }),
  })
  clients.push(client)
  await client.connect()
  await client.subscribe(['limits.updated'])
  return { client, codex, claude, api: limitsApi(client) }
}

const W = (usedPercent: number) => ({ id: 'primary', bucket: 'codex', usedPercent })

describe('limits.* en el daemon', () => {
  it('limits.status: Codex consultado, Claude desconocido, Ollama sin límites', async () => {
    const { codex, api } = await boot()
    codex.set([W(42)])
    const { providers } = await api.status()
    const byId = Object.fromEntries(providers.map((p) => [p.provider, p]))
    expect(byId.codex).toMatchObject({ status: 'ok', source: 'query', fresh: true })
    expect(byId.codex?.windows).toEqual([W(42)])
    expect(byId.claude).toMatchObject({ status: 'unknown' })
    expect(byId.ollama).toMatchObject({ status: 'unsupported' })
    expect((await api.status({ provider: 'codex' })).providers).toHaveLength(1)
  })

  it('un proveedor desconocido da PROVIDER_UNAVAILABLE y params de más, INVALID_PARAMS', async () => {
    const { client, api } = await boot()
    await expect(api.status({ provider: 'nada' })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    })
    await expect(client.call('limits.status', { extra: 1 } as never)).rejects.toBeInstanceOf(
      NexoClientError,
    )
  })

  it('limits.updated llega al cliente cuando un proveedor informa por su cuenta', async () => {
    const { claude, api } = await boot()
    const got: ProviderLimits[] = []
    api.onUpdated((l) => got.push(l))
    claude.report([{ id: 'five_hour', usedPercent: 91, state: 'warning' }])
    await until(() => got.length > 0, 'evento limits.updated')
    expect(got[0]).toMatchObject({ provider: 'claude', status: 'ok', source: 'session' })
    expect(got[0]?.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 91 })
  })

  it('una avalancha de avisos no inunda al cliente', async () => {
    const { codex, api } = await boot()
    const got: ProviderLimits[] = []
    api.onUpdated((l) => got.push(l))
    for (let i = 0; i < 300; i++) codex.report([W(i % 100)])
    await until(() => got.length >= 2, 'último aviso')
    await new Promise((r) => setTimeout(r, 200))
    expect(got.length).toBeLessThanOrEqual(3)
    expect(got.at(-1)?.windows[0]?.usedPercent).toBe(99)
  })

  it('un proveedor que no responde agota el plazo y los demás contestan', async () => {
    const { codex, api } = await boot({ timeoutMs: 100 })
    codex.hang = true
    const { providers } = await api.status()
    expect(providers.find((p) => p.provider === 'codex')?.status).toBe('timeout')
    expect(providers.find((p) => p.provider === 'claude')?.status).toBe('unknown')
  })

  it('un error del proveedor con datos de cuenta no llega al cliente', async () => {
    const { codex, api } = await boot()
    codex.failWith = new Error('cuenta yo@example.com')
    const { providers } = await api.status()
    expect(JSON.stringify(providers)).not.toContain('example.com')
    codex.failWith = new UsageLimitsError('UNAVAILABLE', 'sin sesión')
    const again = await api.refresh({ provider: 'codex' })
    expect(again.providers[0]).toMatchObject({ status: 'unavailable', reason: 'sin sesión' })
  })
})
