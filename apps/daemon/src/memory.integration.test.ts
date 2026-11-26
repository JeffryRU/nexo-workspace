import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentDocument, agentApi, NexoClient, webSocketTransport } from '@nexo/client'
import type { AgentSession, PaneId } from '@nexo/contracts'
import { SummarizerError, type SummarizerPort } from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedAgentProvider } from './adapters/scripted-agent-provider.ts'
import { startTestDaemon, type TestDaemon } from './test-helpers.ts'

const daemons: TestDaemon[] = []
const clients: NexoClient[] = []
const docs: AgentDocument[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const d of docs.splice(0)) d.dispose()
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SCALE = Math.max(1, Number(process.env.NEXO_TEST_TIMEOUT_SCALE ?? '1') || 1)
const THRESHOLDS = { observerBatchTokens: 500, reflectorTokens: 20_000 }

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 15_000 * SCALE
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`tiempo agotado: ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function boot(options: Parameters<typeof startTestDaemon>[0] = {}) {
  const daemon = await startTestDaemon({
    agentProviders: [new ScriptedAgentProvider({ chunkMs: 1 })],
    ...options,
  })
  daemons.push(daemon)
  return daemon
}

async function connect(daemon: TestDaemon): Promise<NexoClient> {
  const client = new NexoClient({
    transport: () =>
      webSocketTransport({ url: `ws://127.0.0.1:${daemon.port}/`, token: daemon.token }),
    reconnect: { baseMs: 10, maxMs: 50 },
  })
  clients.push(client)
  await client.connect()
  await client.subscribe()
  return client
}

async function newSession(
  client: NexoClient,
  cwd: string,
): Promise<{ session: AgentSession; paneId: PaneId }> {
  const { workspace } = await client.call('workspace.create', { name: 'memoria', cwd })
  const { tab } = await client.call('tab.create', { workspaceId: workspace.id, cwd })
  const first = tab.panes[0]
  if (first === undefined) throw new Error('sin panel')
  const { pane } = await client.call('pane.split', {
    paneId: first.id,
    direction: 'row',
    kind: 'agent',
  })
  await client.call('pane.close', { paneId: first.id })
  const { session } = await client.call('agent.create', { paneId: pane.id, provider: 'fake', cwd })
  return { session, paneId: pane.id }
}

/** Una conversación lo bastante larga para pasar el umbral de 500 tokens. */
async function talk(client: NexoClient, session: AgentSession, turns = 1): Promise<AgentDocument> {
  const doc = await AgentDocument.open(client, session.id)
  docs.push(doc)
  for (let i = 1; i <= turns; i++) {
    await agentApi(client).send({
      sessionId: session.id,
      text: `Usemos pnpm en este proyecto, punto ${i}. ${'detalle '.repeat(400)}`,
    })
    await until(() => doc.blocks().filter((b) => b.type === 'usage').length === i, `turno ${i}`)
  }
  return doc
}

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-mem-'))
  dirs.push(dir)
  return dir
}

describe('memoria observacional en el daemon real', () => {
  it('apagada por omisión: nada se observa y memory.status lo dice', async () => {
    const daemon = await boot()
    const client = await connect(daemon)
    const cwd = workdir()
    const { session } = await newSession(client, cwd)
    await talk(client, session, 2)
    const status = await client.call('memory.status', { cwd })
    expect(status.enabled).toBe(false)
    expect(status.pausedReason).toBeUndefined()
    expect(status.usage.calls).toBe(0)
    expect((await client.call('memory.list', { cwd })).observations).toEqual([])
  })

  it('activada con el resumidor falso: una sesión genera observaciones, eventos, recuerdo y estado', async () => {
    const daemon = await boot({
      memory: { enabled: true, summarizer: { kind: 'fake' }, thresholds: THRESHOLDS },
    })
    const client = await connect(daemon)
    const cwd = workdir()
    const updates: unknown[] = []
    client.on('memory.updated', (data) => updates.push(data))
    const { session } = await newSession(client, cwd)
    await talk(client, session, 2)

    await until(
      async () => (await client.call('memory.list', { cwd })).observations.length > 0,
      'observaciones',
    )
    const listed = await client.call('memory.list', { cwd })
    expect(listed.observations[0]).toMatchObject({
      priority: 'medium',
      scope: 'project',
      sessionId: session.id,
    })
    expect(listed.observations[0]?.text).toContain('Observado:')

    await until(() => updates.length > 0, 'evento memory.updated')
    expect(updates[0]).toMatchObject({ kind: 'observe' })

    const status = await client.call('memory.status', { cwd })
    expect(status).toMatchObject({
      enabled: true,
      summarizer: 'fake',
      thresholds: THRESHOLDS,
    })
    expect(status.pausedReason).toBeUndefined()
    expect(status.roles?.observer.calls).toBeGreaterThan(0)
    // el Observador puede seguir con otro lote entre las dos lecturas
    expect(status.project?.observations).toBeGreaterThanOrEqual(listed.observations.length)

    const found = await client.call('memory.search', { cwd, query: 'observado' })
    expect(found.observations.length).toBeGreaterThan(0)

    // recall: el texto original del rango que cita la primera observación
    const first = listed.observations[0]
    if (first === undefined) throw new Error('sin observación')
    const recalled = await client.call('memory.recall', {
      sessionId: session.id,
      range: first.range,
    })
    expect(recalled.blocks.length).toBeGreaterThan(0)
    expect(recalled.blocks[0]).toMatchObject({ type: 'user' })
    await expect(
      client.call('memory.recall', { sessionId: 'agent-nope' as never, range: { from: 0, to: 1 } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('persiste en el directorio de estado: tras reiniciar el daemon sigue ahí', async () => {
    const stateDir = workdir()
    const cwd = workdir()
    const first = await boot({
      stateDir,
      memory: { enabled: true, summarizer: { kind: 'fake' }, thresholds: THRESHOLDS },
    })
    const client = await connect(first)
    const { session } = await newSession(client, cwd)
    await talk(client, session, 2)
    await until(
      async () => (await client.call('memory.list', { cwd })).observations.length > 0,
      'observaciones',
    )
    const before = await client.call('memory.list', { cwd })
    client.close()
    await first.stop()
    daemons.splice(daemons.indexOf(first), 1)

    const second = await boot({ stateDir })
    const again = await connect(second)
    const after = await again.call('memory.list', { cwd })
    // lo ya visto sigue igual (un lote en vuelo al apagar pudo añadir más)
    expect(after.observations.slice(0, before.observations.length)).toEqual(before.observations)
    expect((await again.call('memory.status', {})).enabled).toBe(false)
  })

  it('«vía proveedor»: usa un proveedor registrado sin abrir pestañas ni sesiones del usuario', async () => {
    const daemon = await boot({
      memory: {
        enabled: true,
        summarizer: { kind: 'provider', id: 'fake' },
        thresholds: THRESHOLDS,
      },
    })
    const client = await connect(daemon)
    const cwd = workdir()
    const { session } = await newSession(client, cwd)
    const tabsBefore = (await client.call('workspace.list', {})).workspaces.flatMap((w) => w.tabs)
    await talk(client, session, 1)
    await until(
      async () => (await client.call('memory.status', { cwd })).usage.calls > 0,
      'llamada al proveedor',
    )
    const status = await client.call('memory.status', { cwd })
    expect(status.summarizer).toBe('provider:fake')
    expect(status.pausedReason).toBeUndefined()
    // la sesión de resumen no es una sesión del usuario ni una pestaña
    const sessions = (await client.call('agent.list', {})).sessions
    expect(sessions.map((s) => s.id)).toEqual([session.id])
    const tabsAfter = (await client.call('workspace.list', {})).workspaces.flatMap((w) => w.tabs)
    expect(tabsAfter.length).toBe(tabsBefore.length)
  })

  it('sin resumidor, o con uno no registrado, queda en pausa con motivo y el daemon arranca', async () => {
    const none = await boot({ memory: { enabled: true } })
    const client = await connect(none)
    const a = await client.call('memory.status', {})
    expect(a.enabled).toBe(true)
    expect(a.pausedReason).toContain('NEXO_MEMORY_SUMMARIZER')

    const missing = await boot({
      memory: { enabled: true, summarizer: { kind: 'provider', id: 'gemini', model: 'flash' } },
    })
    const other = await connect(missing)
    const b = await other.call('memory.status', {})
    expect(b.pausedReason).toContain('gemini')
    expect(b.pausedReason).toContain('no está registrado')
    expect(b.summarizer).toBe('provider:gemini:flash')
  })

  it('un resumidor no disponible (Ollama sin servidor) deja la memoria en pausa, no en error', async () => {
    const daemon = await boot({
      ollamaUrl: 'http://127.0.0.1:1',
      memory: { enabled: true, summarizer: { kind: 'ollama', model: 'llama3.2:3b' } },
    })
    const client = await connect(daemon)
    await until(
      async () => (await client.call('memory.status', {})).pausedReason !== undefined,
      'pausa por resumidor no disponible',
    )
    const status = await client.call('memory.status', {})
    expect(status.summarizer).toBe('ollama:llama3.2:3b')
    expect(status.pausedReason).toContain('no está disponible')
    expect(daemon.logs.some((l) => l.includes('"level":"error"'))).toBe(false)
  })

  it('al cerrar el daemon cancela la llamada en curso y no deja nada colgado', async () => {
    let aborted = false
    const hanging: SummarizerPort = {
      id: 'colgado',
      isAvailable: async () => true,
      summarize: (_request, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new SummarizerError('ABORTED', 'cancelado'))
          })
        }),
    }
    const daemon = await boot({
      memory: { enabled: true, summarizer: hanging, thresholds: THRESHOLDS },
    })
    const client = await connect(daemon)
    const cwd = workdir()
    const { session } = await newSession(client, cwd)
    await talk(client, session, 1)
    await new Promise((r) => setTimeout(r, 100))
    const started = Date.now()
    client.close()
    await daemon.stop()
    daemons.splice(daemons.indexOf(daemon), 1)
    expect(aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000 * SCALE)
  })

  it('los parámetros de memory.* se validan con zod en el borde', async () => {
    const daemon = await boot()
    const client = await connect(daemon)
    await expect(client.call('memory.list', {} as never)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
    await expect(
      client.call('memory.search', { cwd: '/x', query: 'a'.repeat(300) }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(
      client.call('memory.recall', { sessionId: 's1', range: { from: 0, to: 5000 } } as never),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })
})
