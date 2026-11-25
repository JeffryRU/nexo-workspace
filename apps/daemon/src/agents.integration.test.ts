import { tmpdir } from 'node:os'
import {
  AgentDocument,
  agentApi,
  NexoClient,
  type Transport,
  webSocketTransport,
} from '@nexo/client'
import type { AgentSession, Block, PaneId } from '@nexo/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedAgentProvider } from './adapters/scripted-agent-provider.ts'
import { startTestDaemon, type TestDaemon } from './test-helpers.ts'

const daemons: TestDaemon[] = []
const clients: NexoClient[] = []
const docs: AgentDocument[] = []

afterEach(async () => {
  for (const d of docs.splice(0)) d.dispose()
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.cleanup()
})

async function boot(chunkMs = 5) {
  const provider = new ScriptedAgentProvider({ chunkMs })
  const daemon = await startTestDaemon({ agentProviders: [provider] })
  daemons.push(daemon)
  return { daemon, provider }
}

type Conn = { client: NexoClient; transports: Transport[] }

async function connect(daemon: TestDaemon): Promise<Conn> {
  const transports: Transport[] = []
  const client = new NexoClient({
    transport: () => {
      const t = webSocketTransport({ url: `ws://127.0.0.1:${daemon.port}/`, token: daemon.token })
      transports.push(t)
      return t
    },
    reconnect: { baseMs: 10, maxMs: 50 },
  })
  clients.push(client)
  await client.connect()
  await client.subscribe()
  return { client, transports }
}

const SCALE = Math.max(1, Number(process.env.NEXO_TEST_TIMEOUT_SCALE ?? '1') || 1)

async function until(
  check: () => boolean,
  label: string,
  timeoutMs = 10_000 * SCALE,
): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`tiempo agotado: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Crea espacio, pestaña, panel de agente (el panel inicial se cierra) y la sesión. */
async function newSession(client: NexoClient): Promise<{ session: AgentSession; paneId: PaneId }> {
  const cwd = tmpdir()
  const { workspace } = await client.call('workspace.create', { name: 'agentes', cwd })
  const { tab } = await client.call('tab.create', { workspaceId: workspace.id, cwd })
  const first = tab.panes[0]
  if (first === undefined) throw new Error('sin panel')
  const { pane } = await client.call('pane.split', {
    paneId: first.id,
    direction: 'row',
    kind: 'agent',
  })
  await client.call('pane.close', { paneId: first.id })
  const { session } = await client.call('agent.create', { paneId: pane.id, provider: 'fake' })
  return { session, paneId: pane.id }
}

async function fullSnapshot(client: NexoClient, session: AgentSession): Promise<Block[]> {
  const blocks: Block[] = []
  let from: number | null = 0
  while (from !== null) {
    const page: Awaited<ReturnType<ReturnType<typeof agentApi>['snapshot']>> = await agentApi(
      client,
    ).snapshot({ sessionId: session.id, fromIndex: from, limit: 3 })
    blocks.push(...page.blocks)
    from = page.nextIndex
  }
  return blocks
}

const idle = (doc: AgentDocument) => doc.session?.status === 'done'

describe('agentes en el daemon real (proveedor falso)', () => {
  it('conversación completa: el documento del cliente coincide con el snapshot', async () => {
    const { daemon } = await boot()
    const { client } = await connect(daemon)
    const { session } = await newSession(client)
    const doc = await AgentDocument.open(client, session.id)
    docs.push(doc)
    const api = agentApi(client)
    await api.send({ sessionId: session.id, text: 'hola mundo' })
    await until(() => doc.blocks().some((b) => b.type === 'usage'), 'fin del turno')
    const types = doc.blocks().map((b) => b.type)
    expect(types).toEqual(['user', 'text', 'usage'])
    expect(doc.blocks()[1]).toMatchObject({ text: 'Eco: hola mundo', complete: true })
    await until(() => idle(doc), 'estado idle')
    expect(doc.blocks()).toEqual(await fullSnapshot(client, session))
    // segundo turno
    await api.send({ sessionId: session.id, text: 'otra' })
    await until(() => doc.blocks().filter((b) => b.type === 'usage').length === 2, 'segundo turno')
    expect(doc.blocks()).toEqual(await fullSnapshot(client, session))
  })

  it('dos clientes ven el mismo documento', async () => {
    const { daemon } = await boot()
    const a = await connect(daemon)
    const b = await connect(daemon)
    const { session } = await newSession(a.client)
    const docA = await AgentDocument.open(a.client, session.id)
    const docB = await AgentDocument.open(b.client, session.id)
    docs.push(docA, docB)
    await agentApi(a.client).send({ sessionId: session.id, text: 'lento 10' })
    await until(() => docB.blocks().some((x) => x.type === 'usage'), 'fin del turno en B')
    await until(() => docA.blocks().some((x) => x.type === 'usage'), 'fin del turno en A')
    expect(docA.blocks()).toEqual(docB.blocks())
    expect(docA.blocks()).toEqual(await fullSnapshot(a.client, session))
  })

  it('reconexión a mitad de una respuesta: el documento final coincide con el snapshot', async () => {
    const { daemon } = await boot(15)
    const { client, transports } = await connect(daemon)
    const { session } = await newSession(client)
    const doc = await AgentDocument.open(client, session.id)
    docs.push(doc)
    await agentApi(client).send({ sessionId: session.id, text: 'lento 40' })
    await until(
      () => doc.blocks().some((b) => b.type === 'text' && b.text.length > 3 * 'palabra '.length),
      'primeros deltas',
    )
    transports.at(-1)?.close()
    await until(() => client.state === 'reconnecting' || transports.length > 1, 'corte')
    await until(() => doc.blocks().some((b) => b.type === 'usage'), 'fin del turno tras reconectar')
    await doc.settled()
    const final = await fullSnapshot(client, session)
    expect(doc.blocks()).toEqual(final)
    const text = final.find((b) => b.type === 'text')
    expect(text).toMatchObject({ text: 'palabra '.repeat(40), complete: true })
  })

  it('permiso y pregunta se resuelven desde otro cliente', async () => {
    const { daemon } = await boot()
    const a = await connect(daemon)
    const b = await connect(daemon)
    const { session } = await newSession(a.client)
    const docA = await AgentDocument.open(a.client, session.id)
    const docB = await AgentDocument.open(b.client, session.id)
    docs.push(docA, docB)
    await agentApi(a.client).send({ sessionId: session.id, text: 'permiso' })
    await until(() => docB.pending().length === 1, 'permiso pendiente en B')
    const perm = docB.pending()[0]
    expect(perm?.type).toBe('permission')
    expect(docA.session?.status).toBe('needs-input')
    await agentApi(b.client).respond({
      type: 'permission',
      sessionId: session.id,
      blockId: perm?.id as never,
      optionId: 'allow',
    })
    await until(() => docA.blocks().some((x) => x.type === 'usage'), 'turno del permiso')
    expect(docA.blocks().find((x) => x.type === 'permission')).toMatchObject({ state: 'accepted' })
    expect(docA.blocks().find((x) => x.type === 'text')).toMatchObject({
      text: 'Permiso concedido',
    })

    await agentApi(b.client).send({ sessionId: session.id, text: 'pregunta' })
    await until(() => docA.pending().some((x) => x.type === 'question'), 'pregunta en A')
    const q = docA.pending().find((x) => x.type === 'question')
    await agentApi(a.client).respond({
      type: 'question',
      sessionId: session.id,
      blockId: q?.id as never,
      answers: [{ questionId: 'q1', selected: ['B'] }],
    })
    await until(
      () => docB.blocks().some((x) => x.type === 'text' && x.text === 'Elegiste: B'),
      'respuesta a la pregunta',
    )
    // responder dos veces da error, no rompe
    await expect(
      agentApi(b.client).respond({
        type: 'question',
        sessionId: session.id,
        blockId: q?.id as never,
        answers: [{ questionId: 'q1', selected: ['A'] }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('interrumpir termina el turno', async () => {
    const { daemon } = await boot()
    const { client } = await connect(daemon)
    const { session } = await newSession(client)
    const doc = await AgentDocument.open(client, session.id)
    docs.push(doc)
    await agentApi(client).send({ sessionId: session.id, text: 'largo' })
    await until(() => doc.blocks().some((b) => b.type === 'text'), 'respuesta en curso')
    await agentApi(client).interrupt({ sessionId: session.id })
    await until(() => doc.blocks().some((b) => b.type === 'usage'), 'fin interrumpido')
    expect(doc.blocks().at(-1)).toMatchObject({ type: 'usage', stopReason: 'interrupted' })
  })

  it('cerrar el panel cierra la sesión', async () => {
    const { daemon, provider } = await boot()
    const { client } = await connect(daemon)
    const { session, paneId } = await newSession(client)
    const removed: unknown[] = []
    client.on('agent.session', (d) => {
      if ('removed' in d) removed.push(d)
    })
    expect(provider.sessions).toHaveLength(1)
    await client.call('pane.close', { paneId })
    await until(() => provider.sessions[0]?.closed === true, 'sesión cerrada')
    await until(() => removed.length === 1, 'aviso de cierre')
    expect((await client.call('agent.list', {})).sessions.map((s) => s.id)).not.toContain(
      session.id,
    )
  })

  it('apagar el daemon cierra todas las sesiones', async () => {
    const { daemon, provider } = await boot()
    const { client } = await connect(daemon)
    await newSession(client)
    await newSession(client)
    expect(provider.sessions).toHaveLength(2)
    await daemon.stop()
    expect(provider.sessions.every((s) => s.closed)).toBe(true)
  })

  it('un panel de agente nuevo precalienta el proveedor', async () => {
    const { daemon, provider } = await boot()
    const { client } = await connect(daemon)
    const cwd = tmpdir()
    const { workspace } = await client.call('workspace.create', { name: 'w', cwd })
    const { tab } = await client.call('tab.create', { workspaceId: workspace.id, cwd })
    expect(provider.warmed).toEqual([])
    await client.call('pane.split', {
      paneId: tab.panes[0]?.id as never,
      direction: 'column',
      kind: 'agent',
    })
    await until(() => provider.warmed.length === 1, 'precalentamiento')
    expect(provider.warmed[0]).toBe(cwd)
  })

  it('sin proveedores, agent.* responde PROVIDER_UNAVAILABLE', async () => {
    const daemon = await startTestDaemon({ agentProviders: [] })
    daemons.push(daemon)
    const { client } = await connect(daemon)
    await expect(client.call('agent.providers', {})).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    })
  })

  it('el proveedor fake de nombre se crea cuando se pide por nombre', async () => {
    const daemon = await startTestDaemon({ agentProviders: ['fake'] })
    daemons.push(daemon)
    const { client } = await connect(daemon)
    const { providers } = await client.call('agent.providers', {})
    expect(providers.map((p) => p.id)).toEqual(['fake'])
    expect(daemon.logs.join('\n')).toContain('proveedor de agente de prueba activo')
  })

  it('por omisión registra claude sin llamar al SDK', async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const { client } = await connect(daemon)
    expect(await client.call('agent.list', {})).toEqual({ sessions: [] })
  })
})
