import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { call, ECHO_SCRIPT, Sandbox, TIMEOUT_SCALE, waitUntil } from './integration-helpers.ts'

let sandbox: Sandbox | undefined
afterEach(async () => {
  await sandbox?.cleanup()
  sandbox = undefined
})

type Body = Record<string, unknown>
const readJson = async (s: Awaited<ReturnType<Sandbox['mcp']>>, uri: string): Promise<Body> => {
  const r = await s.client.readResource({ uri })
  return JSON.parse((r.contents[0] as { text: string }).text) as Body
}

describe('servidor MCP real contra el daemon real (proveedor falso)', () => {
  it('lectura, escritura con permiso, recursos suscritos y notificaciones', async () => {
    const sb = await Sandbox.create()
    sandbox = sb
    await sb.startDaemon()
    const token = await sb.token()
    const mcp = await sb.mcp({ NEXO_MCP_WRITE: '1', NEXO_MCP_ALLOW_PERMISSIONS: '1' })

    const tools = (await mcp.client.listTools()).tools.map((t) => t.name)
    expect(tools).toEqual(
      expect.arrayContaining(['terminal_write', 'agent_send', 'agent_respond', 'workspaces_list']),
    )

    const status = await call(mcp, 'nexo_status')
    expect(status.structured).toMatchObject({ connected: true, write: { enabled: true } })

    // un espacio con una terminal que repite lo que recibe
    const direct = await sb.direct()
    const { workspace } = await direct.call('workspace.create', { name: 'proyecto', cwd: tmpdir() })
    const { tab } = await direct.call('tab.create', { workspaceId: workspace.id, cwd: tmpdir() })
    const first = tab.panes[0]
    if (first === undefined) throw new Error('el espacio no trae panel')
    const { terminalId } = await direct.call('terminal.spawn', {
      paneId: first.id,
      cmd: process.execPath,
      args: ['-e', ECHO_SCRIPT],
      cols: 100,
      rows: 30,
    })

    const listed = await call(mcp, 'workspaces_list')
    expect(listed.text).toContain(workspace.id)
    expect(listed.text).toContain(`terminal=${terminalId}`)

    // salida de terminal limpia
    await waitUntil(async () =>
      (await call(mcp, 'terminal_read', { terminalId })).text.includes('LISTO'),
    )
    const written = await call(mcp, 'terminal_write', { terminalId, data: 'hola\r' })
    expect(written.error).toBe(false)
    const out = await waitUntil(async () => {
      const r = await call(mcp, 'terminal_read', { terminalId, lines: 20 })
      return r.text.includes('eco:') ? r.text : false
    })
    expect(out).not.toContain('\x1b')

    // sesión de agente: crear, suscribirse, conversar
    const created = await call(mcp, 'agent_create', {
      workspaceId: workspace.id,
      provider: 'fake',
      title: 'mcp',
    })
    expect(created.error, created.text).toBe(false)
    const sessionId = (created.structured as { sessionId: string }).sessionId
    const statusUri = `nexo://agents/${sessionId}/status`
    await mcp.client.subscribeResource({ uri: statusUri })
    await mcp.client.subscribeResource({ uri: 'nexo://attention' })

    const sent = await call(mcp, 'agent_send', { sessionId, text: 'hola mundo' })
    expect(sent.error, sent.text).toBe(false)
    await waitUntil(() => mcp.updates.includes(statusUri))
    await waitUntil(async () => (await readJson(mcp, statusUri)).status === 'done')
    const blocks = await call(mcp, 'agent_blocks', { sessionId })
    expect(blocks.text).toContain('hola mundo')
    expect(blocks.text).toContain('Eco: hola mundo')
    expect((await call(mcp, 'agents_list')).text).toContain(sessionId)
    expect(((await readJson(mcp, 'nexo://agents')).sessions as unknown[]).length).toBe(1)

    // el permiso lo resuelve la herramienta (solo allow-once / reject-once)
    mcp.updates.length = 0
    await call(mcp, 'agent_send', { sessionId, text: 'permiso' })
    await waitUntil(async () => (await readJson(mcp, statusUri)).status === 'needs-input')
    await waitUntil(() => mcp.updates.includes('nexo://attention'))
    const attention = await readJson(mcp, 'nexo://attention')
    expect(attention.state).toBe('needs-input')
    const pending = await call(mcp, 'agent_blocks', { sessionId, limit: 5 })
    const blockList = (
      pending.structured as { blocks: { index: number; type: string; state?: string }[] }
    ).blocks
    const permission = blockList.find((b) => b.type === 'permission' && b.state === 'pending')
    expect(permission).toBeDefined()
    const responded = await call(mcp, 'agent_respond', {
      sessionId,
      index: permission?.index,
      optionId: 'allow',
    })
    expect(responded.error, responded.text).toBe(false)
    await waitUntil(async () =>
      (await call(mcp, 'agent_blocks', { sessionId })).text.includes('Permiso concedido'),
    )

    // interrupción
    await call(mcp, 'agent_send', { sessionId, text: 'largo' })
    await waitUntil(async () => (await readJson(mcp, statusUri)).status === 'working')
    expect((await call(mcp, 'agent_interrupt', { sessionId })).error).toBe(false)
    await waitUntil(async () => (await readJson(mcp, statusUri)).status !== 'working')

    // el resto de lecturas contra el daemon real
    expect((await call(mcp, 'agent_providers')).text).toContain('fake')
    expect((await call(mcp, 'limits_status')).error).toBe(false)
    expect((await call(mcp, 'history_list')).error).toBe(false)
    expect(
      (await call(mcp, 'memory_search', { cwd: tmpdir(), query: 'nada' })).text.length,
    ).toBeGreaterThan(0)
    expect((await readJson(mcp, 'nexo://limits')).providers).toBeDefined()
    const resources = (await mcp.client.listResources()).resources.map((r) => r.uri)
    expect(resources).toContain(statusUri)

    // ni el token ni el protocolo del daemon se filtran a stderr
    expect(mcp.stderr()).not.toContain(token)
    expect(mcp.stderr()).toContain('listo')
  })

  it('sin NEXO_MCP_WRITE no hay escritura y el daemon no recibe nada', async () => {
    const sb = await Sandbox.create()
    sandbox = sb
    await sb.startDaemon()
    const mcp = await sb.mcp()
    const direct = await sb.direct()
    const { workspace } = await direct.call('workspace.create', { name: 'p', cwd: tmpdir() })
    const { tab } = await direct.call('tab.create', { workspaceId: workspace.id, cwd: tmpdir() })
    const first = tab.panes[0]
    if (first === undefined) throw new Error('sin panel')
    const { terminalId } = await direct.call('terminal.spawn', {
      paneId: first.id,
      cmd: process.execPath,
      args: ['-e', ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    })
    const tools = (await mcp.client.listTools()).tools.map((t) => t.name)
    expect(tools).not.toContain('terminal_write')
    const r = await call(mcp, 'terminal_write', { terminalId, data: 'intruso\r' })
    expect(r.error).toBe(true)
    await new Promise((res) => setTimeout(res, 500))
    expect((await call(mcp, 'terminal_read', { terminalId })).text).not.toContain('intruso')
  })

  it('daemon caído: errores claros; al volver el daemon, se recupera solo', async () => {
    const sb = await Sandbox.create()
    sandbox = sb
    const daemon = await sb.startDaemon()
    const mcp = await sb.mcp()
    expect((await call(mcp, 'workspaces_list')).error).toBe(false)

    daemon.kill()
    await waitUntil(async () => {
      const r = await call(mcp, 'workspaces_list')
      return r.error ? r : false
    })
    const down = await call(mcp, 'workspaces_list')
    expect(down.error).toBe(true)
    expect(down.text).toMatch(/DAEMON_UNAVAILABLE|DISCONNECTED|CLOSED|TIMEOUT/)
    const info = await call(mcp, 'nexo_status')
    expect(info.error).toBe(false)

    await sb.startDaemon()
    await waitUntil(async () => !(await call(mcp, 'workspaces_list')).error, 45_000 * TIMEOUT_SCALE)
    expect((await call(mcp, 'nexo_status')).structured).toMatchObject({ connected: true })
  })
})
