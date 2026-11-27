import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { ReasonTracker } from './resources.ts'
import {
  block,
  callTool,
  connectPair,
  type Pair,
  PANE_ID,
  session,
  SESSION_ID,
  TAB_ID,
  TERM_ID,
  WS_ID,
  workspace,
} from './test-helpers.ts'
import { agentStatusUri, URI } from './views.ts'
import type { LinkEvent } from './link.ts'

let pair: Pair | undefined
afterEach(async () => {
  await pair?.close()
  pair = undefined
})

describe('ReasonTracker', () => {
  const status = (id: string, st: string, reason?: string) =>
    ({
      name: 'agent.status',
      data: { sessionId: id, status: st, updatedAt: 1, ...(reason === undefined ? {} : { reason }) },
    }) as LinkEvent

  it('guarda el motivo de error o needs-input y lo borra al cambiar', () => {
    const t = new ReasonTracker()
    t.handle(status('a', 'error', 'falló\x07'))
    expect(t.get('a')).toBe('falló')
    t.handle(status('a', 'working'))
    expect(t.get('a')).toBeUndefined()
    t.handle(status('b', 'needs-input', 'espera'))
    t.handle(status('b', 'error'))
    expect(t.get('b')).toBeUndefined()
    t.handle(status('c', 'done', 'ignorado'))
    expect(t.get('c')).toBeUndefined()
  })

  it('se acota, olvida sesiones cerradas y se vacía con un resync', () => {
    const t = new ReasonTracker()
    for (let i = 0; i < 300; i++) t.handle(status(`s${i}`, 'error', 'x'))
    expect(t.get('s0')).toBeUndefined()
    expect(t.get('s299')).toBe('x')
    t.handle(status('s299', 'error', 'otra'))
    expect(t.get('s299')).toBe('otra')
    t.handle({ name: 'agent.session', data: { sessionId: 's299', removed: true } } as LinkEvent)
    expect(t.get('s299')).toBeUndefined()
    t.handle({ name: 'agent.session', data: { session: session() } } as LinkEvent)
    t.handle({ name: 'limits.updated', data: {} } as LinkEvent)
    t.handle({ name: 'resync' })
    expect(t.get('s298')).toBeUndefined()
  })
})

describe('recursos (casos límite)', () => {
  it('una URI de sesión con un id inválido es un error de parámetros', async () => {
    pair = await connectPair()
    await expect(pair.client.readResource({ uri: 'nexo://agents/a%20b/status' })).rejects.toBeInstanceOf(
      McpError,
    )
  })

  it('las lecturas de recursos también tienen tope de frecuencia', async () => {
    pair = await connectPair({ config: { readPerMinute: 1 } })
    pair.fake.handlers.set('limits.status', () => ({ providers: [] }))
    await pair.client.readResource({ uri: URI.limits })
    await expect(pair.client.readResource({ uri: URI.limits })).rejects.toThrow(/RATE_LIMITED/)
  })

  it('con el daemon caído leer un recurso falla con un error de recurso claro', async () => {
    pair = await connectPair({
      connect: async () => {
        throw new Error('caído')
      },
    })
    await expect(pair.client.readResource({ uri: URI.agents })).rejects.toThrow(/DAEMON_UNAVAILABLE/)
  })

  it('el estado de una sesión sin motivo no trae reason', async () => {
    pair = await connectPair()
    pair.fake.sessions = [session({ title: 'mi sesión' })]
    const r = await pair.client.readResource({ uri: agentStatusUri(SESSION_ID) })
    const body = JSON.parse((r.contents[0] as { text: string }).text)
    expect(body.title).toBe('mi sesión')
    expect(body.reason).toBeUndefined()
  })
})

describe('herramientas con todos sus argumentos opcionales', () => {
  it('history_list y history_read pasan provider, cwd, cursor y límite y describen lo raro', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('history.list', () => ({
      projects: [
        {
          cwd: null,
          name: 'sin carpeta',
          sessions: [
            { provider: 'codex', sessionId: 's1', updatedAt: 1, resumable: false, readable: false },
            {
              provider: 'codex',
              sessionId: 's2',
              title: 't',
              messageCount: 4,
              updatedAt: 2,
              resumable: true,
              readable: true,
            },
          ],
        },
      ],
      nextCursor: null,
      providers: [{ provider: 'ollama', status: 'unsupported', reason: 'sin historial' }],
    }))
    const l = await callTool(pair, 'history_list', {
      provider: 'codex',
      cwd: '/work',
      cursor: 'abc_-9',
      limit: 5,
    })
    expect(l.text).toContain('(sin carpeta)')
    expect(l.text).toContain('(no legible)')
    expect(l.text).not.toContain('Hay más')
    expect(pair.fake.callsTo('history.list')[0]).toEqual({
      provider: 'codex',
      cwd: '/work',
      cursor: 'abc_-9',
      limit: 5,
    })
    pair.fake.handlers.set('history.read', () => ({
      provider: 'codex',
      sessionId: 's2',
      blocks: [],
      nextCursor: 'sig',
      total: 0,
      truncated: true,
    }))
    const r = await callTool(pair, 'history_read', {
      provider: 'codex',
      sessionId: 's2',
      cwd: '/work',
      cursor: 'abc',
      limit: 3,
      includeActionOutput: true,
    })
    expect(r.text).toContain('(sin bloques)')
    expect(r.text).toContain('transcripción recortada')
    expect(r.text).toContain('cursor=sig')
    expect(pair.fake.callsTo('history.read')[0]).toEqual({
      provider: 'codex',
      sessionId: 's2',
      cwd: '/work',
      cursor: 'abc',
      limit: 3,
    })
  })

  it('limits_status filtra por proveedor; sin proveedores lo dice', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('limits.status', () => ({ providers: [] }))
    const r = await callTool(pair, 'limits_status', { provider: 'codex' })
    expect(r.text).toBe('Sin proveedores.')
    expect(pair.fake.callsTo('limits.status')[0]).toEqual({ provider: 'codex' })
    pair.fake.handlers.set('limits.status', () => ({
      providers: [{ provider: 'codex', status: 'unknown', windows: [], reached: true }],
    }))
    expect((await callTool(pair, 'limits_status')).text).toBe('codex: unknown (límite alcanzado)')
  })

  it('memory_recall con includeActionOutput y un recorte del daemon', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('memory.recall', () => ({
      blocks: [
        block(1, { type: 'action', kind: 'exec', status: 'ok', tool: 'Bash', title: 'x', output: 'hola' }),
      ],
      truncated: true,
    }))
    const r = await callTool(pair, 'memory_recall', {
      sessionId: SESSION_ID,
      from: 1,
      to: 1,
      includeActionOutput: true,
    })
    expect(r.text).toContain('salida:\nhola')
    expect(r.text).toContain('menos bloques')
    pair.fake.handlers.set('memory.recall', () => ({ blocks: [], truncated: false }))
    expect((await callTool(pair, 'memory_recall', { sessionId: SESSION_ID, from: 1, to: 1 })).text).toBe(
      '(sin bloques)',
    )
  })

  it('agent_blocks avisa de que hay más y de los rangos vacíos', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('agent.snapshot', () => ({
      session: session({ blockCount: 100 }),
      blocks: [],
      nextIndex: 60,
    }))
    const r = await callTool(pair, 'agent_blocks', { sessionId: SESSION_ID, fromIndex: 50, limit: 10 })
    expect(r.text).toContain('(sin bloques en ese rango)')
    expect(r.text).toContain('fromIndex=60')
  })

  it('agent_providers sin motivo, con modelo por omisión y no disponible sin razón', async () => {
    pair = await connectPair()
    const caps = { permissionModes: ['ask'], models: [], efforts: [], resume: false, warmup: false, streaming: true }
    pair.fake.handlers.set('agent.providers', () => ({
      providers: [
        { id: 'a', name: 'A', available: true, capabilities: { ...caps, defaultModel: 'm1' } },
        { id: 'b', name: 'B', available: false, capabilities: caps },
      ],
    }))
    const r = await callTool(pair, 'agent_providers')
    expect(r.text).toContain('a (A): disponible')
    expect(r.text).toContain('b (B): no disponible')
    expect(r.structured).toMatchObject({ providers: [{ defaultModel: 'm1' }, { available: false }] })
  })

  it('terminal_read marca truncated si lo dice el daemon aunque el texto quepa', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('terminal.read', () => ({ data: 'hola\n', offset: 5, truncated: true }))
    const r = await callTool(pair, 'terminal_read', { terminalId: TERM_ID })
    expect(r.structured).toMatchObject({ truncated: true })
  })

  it('workspaces_list muestra paneles de agente y de visor sin terminal', async () => {
    pair = await connectPair()
    const ws = workspace()
    const p = ws.tabs[0]?.panes[0]
    if (p === undefined) throw new Error('sin panel')
    delete (p as { terminalId?: string }).terminalId
    p.kind = 'agent'
    p.agentSessionId = SESSION_ID as never
    pair.fake.workspaces = [ws]
    const r = await callTool(pair, 'workspaces_list')
    expect(r.text).toContain(`sesión=${SESSION_ID}`)
    expect(r.text).not.toContain('terminal=')
  })

  it('nexo_status anuncia los permisos con los topes configurados', async () => {
    pair = await connectPair({
      config: { write: true, allowPermissions: true, maxWriteBytes: 100, writePerMinute: 7 },
    })
    pair.fake.handlers.set('daemon.info', () => ({ version: '9', protocol: 1, pid: 1, startedAt: 'x' }))
    const r = await callTool(pair, 'nexo_status')
    expect(r.text).toContain('permitida')
    expect(r.structured).toMatchObject({
      write: { enabled: true, allowPermissions: true, maxWriteBytes: 100, writePerMinute: 7 },
    })
    expect((r.structured as { tools: string[] }).tools).toContain('agent_respond')
  })
})

describe('escritura (casos límite)', () => {
  const create = async (p: Pair, args: Record<string, unknown>) => {
    p.fake.workspaces = [workspace()]
    p.fake.handlers.set('tab.create', () => ({ tab: workspace().tabs[0] }))
    p.fake.handlers.set('pane.split', () => ({ pane: { id: 'pane-nuevo' }, layout: {} }))
    p.fake.handlers.set('agent.create', () => ({ session: session({ id: 'agent-n' }) }))
    return callTool(p, 'agent_create', { workspaceId: WS_ID, provider: 'fake', ...args })
  }

  it('agent_create pasa modelo y esfuerzo y descarta un título en blanco', async () => {
    pair = await connectPair({ config: { write: true } })
    const r = await create(pair, { model: 'fake-1', effort: 'low', title: '   ' })
    expect(r.error).toBe(false)
    expect(pair.fake.callsTo('agent.create')[0]).toMatchObject({ model: 'fake-1', effort: 'low' })
    expect(pair.fake.callsTo('tab.create')[0]).toEqual({ workspaceId: WS_ID, cwd: '/work/proyecto' })
  })

  it('agent_create: una pestaña sin paneles y un cierre que falla no tapan el error', async () => {
    pair = await connectPair({ config: { write: true } })
    pair.fake.workspaces = [workspace()]
    pair.fake.handlers.set('tab.create', () => ({
      tab: { ...workspace().tabs[0], id: TAB_ID, panes: [] },
    }))
    pair.fake.handlers.set('tab.close', () => {
      throw new Error('no se pudo cerrar')
    })
    const r = await callTool(pair, 'agent_create', { workspaceId: WS_ID, provider: 'fake' })
    expect(r.error).toBe(true)
    expect(r.text).toMatch(/sin paneles/)
    expect(pair.fake.callsTo('tab.close')).toHaveLength(1)
  })

  it('agent_respond con un índice que no coincide con el bloque devuelto', async () => {
    pair = await connectPair({ config: { write: true, allowPermissions: true } })
    pair.fake.handlers.set('agent.snapshot', () => ({
      session: session(),
      blocks: [
        block(7, {
          type: 'permission',
          tool: 'Bash',
          title: 't',
          state: 'pending',
          options: [{ id: 'a', label: 'a', kind: 'allow-once' }],
        }),
      ],
      nextIndex: null,
    }))
    const r = await callTool(pair, 'agent_respond', { sessionId: SESSION_ID, index: 3, optionId: 'a' })
    expect(r.text).toMatch(/NOT_FOUND/)
    expect(pair.fake.callsTo('agent.respond')).toHaveLength(0)
  })

  it('terminal_write devuelve los bytes escritos y agent_interrupt confirma', async () => {
    pair = await connectPair({ config: { write: true } })
    const w = await callTool(pair, 'terminal_write', { terminalId: TERM_ID, data: 'ñ\r' })
    expect(w.structured).toMatchObject({ bytes: 3 })
    expect((await callTool(pair, 'agent_interrupt', { sessionId: SESSION_ID })).text).toContain(
      'interrumpido',
    )
    expect(PANE_ID).toBeDefined()
  })
})
