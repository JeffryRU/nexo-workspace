import { tmpdir } from 'node:os'
import { historyApi, NexoClient, NexoClientError, webSocketTransport } from '@nexo/client'
import { HistoryError } from '@nexo/core'
import { FakeAgentProvider, FakeHistory } from '@nexo/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDaemon, type TestDaemon } from './test-helpers.ts'

const daemons: TestDaemon[] = []
const clients: NexoClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.cleanup()
})

async function boot(options: { history?: FakeHistory; extra?: boolean; timeoutMs?: number } = {}) {
  const history = options.history ?? new FakeHistory('fake')
  const fake = new FakeAgentProvider('fake', { history })
  const providers = [
    fake,
    new FakeAgentProvider('otro', { displayName: 'Sin historial' }),
    ...(options.extra === true
      ? [new FakeAgentProvider('lista', { history: new FakeHistory('lista', { canRead: false }) })]
      : []),
  ]
  const daemon = await startTestDaemon({
    agentProviders: providers,
    ...(options.timeoutMs === undefined
      ? {}
      : { history: { listTimeoutMs: options.timeoutMs, readTimeoutMs: options.timeoutMs } }),
  })
  daemons.push(daemon)
  const client = new NexoClient({
    transport: () =>
      webSocketTransport({ url: `ws://127.0.0.1:${daemon.port}/`, token: daemon.token }),
  })
  clients.push(client)
  await client.connect()
  return { client, history, fake, api: historyApi(client) }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof NexoClientError) return e.code
    throw e
  }
  return 'OK'
}

const messages = Array.from({ length: 120 }, (_, i) => ({
  role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
  text: `mensaje ${i}`,
}))

describe('history.* en el daemon', () => {
  it('lista agrupado por carpeta, con el estado de cada proveedor', async () => {
    const { history, api } = await boot({ extra: true })
    history.add({ cwd: '/w/a', updatedAt: 30, title: 'Uno' })
    history.add({ cwd: '/w/b', updatedAt: 20 })
    history.add({ cwd: '/w/a', updatedAt: 10 })
    const r = await api.list()
    expect(r.projects.map((p) => p.name)).toEqual(['a', 'b'])
    expect(r.projects[0]?.sessions).toHaveLength(2)
    const status = Object.fromEntries(r.providers.map((p) => [p.provider, p.status]))
    expect(status).toEqual({ fake: 'ok', otro: 'unsupported', lista: 'ok' })
    const byCwd = await api.list({ cwd: '/w/b' })
    expect(byCwd.projects).toHaveLength(1)
    const byProvider = await api.list({ provider: 'otro' })
    expect(byProvider.projects).toEqual([])
    expect(byProvider.providers).toEqual([expect.objectContaining({ status: 'unsupported' })])
  })

  it('pagina el listado con cursor', async () => {
    const { history, api } = await boot()
    for (let i = 0; i < 9; i++) history.add({ cwd: `/w/p${i % 3}`, updatedAt: 100 + i })
    const all = await api.listAll({ limit: 4 })
    expect(all.projects.flatMap((p) => p.sessions)).toHaveLength(9)
    expect(history.calls.list).toBe(1)
  })

  it('lee la transcripción por páginas y reutiliza la lectura', async () => {
    const { history, api } = await boot()
    const id = history.add({ cwd: '/w/a', messages })
    const first = await api.read({ provider: 'fake', sessionId: id, limit: 50 })
    expect(first).toMatchObject({ total: 120, truncated: false })
    expect(first.blocks).toHaveLength(50)
    const all = await api.readAll({ provider: 'fake', sessionId: id })
    expect(all.blocks).toHaveLength(120)
    expect(all.blocks.map((b) => b.index)).toEqual(Array.from({ length: 120 }, (_, i) => i))
    expect(history.calls.read).toBe(1)
  })

  it('códigos de error: sesión inexistente, ficha hostil, proveedor sin historial o desconocido', async () => {
    const { history, api } = await boot({ extra: true })
    expect(await code(api.read({ provider: 'fake', sessionId: 'no-existe-1' }))).toBe('NOT_FOUND')
    expect(await code(api.read({ provider: 'fake', sessionId: '../../etc/passwd' }))).toBe(
      'INVALID_PARAMS',
    )
    expect(await code(api.read({ provider: 'otro', sessionId: 'x1' }))).toBe('PROVIDER_UNAVAILABLE')
    expect(await code(api.read({ provider: 'lista', sessionId: 'x1' }))).toBe(
      'PROVIDER_UNAVAILABLE',
    )
    expect(await code(api.read({ provider: 'nadie', sessionId: 'x1' }))).toBe(
      'PROVIDER_UNAVAILABLE',
    )
    expect(await code(api.list({ cursor: 'h1-hostil' }))).toBe('INVALID_PARAMS')
    expect(await code(api.list({ limit: 5000 }))).toBe('INVALID_PARAMS')
    history.add({ messages })
  })

  it('un proveedor que falla o no responde no rompe el listado de los demás', async () => {
    const { history, api } = await boot({ extra: true, timeoutMs: 300 })
    history.hang = true
    const r = await api.list()
    expect(r.providers.find((p) => p.provider === 'fake')?.status).toBe('timeout')
    expect(r.providers.find((p) => p.provider === 'lista')?.status).toBe('ok')
    history.hang = false
    history.failWith = new HistoryError('UNAVAILABLE', 'sin sesión iniciada')
    const again = await api.list({ provider: 'fake' })
    expect(again.providers[0]).toMatchObject({ status: 'timeout' }) // la caché de fallos aún vale
  })

  it('reanuda una sesión del historial con agent.create { resume }', async () => {
    const { history, fake, client, api } = await boot()
    const id = history.add({ cwd: tmpdir(), messages: messages.slice(0, 4) })
    fake.rememberSession(id)
    const listed = await api.list()
    const entry = listed.projects[0]?.sessions[0]
    expect(entry).toMatchObject({ sessionId: id, resumable: true, provider: 'fake' })

    const cwd = tmpdir()
    const { workspace } = await client.call('workspace.create', { name: 'r', cwd })
    const { tab } = await client.call('tab.create', { workspaceId: workspace.id, cwd })
    const first = tab.panes[0]
    if (first === undefined) throw new Error('sin panel')
    const { pane } = await client.call('pane.split', {
      paneId: first.id,
      direction: 'row',
      kind: 'agent',
    })
    await client.call('pane.close', { paneId: first.id })
    const { session } = await client.call('agent.create', {
      paneId: pane.id,
      provider: 'fake',
      cwd,
      resume: id,
    })
    expect(session.providerSessionId).toBe(id)
    expect(fake.opened.at(-1)).toMatchObject({ resume: id })
    // Una ficha que el proveedor no conoce no se reanuda.
    const second = await client.call('pane.split', {
      paneId: pane.id,
      direction: 'row',
      kind: 'agent',
    })
    expect(
      await code(
        client.call('agent.create', {
          paneId: second.pane.id,
          provider: 'fake',
          cwd,
          resume: 'desconocida-1',
        }),
      ),
    ).not.toBe('OK')
  })

  it('al apagar el daemon se cancelan las consultas colgadas', async () => {
    const { history, client } = await boot({ timeoutMs: 60_000 })
    history.hang = true
    const pending = historyApi(client)
      .list({ provider: 'fake' })
      .catch(() => 'cerrado')
    await new Promise((r) => setTimeout(r, 100))
    const daemon = daemons[0]
    await daemon?.stop()
    await pending
    expect(history.calls.list).toBe(1)
  })
})
