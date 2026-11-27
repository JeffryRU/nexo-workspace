import { afterEach, describe, expect, it } from 'vitest'
import {
  block,
  callTool,
  clientError,
  config,
  connectPair,
  FakeClient,
  PANE_ID,
  type Pair,
  SESSION_ID,
  session,
  TAB_ID,
  TERM_ID,
  WS_ID,
  waitFor,
  workspace,
} from './test-helpers.ts'
import { enabledTools, READ_TOOLS } from './tools.ts'
import { agentStatusUri, URI } from './views.ts'

let pair: Pair | undefined
afterEach(async () => {
  await pair?.close()
  pair = undefined
})

async function names(p: Pair): Promise<string[]> {
  return (await p.client.listTools()).tools.map((t) => t.name).sort()
}

describe('herramientas registradas', () => {
  it('sin permiso de escritura solo hay lectura', async () => {
    pair = await connectPair()
    expect(await names(pair)).toEqual([...READ_TOOLS].sort())
    expect(enabledTools(config())).toEqual([...READ_TOOLS])
    expect(enabledTools(config({ write: true }))).toContain('terminal_write')
    expect(enabledTools(config({ write: true }))).not.toContain('agent_respond')
    expect(enabledTools(config({ write: true, allowPermissions: true }))).toContain('agent_respond')
  })

  it('con NEXO_MCP_WRITE aparecen las de escritura, y agent_respond solo con su permiso', async () => {
    pair = await connectPair({ config: { write: true } })
    const list = await names(pair)
    expect(list).toContain('terminal_write')
    expect(list).toContain('agent_send')
    expect(list).not.toContain('agent_respond')
    await pair.close()
    pair = await connectPair({ config: { write: true, allowPermissions: true } })
    expect(await names(pair)).toContain('agent_respond')
  })

  it('todas llevan anotaciones coherentes y esquema de entrada', async () => {
    pair = await connectPair({ config: { write: true, allowPermissions: true } })
    const { tools } = await pair.client.listTools()
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(10)
      expect(t.inputSchema.type).toBe('object')
      expect(/^[a-z0-9_]+$/.test(t.name)).toBe(true)
      const write = [
        'terminal_write',
        'agent_create',
        'agent_send',
        'agent_interrupt',
        'agent_respond',
      ]
      expect(t.annotations?.readOnlyHint).toBe(!write.includes(t.name))
    }
  })
})

describe('lectura', () => {
  it('nexo_status informa del daemon y de los permisos', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('daemon.info', () => ({
      version: '1.2.3',
      protocol: 1,
      pid: 42,
      startedAt: 'hoy',
    }))
    const r = await callTool(pair, 'nexo_status')
    expect(r.error).toBe(false)
    expect(r.text).toContain('1.2.3')
    expect(r.text).toContain('desactivada')
    expect(r.structured).toMatchObject({ connected: true, write: { enabled: false } })
  })

  it('nexo_status no falla con el daemon caído: lo dice', async () => {
    pair = await connectPair({
      connect: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const r = await callTool(pair, 'nexo_status')
    expect(r.error).toBe(false)
    expect(r.structured).toMatchObject({ connected: false })
  })

  it('workspaces_list muestra ids de panel, terminal y sesión', async () => {
    pair = await connectPair()
    pair.fake.workspaces = [workspace()]
    const r = await callTool(pair, 'workspaces_list')
    expect(r.text).toContain(WS_ID)
    expect(r.text).toContain(TAB_ID)
    expect(r.text).toContain(PANE_ID)
    expect(r.text).toContain(`terminal=${TERM_ID}`)
    expect(r.structured).toHaveProperty('workspaces')
    pair.fake.workspaces = []
    expect((await callTool(pair, 'workspaces_list')).text).toBe('No hay espacios.')
  })

  it('terminal_read limpia secuencias de escape y devuelve el final', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('terminal.read', () => ({
      data: '\x1b[32mlinea 1\x1b[0m\r\nlinea 2\x07\r\n\x1b]0;titulo\x07linea 3\r\n',
      offset: 99,
    }))
    const r = await callTool(pair, 'terminal_read', { terminalId: TERM_ID, lines: 2 })
    expect(r.text).toBe('linea 2\nlinea 3\n')
    expect(r.text).not.toContain('\x1b')
    expect(r.structured).toMatchObject({ offset: 99, truncated: false })
  })

  it('terminal_read acota los bytes por la cola y avisa', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('terminal.read', () => ({
      data: `${'a'.repeat(5000)}FIN`,
      offset: 1,
      truncated: true,
    }))
    const r = await callTool(pair, 'terminal_read', { terminalId: TERM_ID, maxBytes: 100 })
    expect(r.text.length).toBe(100)
    expect(r.text.endsWith('FIN')).toBe(true)
    expect(r.structured).toMatchObject({ truncated: true })
    const call = pair.fake.callsTo('terminal.read')[0] as { maxBytes: number }
    expect(call.maxBytes).toBe(400)
  })

  it('terminal_read sin salida lo dice', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('terminal.read', () => ({ data: '', offset: 0 }))
    expect((await callTool(pair, 'terminal_read', { terminalId: TERM_ID })).text).toBe(
      '(sin salida)',
    )
  })

  it('agents_list y agent_providers', async () => {
    pair = await connectPair()
    pair.fake.sessions = [
      session({ status: 'working', turn: 2, blockCount: 5, title: 'mi agente' }),
    ]
    const r = await callTool(pair, 'agents_list')
    expect(r.text).toContain(`${SESSION_ID} fake "mi agente" [working] turno 2, 5 bloques`)
    pair.fake.sessions = []
    expect((await callTool(pair, 'agents_list')).text).toBe('No hay sesiones de agente.')
    pair.fake.handlers.set('agent.providers', () => ({
      providers: [
        {
          id: 'fake',
          name: 'Falso',
          available: true,
          capabilities: {
            permissionModes: ['ask'],
            models: [],
            efforts: [],
            resume: false,
            warmup: false,
            streaming: true,
          },
        },
        {
          id: 'claude',
          name: 'Claude',
          available: false,
          reason: 'sin sesión',
          capabilities: {
            permissionModes: ['ask'],
            defaultModel: 'm',
            models: [],
            efforts: [],
            resume: true,
            warmup: false,
            streaming: true,
          },
        },
      ],
    }))
    const p = await callTool(pair, 'agent_providers')
    expect(p.text).toContain('fake (Falso): disponible')
    expect(p.text).toContain('no disponible - sin sesión')
  })

  it('agent_blocks lee los últimos bloques, sin la salida de las acciones por omisión', async () => {
    pair = await connectPair()
    const blocks = [
      block(0, { type: 'user', text: 'hola' }),
      block(1, { type: 'text', text: '\x1b[1mhecho\x1b[0m', complete: true }),
      block(2, {
        type: 'action',
        kind: 'exec',
        status: 'ok',
        tool: 'Bash',
        title: 'ls',
        output: 'SECRETO=abc',
        exitCode: 0,
      }),
    ]
    pair.fake.handlers.set('agent.snapshot', (p) => {
      const q = p as { fromIndex?: number; limit?: number }
      const from = q.fromIndex ?? 0
      return {
        session: session({ blockCount: 3, status: 'done', turn: 1 }),
        blocks: blocks.slice(from, from + (q.limit ?? 200)),
        nextIndex: null,
      }
    })
    const r = await callTool(pair, 'agent_blocks', { sessionId: SESSION_ID, limit: 2 })
    expect(r.text).toContain('#1 agente')
    expect(r.text).toContain('hecho')
    expect(r.text).not.toContain('\x1b')
    expect(r.text).toContain('#2 acción ok')
    expect(r.text).not.toContain('SECRETO')
    expect(r.text).toContain('salida omitida')
    const withOutput = await callTool(pair, 'agent_blocks', {
      sessionId: SESSION_ID,
      limit: 2,
      includeActionOutput: true,
    })
    expect(withOutput.text).toContain('SECRETO=abc')
    const explicit = await callTool(pair, 'agent_blocks', {
      sessionId: SESSION_ID,
      fromIndex: 0,
      limit: 1,
    })
    expect(explicit.text).toContain('#0 usuario')
    expect(explicit.text).not.toContain('#1 ')
  })

  it('memory_search y memory_recall', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('memory.search', () => ({
      observations: [
        {
          seq: 3,
          at: 1,
          priority: 'high',
          scope: 'project',
          sessionId: SESSION_ID,
          range: { from: 2, to: 4 },
          text: 'usa pnpm\x1b[0m',
        },
      ],
      truncated: true,
    }))
    const s = await callTool(pair, 'memory_search', { cwd: '/work/proyecto', query: 'pnpm' })
    expect(s.text).toContain('#3 [high/project]')
    expect(s.text).toContain('usa pnpm')
    expect(s.text).toContain('Hay más coincidencias')
    pair.fake.handlers.set('memory.search', () => ({ observations: [], truncated: false }))
    expect((await callTool(pair, 'memory_search', { cwd: '/x', query: 'zzz' })).text).toBe(
      'Sin coincidencias.',
    )
    pair.fake.handlers.set('memory.recall', () => ({
      blocks: [block(2, { type: 'user', text: 'quiero X' })],
      truncated: false,
    }))
    const rc = await callTool(pair, 'memory_recall', { sessionId: SESSION_ID, from: 2, to: 4 })
    expect(rc.text).toContain('quiero X')
    expect(
      (await callTool(pair, 'memory_recall', { sessionId: SESSION_ID, from: 5, to: 4 })).error,
    ).toBe(true)
    expect(
      (await callTool(pair, 'memory_recall', { sessionId: SESSION_ID, from: 0, to: 60 })).text,
    ).toMatch(/50 bloques/)
  })

  it('history_list e history_read', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('history.list', () => ({
      projects: [
        {
          cwd: '/work/p',
          name: 'p',
          sessions: [
            {
              provider: 'claude',
              sessionId: 'abc123',
              title: 'algo',
              updatedAt: 1,
              resumable: true,
              readable: true,
            },
          ],
        },
      ],
      nextCursor: 'cur_1',
      providers: [{ provider: 'claude', status: 'ok' }],
    }))
    const l = await callTool(pair, 'history_list', { provider: 'claude' })
    expect(l.text).toContain('claude abc123 "algo"')
    expect(l.text).toContain('cursor=cur_1')
    pair.fake.handlers.set('history.read', () => ({
      provider: 'claude',
      sessionId: 'abc123',
      blocks: [{ index: 0, turn: 1, block: { type: 'user', text: 'hola' } }],
      nextCursor: null,
      total: 1,
      truncated: false,
    }))
    const r = await callTool(pair, 'history_read', { provider: 'claude', sessionId: 'abc123' })
    expect(r.text).toContain('#0 usuario')
    expect(r.text).toContain('1 bloques en total')
  })

  it('limits_status resume el peor porcentaje', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('limits.status', () => ({
      providers: [
        {
          provider: 'codex',
          status: 'ok',
          windows: [{ id: 'primary', usedPercent: 88 }],
          reached: false,
        },
      ],
    }))
    const r = await callTool(pair, 'limits_status', { refresh: true })
    expect(r.text).toContain('codex: ok, 88% usado')
    expect(r.structured).toMatchObject({ worstUsedPercent: 88 })
    expect(pair.fake.callsTo('limits.status')[0]).toEqual({ refresh: true })
  })

  it('los errores del daemon llegan como resultado de error claro', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('terminal.read', () => {
      throw clientError('NOT_FOUND', 'terminal inexistente')
    })
    const r = await callTool(pair, 'terminal_read', { terminalId: 'term-nada' })
    expect(r.error).toBe(true)
    expect(r.text).toMatch(/NOT_FOUND/)
    expect(r.text).toContain('terminal inexistente')
  })

  it('con el daemon caído pide abrir Nexo', async () => {
    pair = await connectPair({
      connect: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const r = await callTool(pair, 'workspaces_list')
    expect(r.error).toBe(true)
    expect(r.text).toContain('DAEMON_UNAVAILABLE')
  })

  it('recorta la salida al presupuesto configurado', async () => {
    pair = await connectPair({ config: { maxOutputBytes: 1024 } })
    pair.fake.workspaces = Array.from({ length: 40 }, (_, i) =>
      workspace({ id: `ws-${i}` as never, name: 'x'.repeat(100) as never }),
    )
    const r = await callTool(pair, 'workspaces_list')
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(1024)
    expect(r.text).toContain('[salida recortada]')
    expect(r.structured).toBeUndefined()
  })
})

describe('escritura', () => {
  it('terminal_write escribe con tope de bytes', async () => {
    pair = await connectPair({ config: { write: true, maxWriteBytes: 20 } })
    const ok = await callTool(pair, 'terminal_write', { terminalId: TERM_ID, data: 'ls\r' })
    expect(ok.error).toBe(false)
    expect(pair.fake.callsTo('terminal.write')).toEqual([{ terminalId: TERM_ID, data: 'ls\r' }])
    const big = await callTool(pair, 'terminal_write', {
      terminalId: TERM_ID,
      data: 'x'.repeat(21),
    })
    expect(big.error).toBe(true)
    expect(big.text).toMatch(/PAYLOAD_TOO_LARGE/)
    const nul = await callTool(pair, 'terminal_write', { terminalId: TERM_ID, data: 'a\u0000b' })
    expect(nul.error).toBe(true)
    expect(pair.fake.callsTo('terminal.write')).toHaveLength(1)
  })

  it('la frecuencia de escritura tiene tope', async () => {
    pair = await connectPair({ config: { write: true, writePerMinute: 3 } })
    const results = []
    for (let i = 0; i < 5; i++) {
      results.push(await callTool(pair, 'agent_interrupt', { sessionId: SESSION_ID }))
    }
    expect(results.map((r) => r.error)).toEqual([false, false, false, true, true])
    expect(results[3]?.text).toMatch(/RATE_LIMITED/)
    expect(pair.fake.callsTo('agent.interrupt')).toHaveLength(3)
    // la lectura sigue disponible
    expect((await callTool(pair, 'agents_list')).error).toBe(false)
  })

  it('la frecuencia de lectura tiene tope', async () => {
    pair = await connectPair({ config: { readPerMinute: 2 } })
    expect((await callTool(pair, 'agents_list')).error).toBe(false)
    expect((await callTool(pair, 'agents_list')).error).toBe(false)
    expect((await callTool(pair, 'agents_list')).text).toMatch(/RATE_LIMITED/)
  })

  it('agent_send respeta el tope y envía', async () => {
    pair = await connectPair({ config: { write: true, maxWriteBytes: 50 } })
    pair.fake.handlers.set('agent.send', () => ({ blockId: 'blk-1', index: 4, turn: 2 }))
    const ok = await callTool(pair, 'agent_send', { sessionId: SESSION_ID, text: 'haz esto' })
    expect(ok.text).toContain('turno 2')
    const big = await callTool(pair, 'agent_send', { sessionId: SESSION_ID, text: 'ñ'.repeat(30) })
    expect(big.text).toMatch(/PAYLOAD_TOO_LARGE/)
  })

  it('agent_create abre pestaña, panel de agente y sesión en la carpeta del espacio', async () => {
    pair = await connectPair({ config: { write: true } })
    pair.fake.workspaces = [workspace()]
    pair.fake.handlers.set('tab.create', () => ({ tab: workspace().tabs[0] }))
    pair.fake.handlers.set('pane.split', () => ({ pane: { id: 'pane-nuevo' }, layout: {} }))
    pair.fake.handlers.set('agent.create', () => ({ session: session({ id: 'agent-nueva' }) }))
    const r = await callTool(pair, 'agent_create', {
      workspaceId: WS_ID,
      provider: 'fake',
      title: 'trabajo',
      permissionMode: 'plan',
    })
    expect(r.error).toBe(false)
    expect(r.structured).toMatchObject({ sessionId: 'agent-nueva' })
    expect(pair.fake.callsTo('agent.create')[0]).toEqual({
      paneId: 'pane-nuevo',
      provider: 'fake',
      cwd: '/work/proyecto',
      permissionMode: 'plan',
    })
    expect(pair.fake.callsTo('tab.create')[0]).toMatchObject({
      workspaceId: WS_ID,
      cwd: '/work/proyecto',
      title: 'trabajo',
    })
    expect(pair.fake.callsTo('pane.close')).toEqual([{ paneId: PANE_ID }])
    // por omisión pide permisos
    await callTool(pair, 'agent_create', { workspaceId: WS_ID, provider: 'fake' })
    expect(pair.fake.callsTo('agent.create')[1]).toMatchObject({ permissionMode: 'ask' })
  })

  it('agent_create no admite bypass y limpia la pestaña si algo falla', async () => {
    pair = await connectPair({ config: { write: true } })
    pair.fake.workspaces = [workspace()]
    const bypass = await callTool(pair, 'agent_create', {
      workspaceId: WS_ID,
      provider: 'fake',
      permissionMode: 'bypass',
    })
    expect(bypass.error).toBe(true)
    expect(pair.fake.callsTo('tab.create')).toHaveLength(0)
    pair.fake.handlers.set('tab.create', () => ({ tab: workspace().tabs[0] }))
    pair.fake.handlers.set('pane.split', () => ({ pane: { id: 'pane-nuevo' }, layout: {} }))
    pair.fake.handlers.set('agent.create', () => {
      throw clientError('PROVIDER_UNAVAILABLE', 'no instalado')
    })
    const fail = await callTool(pair, 'agent_create', { workspaceId: WS_ID, provider: 'fake' })
    expect(fail.text).toMatch(/PROVIDER_UNAVAILABLE/)
    expect(pair.fake.callsTo('tab.close')).toEqual([{ tabId: TAB_ID }])
  })

  it('agent_create falla claro con un espacio inexistente o sin carpeta', async () => {
    pair = await connectPair({ config: { write: true } })
    expect(
      (await callTool(pair, 'agent_create', { workspaceId: 'ws-nada', provider: 'fake' })).text,
    ).toMatch(/NOT_FOUND/)
    pair.fake.workspaces = [workspace({ cwd: undefined as never })]
    expect(
      (await callTool(pair, 'agent_create', { workspaceId: WS_ID, provider: 'fake' })).text,
    ).toMatch(/carpeta/)
  })

  describe('agent_respond', () => {
    const permission = (state = 'pending') =>
      block(3, {
        type: 'permission',
        tool: 'Bash',
        title: 'Ejecutar ls',
        state,
        options: [
          { id: 'once', label: 'Permitir', kind: 'allow-once' },
          { id: 'always', label: 'Siempre', kind: 'allow-always' },
          { id: 'no', label: 'Rechazar', kind: 'reject-once' },
        ],
      })

    it('responde un permiso pendiente, pero nunca con allow-always', async () => {
      pair = await connectPair({ config: { write: true, allowPermissions: true } })
      pair.fake.handlers.set('agent.snapshot', () => ({
        session: session(),
        blocks: [permission()],
        nextIndex: null,
      }))
      const ok = await callTool(pair, 'agent_respond', {
        sessionId: SESSION_ID,
        index: 3,
        optionId: 'once',
      })
      expect(ok.error).toBe(false)
      expect(pair.fake.callsTo('agent.respond')).toEqual([
        { type: 'permission', sessionId: SESSION_ID, blockId: 'blk-00000003', optionId: 'once' },
      ])
      const always = await callTool(pair, 'agent_respond', {
        sessionId: SESSION_ID,
        index: 3,
        optionId: 'always',
      })
      expect(always.text).toMatch(/FORBIDDEN/)
      const unknown = await callTool(pair, 'agent_respond', {
        sessionId: SESSION_ID,
        index: 3,
        optionId: 'otra',
      })
      expect(unknown.text).toMatch(/INVALID_PARAMS/)
      expect(pair.fake.callsTo('agent.respond')).toHaveLength(1)
    })

    it('rechaza bloques que no son permisos o ya no están pendientes', async () => {
      pair = await connectPair({ config: { write: true, allowPermissions: true } })
      pair.fake.handlers.set('agent.snapshot', () => ({
        session: session(),
        blocks: [permission('accepted')],
        nextIndex: null,
      }))
      expect(
        (
          await callTool(pair, 'agent_respond', {
            sessionId: SESSION_ID,
            index: 3,
            optionId: 'once',
          })
        ).text,
      ).toMatch(/CONFLICT/)
      pair.fake.handlers.set('agent.snapshot', () => ({
        session: session(),
        blocks: [block(3, { type: 'user', text: 'x' })],
        nextIndex: null,
      }))
      expect(
        (
          await callTool(pair, 'agent_respond', {
            sessionId: SESSION_ID,
            index: 3,
            optionId: 'once',
          })
        ).text,
      ).toMatch(/NOT_FOUND/)
      pair.fake.handlers.set('agent.snapshot', () => ({
        session: session(),
        blocks: [],
        nextIndex: null,
      }))
      expect(
        (
          await callTool(pair, 'agent_respond', {
            sessionId: SESSION_ID,
            index: 9,
            optionId: 'once',
          })
        ).text,
      ).toMatch(/NOT_FOUND/)
      expect(pair.fake.callsTo('agent.respond')).toHaveLength(0)
    })
  })
})

describe('recursos', () => {
  it('lista los fijos y una entrada por sesión', async () => {
    pair = await connectPair()
    pair.fake.sessions = [session()]
    const { resources } = await pair.client.listResources()
    const uris = resources.map((r) => r.uri)
    expect(uris).toEqual(
      expect.arrayContaining([
        URI.attention,
        URI.workspaces,
        URI.agents,
        URI.limits,
        agentStatusUri(SESSION_ID),
      ]),
    )
  })

  it('sin daemon lista solo los fijos', async () => {
    pair = await connectPair({
      connect: async () => {
        throw new Error('caído')
      },
    })
    const { resources } = await pair.client.listResources()
    expect(resources.map((r) => r.uri).sort()).toEqual(
      [URI.agents, URI.attention, URI.limits, URI.workspaces].sort(),
    )
  })

  it('nexo://attention agrega el estado de los paneles', async () => {
    pair = await connectPair()
    const ws = workspace()
    const pane = ws.tabs[0]?.panes[0]
    if (pane === undefined) throw new Error('sin panel')
    pane.attention = 'error'
    pair.fake.workspaces = [ws]
    const r = await pair.client.readResource({ uri: URI.attention })
    const body = JSON.parse((r.contents[0] as { text: string }).text)
    expect(body.state).toBe('error')
    expect(body.panes[0].paneId).toBe(PANE_ID)
    expect(r.contents[0]?.mimeType).toBe('application/json')
  })

  it('nexo://agents/<id>/status lleva el motivo del último agent.status', async () => {
    pair = await connectPair()
    pair.fake.sessions = [session({ status: 'needs-input' })]
    await callTool(pair, 'agents_list') // conecta con el daemon
    pair.fake.emit('agent.status', {
      sessionId: SESSION_ID,
      status: 'needs-input',
      updatedAt: 5,
      reason: 'espera permiso',
    })
    const r = await pair.client.readResource({ uri: agentStatusUri(SESSION_ID) })
    const body = JSON.parse((r.contents[0] as { text: string }).text)
    expect(body).toMatchObject({
      sessionId: SESSION_ID,
      status: 'needs-input',
      reason: 'espera permiso',
    })
    // al volver a trabajar el motivo desaparece
    pair.fake.emit('agent.status', { sessionId: SESSION_ID, status: 'working', updatedAt: 6 })
    const again = JSON.parse(
      (
        (await pair.client.readResource({ uri: agentStatusUri(SESSION_ID) })).contents[0] as {
          text: string
        }
      ).text,
    )
    expect(again.reason).toBeUndefined()
  })

  it('sesión inexistente o URI con id raro: error de recurso', async () => {
    pair = await connectPair()
    await expect(pair.client.readResource({ uri: agentStatusUri('agent-nada') })).rejects.toThrow(
      /NOT_FOUND/,
    )
    await expect(pair.client.readResource({ uri: 'nexo://agents/../status' })).rejects.toThrow()
    await expect(pair.client.readResource({ uri: 'nexo://otra-cosa' })).rejects.toThrow()
  })

  it('nexo://limits y nexo://workspaces', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('limits.status', () => ({
      providers: [{ provider: 'codex', status: 'ok', windows: [{ id: 'p', usedPercent: 10 }] }],
    }))
    pair.fake.workspaces = [workspace()]
    const l = JSON.parse(
      ((await pair.client.readResource({ uri: URI.limits })).contents[0] as { text: string }).text,
    )
    expect(l.worstUsedPercent).toBe(10)
    const w = JSON.parse(
      ((await pair.client.readResource({ uri: URI.workspaces })).contents[0] as { text: string })
        .text,
    )
    expect(w.workspaces[0].id).toBe(WS_ID)
    const a = JSON.parse(
      ((await pair.client.readResource({ uri: URI.agents })).contents[0] as { text: string }).text,
    )
    expect(a.sessions).toEqual([])
  })
})

describe('suscripciones', () => {
  it('avisa de los cambios de los recursos suscritos con los eventos del daemon', async () => {
    pair = await connectPair()
    pair.fake.sessions = [session()]
    await pair.client.subscribeResource({ uri: URI.attention })
    await pair.client.subscribeResource({ uri: agentStatusUri(SESSION_ID) })
    await waitFor(() => pair?.link.connected === true)
    pair.fake.emit('agent.status', { sessionId: SESSION_ID, status: 'working', updatedAt: 1 })
    await waitFor(() => (pair?.updates.length ?? 0) >= 2)
    expect(pair.updates.sort()).toEqual([URI.attention, agentStatusUri(SESSION_ID)].sort())
    // lo que no se suscribió no avisa
    pair.updates.length = 0
    pair.fake.emit('limits.updated', { provider: 'codex', status: 'ok', windows: [] } as never)
    await new Promise((r) => setTimeout(r, 40))
    expect(pair.updates).toEqual([])
    await pair.client.unsubscribeResource({ uri: URI.attention })
    pair.fake.emit('pane.attention', { paneId: PANE_ID, attention: 'done' })
    await new Promise((r) => setTimeout(r, 40))
    expect(pair.updates).toEqual([])
  })

  it('avisa de que la lista de recursos cambió cuando aparece una sesión', async () => {
    pair = await connectPair()
    await callTool(pair, 'agents_list')
    pair.fake.emit('agent.session', { session: session({ id: 'agent-otra' }) })
    await waitFor(() => (pair?.listChanges.count ?? 0) > 0)
  })

  it('suscribirse sin daemon funciona y avisa cuando el daemon aparece', async () => {
    const fake = new FakeClient()
    let up = false
    pair = await connectPair({
      fake,
      connect: async () => {
        if (!up) throw new Error('caído')
        return fake
      },
    })
    await pair.client.subscribeResource({ uri: URI.limits })
    await new Promise((r) => setTimeout(r, 30))
    expect(pair.link.connected).toBe(false)
    expect(pair.updates).toEqual([])
    up = true
    // el reintento en segundo plano espera 1 s; también basta con la siguiente llamada
    await callTool(pair, 'agents_list')
    expect(pair.link.connected).toBe(true)
  })

  it('rechaza URIs inválidas y pasarse del tope de suscripciones', async () => {
    pair = await connectPair()
    await expect(pair.client.subscribeResource({ uri: 'no es una uri' })).rejects.toThrow()
    for (let i = 0; i < 64; i++)
      await pair.client.subscribeResource({ uri: `nexo://agents/a${i}/status` })
    await expect(
      pair.client.subscribeResource({ uri: 'nexo://agents/otra/status' }),
    ).rejects.toThrow(/suscripciones/)
  })
})
