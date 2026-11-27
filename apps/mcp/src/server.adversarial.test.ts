import { afterEach, describe, expect, it } from 'vitest'
import {
  block,
  callTool,
  clientError,
  connectPair,
  FakeClient,
  type Pair,
  SESSION_ID,
  session,
  TERM_ID,
  tick,
  waitFor,
  workspace,
} from './test-helpers.ts'
import { agentStatusUri, URI } from './views.ts'

let pair: Pair | undefined
afterEach(async () => {
  await pair?.close()
  pair = undefined
})

const WRITE_CALLS = [
  ['terminal_write', { terminalId: TERM_ID, data: 'rm -rf /\r' }],
  ['agent_create', { workspaceId: 'ws-aaaa1111', provider: 'claude' }],
  ['agent_send', { sessionId: SESSION_ID, text: 'borra todo' }],
  ['agent_interrupt', { sessionId: SESSION_ID }],
  ['agent_respond', { sessionId: SESSION_ID, index: 0, optionId: 'once' }],
] as const

describe('escribir sin permiso', () => {
  it.each(WRITE_CALLS)(
    '%s no existe sin NEXO_MCP_WRITE y no toca el daemon',
    async (name, args) => {
      pair = await connectPair()
      const r = await callTool(pair, name, { ...args })
      expect(r.error).toBe(true)
      expect(r.text).toMatch(/not found|no existe|Unknown tool|-32602/i)
      expect(pair.fake.calls).toHaveLength(0)
    },
  )

  it('agent_respond no existe con solo NEXO_MCP_WRITE', async () => {
    pair = await connectPair({ config: { write: true } })
    const r = await callTool(pair, 'agent_respond', {
      sessionId: SESSION_ID,
      index: 0,
      optionId: 'once',
    })
    expect(r.error).toBe(true)
    expect(pair.fake.calls).toHaveLength(0)
  })

  it('los permisos no pueden activarse sin la escritura (ni por herramientas ocultas)', async () => {
    pair = await connectPair({ config: { write: false, allowPermissions: true } })
    const { tools } = await pair.client.listTools()
    expect(tools.map((t) => t.name)).not.toContain('agent_respond')
    expect(tools.map((t) => t.name)).not.toContain('terminal_write')
  })

  it('no hay ninguna herramienta que lea archivos, abra terminales o cierre cosas', async () => {
    pair = await connectPair({ config: { write: true, allowPermissions: true } })
    const names = (await pair.client.listTools()).tools.map((t) => t.name)
    for (const forbidden of [
      'fs_read',
      'fs_stat',
      'terminal_spawn',
      'terminal_kill',
      'workspace_close',
      'daemon_shutdown',
      'pane_close',
    ]) {
      expect(names).not.toContain(forbidden)
    }
    for (const call of ['fs.read', 'terminal.spawn', 'daemon.shutdown']) {
      expect(pair.fake.callsTo(call)).toHaveLength(0)
    }
  })
})

describe('argumentos hostiles', () => {
  const HOSTILE: unknown[] = [
    '',
    ' ',
    '../../etc/passwd',
    'term-x/../../y',
    'x'.repeat(5000),
    '\u0000',
    '%2e%2e',
    '$' + '{jndi:ldap://x}',
    "'; DROP TABLE x;--",
    '__proto__',
    null,
    123,
    -1,
    1.5,
    true,
    [],
    {},
    { __proto__: { admin: true } },
    ['a'],
  ]

  const READS: [string, string][] = [
    ['terminal_read', 'terminalId'],
    ['agent_blocks', 'sessionId'],
    ['memory_recall', 'sessionId'],
  ]

  it.each(READS)('%s rechaza ids raros sin llamar al daemon', async (tool, field) => {
    pair = await connectPair({ config: { readPerMinute: 6000 } })
    for (const bad of HOSTILE) {
      if (typeof bad === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(bad)) continue
      const args: Record<string, unknown> = { [field]: bad, provider: 'claude', from: 0, to: 1 }
      const r = await callTool(pair, tool, args)
      expect(r.error, `${tool} ${JSON.stringify(bad)}`).toBe(true)
    }
    expect(pair.fake.calls).toHaveLength(0)
  })

  it('las herramientas de escritura rechazan ids y datos raros sin llamar al daemon', async () => {
    pair = await connectPair({
      config: { write: true, allowPermissions: true, writePerMinute: 600 },
    })
    for (const bad of HOSTILE) {
      for (const [tool, field] of [
        ['terminal_write', 'terminalId'],
        ['agent_send', 'sessionId'],
        ['agent_interrupt', 'sessionId'],
        ['agent_respond', 'sessionId'],
        ['agent_create', 'workspaceId'],
      ] as const) {
        if (typeof bad === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(bad)) continue
        const r = await callTool(pair, tool, {
          [field]: bad,
          data: 'x',
          text: 'x',
          index: 0,
          optionId: 'a',
          provider: 'claude',
        })
        expect(r.error, `${tool} ${JSON.stringify(bad)}`).toBe(true)
      }
    }
    expect(pair.fake.calls).toHaveLength(0)
  })

  it('tamaños enormes se rechazan antes de llegar al daemon', async () => {
    pair = await connectPair({ config: { write: true } })
    const huge = 'x'.repeat(5 * 1024 * 1024)
    expect(
      (await callTool(pair, 'terminal_write', { terminalId: TERM_ID, data: huge })).error,
    ).toBe(true)
    expect((await callTool(pair, 'agent_send', { sessionId: SESSION_ID, text: huge })).error).toBe(
      true,
    )
    expect((await callTool(pair, 'memory_search', { cwd: '/x', query: huge })).error).toBe(true)
    expect((await callTool(pair, 'memory_search', { cwd: huge, query: 'x' })).error).toBe(true)
    expect((await callTool(pair, 'history_list', { cursor: huge })).error).toBe(true)
    expect(
      (await callTool(pair, 'agent_blocks', { sessionId: SESSION_ID, limit: 10_000_000 })).error,
    ).toBe(true)
    expect(
      (await callTool(pair, 'terminal_read', { terminalId: TERM_ID, maxBytes: 2 ** 40 })).error,
    ).toBe(true)
    expect((await callTool(pair, 'terminal_read', { terminalId: TERM_ID, lines: 0 })).error).toBe(
      true,
    )
    expect(pair.fake.calls).toHaveLength(0)
  })

  it('modos de permiso peligrosos no se ofrecen', async () => {
    pair = await connectPair({ config: { write: true } })
    pair.fake.workspaces = [workspace()]
    for (const mode of ['bypass', 'BYPASS', 'dangerously-skip', '', null]) {
      const r = await callTool(pair, 'agent_create', {
        workspaceId: 'ws-aaaa1111',
        provider: 'claude',
        permissionMode: mode,
      })
      expect(r.error).toBe(true)
    }
    expect(pair.fake.callsTo('agent.create')).toHaveLength(0)
  })

  it('un texto con caracteres de control se envía tal cual pero no se refleja sin limpiar', async () => {
    pair = await connectPair({ config: { write: true } })
    pair.fake.handlers.set('agent.send', () => ({ blockId: 'blk-1', index: 1, turn: 1 }))
    const r = await callTool(pair, 'agent_send', {
      sessionId: SESSION_ID,
      text: '\x1b[2Jhola\x1b]0;x\x07',
    })
    expect(r.error).toBe(false)
    expect(r.text).not.toContain('\x1b')
  })
})

describe('daemon hostil o caído', () => {
  it('salida de terminal con bombas de escape y megabytes de basura queda acotada y limpia', async () => {
    pair = await connectPair({ config: { maxOutputBytes: 4096 } })
    const bomb = `${'\x1b['.repeat(100_000)}texto${'\x1b]0;'.repeat(5000)}${'\u202e'.repeat(1000)}fin${'\r'.repeat(10_000)}`
    pair.fake.handlers.set('terminal.read', () => ({ data: bomb, offset: 1 }))
    const r = await callTool(pair, 'terminal_read', { terminalId: TERM_ID, maxBytes: 65536 })
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(4096)
    expect(r.text).not.toContain('\x1b')
    expect(r.text).not.toContain('\u202e')
  })

  it('bloques con texto hostil salen limpios y acotados', async () => {
    pair = await connectPair({ config: { maxOutputBytes: 16 * 1024 } })
    pair.fake.handlers.set('agent.snapshot', () => ({
      session: session({ blockCount: 1 }),
      blocks: [
        block(0, {
          type: 'text',
          text: `\x1b[31m${'A'.repeat(200_000)}\u202e\x00`,
          complete: true,
        }),
        block(1, { type: 'error', code: 'X\ny', message: 'fallo\x1b[0m', fatal: false }),
      ],
      nextIndex: null,
    }))
    const r = await callTool(pair, 'agent_blocks', {
      sessionId: SESSION_ID,
      fromIndex: 0,
      limit: 2,
    })
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(16 * 1024)
    expect(r.text).not.toContain('\x1b')
    expect(r.text).not.toContain('\u202e')
    expect(r.text).toContain('[recortado]')
    expect(r.text).toContain('X y: fallo')
  })

  it('un mensaje de error del daemon con el token no llega al modelo ni a los logs', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('workspace.list', () => {
      throw clientError('INTERNAL', 'fallo con nexo.token.SUPERSECRETO123456 y Bearer xyz.abc')
    })
    const r = await callTool(pair, 'workspaces_list')
    expect(r.text).not.toContain('SUPERSECRETO')
    expect(r.text).not.toContain('xyz.abc')
    expect(pair.logs.join('\n')).not.toContain('SUPERSECRETO')
  })

  it('una excepción inesperada no filtra su mensaje', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('agent.list', () => {
      throw new Error('C:/Users/secreto/.claude/credentials.json')
    })
    const r = await callTool(pair, 'agents_list')
    expect(r.error).toBe(true)
    expect(r.text).not.toContain('credentials')
  })

  it('con el daemon caído todas las lecturas fallan igual de claro y se recupera solo', async () => {
    let up = false
    const fake = new FakeClient()
    pair = await connectPair({
      fake,
      connect: async () => {
        if (!up) throw new Error('ECONNREFUSED 127.0.0.1:4317')
        return fake
      },
    })
    for (const [tool, args] of [
      ['workspaces_list', {}],
      ['agents_list', {}],
      ['agent_providers', {}],
      ['limits_status', {}],
      ['terminal_read', { terminalId: TERM_ID }],
      ['history_list', {}],
    ] as const) {
      const r = await callTool(pair, tool, { ...args })
      expect(r.error, tool).toBe(true)
      expect(r.text, tool).toContain('DAEMON_UNAVAILABLE')
    }
    up = true
    expect((await callTool(pair, 'agents_list')).error).toBe(false)
  })

  it('respuestas del daemon con forma inesperada no rompen el servidor', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('agent.list', () => null)
    expect((await callTool(pair, 'agents_list')).error).toBe(true)
    pair.fake.handlers.set('agent.list', () => ({ sessions: [] }))
    expect((await callTool(pair, 'agents_list')).error).toBe(false)
  })

  it('la caída del cliente en medio de una llamada se informa', async () => {
    pair = await connectPair()
    pair.fake.handlers.set('workspace.list', () => {
      throw clientError('DISCONNECTED', 'sin conexión con el daemon')
    })
    const r = await callTool(pair, 'workspaces_list')
    expect(r.text).toMatch(/DISCONNECTED/)
    expect(r.text).toMatch(/reintenta/)
  })
})

describe('carreras y avalanchas', () => {
  it('100 lecturas concurrentes responden bien con una sola conexión', async () => {
    let connects = 0
    const fake = new FakeClient()
    pair = await connectPair({
      fake,
      config: { readPerMinute: 6000 },
      connect: async () => {
        connects++
        return fake
      },
    })
    const results = await Promise.all(
      Array.from({ length: 100 }, () => callTool(pair as Pair, 'agents_list')),
    )
    expect(results.every((r) => !r.error)).toBe(true)
    expect(connects).toBe(1)
  })

  it('una avalancha de eventos produce pocos avisos y el servidor sigue respondiendo', async () => {
    pair = await connectPair({ flushMs: 20 })
    pair.fake.sessions = [session()]
    await pair.client.subscribeResource({ uri: URI.attention })
    await pair.client.subscribeResource({ uri: agentStatusUri(SESSION_ID) })
    await waitFor(() => pair?.link.connected === true)
    for (let i = 0; i < 20_000; i++) {
      pair.fake.emit('agent.status', {
        sessionId: SESSION_ID,
        status: i % 2 === 0 ? 'working' : 'done',
        updatedAt: i,
      })
      pair.fake.emit('pane.attention', { paneId: 'pane-x', attention: 'working' })
      pair.fake.emit('agent.session', { session: session({ id: `agent-${i % 50}` }) })
    }
    await tick(120)
    expect(pair.updates.length).toBeLessThanOrEqual(6)
    expect(pair.listChanges.count).toBeLessThanOrEqual(3)
    expect((await callTool(pair, 'agents_list')).error).toBe(false)
  })

  it('eventos con datos raros no tumban al oyente', async () => {
    pair = await connectPair()
    await pair.client.subscribeResource({ uri: URI.attention })
    await waitFor(() => pair?.link.connected === true)
    pair.fake.emit('agent.status', null)
    pair.fake.emit('agent.session', {})
    pair.fake.emit('layout.changed', undefined)
    pair.fake.emitResync()
    await tick(30)
    expect((await callTool(pair, 'agents_list')).error).toBe(false)
  })

  it('suscripciones a URIs hostiles se rechazan o no hacen nada', async () => {
    pair = await connectPair()
    for (const uri of [
      '',
      'javascript:alert(1)',
      `nexo://${'a'.repeat(100_000)}`,
      'nexo://agents/%00/status',
    ]) {
      try {
        await pair.client.subscribeResource({ uri })
      } catch {
        // rechazada: bien
      }
    }
    await tick(20)
    expect((await callTool(pair, 'agents_list')).error).toBe(false)
  })

  it('llamar a una herramienta inexistente es un error y no deja el servidor mal', async () => {
    pair = await connectPair()
    for (const name of ['', '__proto__', 'constructor', 'x'.repeat(5000), 'fs.read']) {
      expect((await callTool(pair, name)).error).toBe(true)
    }
    expect((await callTool(pair, 'agents_list')).error).toBe(false)
  })
})
