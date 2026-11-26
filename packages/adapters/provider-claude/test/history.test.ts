import { randomUUID } from 'node:crypto'
import { BlockDraft } from '@nexo/contracts'
import { HistoryError } from '@nexo/core'
import { type HistoryRig, runHistoryConformance } from '@nexo/testkit/conformance'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ClaudeHistory } from '../src/history.ts'
import { createClaudeProvider } from '../src/provider.ts'
import type { ClaudeTransport } from '../src/transport.ts'
import { text, toolResult, toolUse } from './helpers.ts'

type StoredSession = { info: Record<string, unknown>; messages: unknown[] }

/** Transporte de prueba que solo sabe de historial: imita `listSessions` y `getSessionMessages` del SDK. */
class HistoryTransport implements ClaudeTransport {
  readonly sessions = new Map<string, StoredSession>()
  listCalls: { cwd?: string; limit: number }[] = []
  failWith: Error | undefined
  rawList: unknown[] | undefined

  async isAvailable(): Promise<boolean> {
    return true
  }
  async start(): Promise<never> {
    throw new Error('no se abre ninguna sesión en estas pruebas')
  }
  async listSessions(o: { cwd?: string; limit: number }): Promise<unknown[]> {
    this.listCalls.push(o)
    if (this.failWith !== undefined) throw this.failWith
    if (this.rawList !== undefined) return this.rawList
    return [...this.sessions.values()]
      .map((s) => s.info)
      .filter((i) => o.cwd === undefined || i.cwd === o.cwd)
      .sort((a, b) => Number(b.lastModified) - Number(a.lastModified))
      .slice(0, o.limit)
  }
  async readSession(o: { sessionId: string; cwd?: string; maxMessages: number }) {
    if (this.failWith !== undefined) throw this.failWith
    const s = this.sessions.get(o.sessionId)
    if (s === undefined) return { exists: false, messages: [] }
    return { exists: true, messages: s.messages.slice(0, o.maxMessages) }
  }
  add(session: {
    cwd?: string
    summary?: string
    lastModified: number
    messages: unknown[]
    id?: string
  }): string {
    const id = session.id ?? randomUUID()
    this.sessions.set(id, {
      info: {
        sessionId: id,
        summary: session.summary ?? 'resumen',
        lastModified: session.lastModified,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      },
      messages: session.messages,
    })
    return id
  }
}

const userMsg = (content: unknown) => ({
  type: 'user',
  uuid: randomUUID(),
  session_id: 's',
  parent_tool_use_id: null,
  message: { role: 'user', content },
})

runHistoryConformance('provider-claude (SDK falso)', (): HistoryRig => {
  const transport = new HistoryTransport()
  const provider = createClaudeProvider({ transport, env: {} })
  const history = provider.history
  if (history === undefined) throw new Error('Claude debe exponer historial')
  return {
    history,
    unknownId: randomUUID(),
    seed: async (s) =>
      transport.add({
        cwd: s.cwd,
        summary: s.title,
        lastModified: s.updatedAt,
        messages: s.messages.map((m, i) =>
          m.role === 'user' ? userMsg(m.text) : text(`m${i}`, m.text),
        ),
      }),
  }
})

describe('ClaudeHistory', () => {
  const make = () => {
    const transport = new HistoryTransport()
    return { transport, history: new ClaudeHistory({ transport }) }
  }

  it('lista con título, carpeta y fechas; el título personalizado manda sobre el resumen', async () => {
    const { transport, history } = make()
    const id = randomUUID()
    transport.rawList = [
      {
        sessionId: id,
        summary: 'resumen',
        customTitle: 'Mi título',
        cwd: '/work/app',
        lastModified: 2000,
        createdAt: 1000,
        extra: 'ignorado',
      },
    ]
    const [s] = await history.list({ limit: 10 })
    expect(s).toMatchObject({
      sessionId: id,
      title: 'Mi título',
      cwd: '/work/app',
      createdAt: 1000,
      updatedAt: 2000,
      resumable: true,
    })
  })

  it('pasa cwd y límite al SDK y no pide worktrees ajenos', async () => {
    const { transport, history } = make()
    await history.list({ limit: 7, cwd: '/work/app' })
    expect(transport.listCalls).toEqual([{ cwd: '/work/app', limit: 7 }])
  })

  it('traduce herramientas, razonamiento y resultados a bloques de acción', async () => {
    const { transport, history } = make()
    const id = transport.add({
      lastModified: 5,
      messages: [
        userMsg('lista los archivos'),
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: 'a1',
            content: [
              { type: 'thinking', thinking: 'pensando' },
              { type: 'text', text: 'voy' },
            ],
          },
        },
        toolUse('t1', 'Bash', { command: 'ls' }),
        toolResult('t1', 'a.txt\nb.txt'),
        text('a2', 'hecho'),
        userMsg([{ type: 'text', text: 'gracias' }]),
      ],
    })
    const t = await history.read({ sessionId: id, maxBlocks: 100 })
    expect(t.blocks.map((b) => b.block.type)).toEqual([
      'user',
      'reasoning',
      'text',
      'action',
      'text',
      'user',
    ])
    const action = t.blocks[3]?.block
    expect(action).toMatchObject({ type: 'action', kind: 'exec', status: 'ok', tool: 'Bash' })
    expect(t.blocks.map((b) => b.turn)).toEqual([1, 1, 1, 1, 1, 2])
    for (const b of t.blocks) expect(BlockDraft.safeParse(b.block).success).toBe(true)
  })

  it('una herramienta sin resultado queda como error en vez de «en curso»', async () => {
    const { transport, history } = make()
    const id = transport.add({
      lastModified: 5,
      messages: [userMsg('haz algo'), toolUse('t9', 'Bash', { command: 'sleep 9' })],
    })
    const t = await history.read({ sessionId: id, maxBlocks: 10 })
    expect(t.blocks[1]?.block).toMatchObject({ type: 'action', status: 'error' })
  })

  it('los mensajes de subagentes no se muestran como mensajes del usuario', async () => {
    const { transport, history } = make()
    const id = transport.add({
      lastModified: 5,
      messages: [
        userMsg('hola'),
        { ...userMsg('instrucción del subagente'), parent_tool_use_id: 'toolu_1' },
        text('a', 'ok'),
      ],
    })
    const t = await history.read({ sessionId: id, maxBlocks: 10 })
    expect(t.blocks.filter((b) => b.block.type === 'user')).toHaveLength(1)
  })

  it('con maxBlocks recorta y marca truncated', async () => {
    const { transport, history } = make()
    const id = transport.add({
      lastModified: 5,
      messages: Array.from({ length: 20 }, (_, i) => userMsg(`m${i}`)),
    })
    const t = await history.read({ sessionId: id, maxBlocks: 5 })
    expect(t.blocks).toHaveLength(5)
    expect(t.truncated).toBe(true)
  })

  it('un transporte sin historial rechaza con UNSUPPORTED', async () => {
    const bare: ClaudeTransport = {
      isAvailable: async () => true,
      start: async () => {
        throw new Error('no')
      },
    }
    const history = new ClaudeHistory({ transport: bare })
    await expect(history.list({ limit: 1 })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(history.read({ sessionId: randomUUID(), maxBlocks: 1 })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
  })

  it('los fallos del SDK salen como UNAVAILABLE sin su mensaje', async () => {
    const { transport, history } = make()
    transport.failWith = new Error('ENOENT C:\\Users\\yo\\.claude\\projects\\x.jsonl')
    const e = await history.list({ limit: 1 }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(HistoryError)
    expect((e as HistoryError).code).toBe('UNAVAILABLE')
    expect((e as HistoryError).message).not.toContain('projects')
  })
})

describe('ClaudeHistory (propiedades)', () => {
  const arbMessage = fc.oneof(
    fc.constant(null),
    fc.string(),
    fc.record({
      type: fc.constantFrom('user', 'assistant', 'system', 'x'),
      message: fc.anything(),
    }),
    fc.record({
      type: fc.constant('user'),
      parent_tool_use_id: fc.constantFrom(null, 'toolu_1'),
      message: fc.record({ content: fc.oneof(fc.string(), fc.array(fc.anything())) }),
    }),
    fc.record({
      type: fc.constant('assistant'),
      parent_tool_use_id: fc.constantFrom(null, 'toolu_1'),
      message: fc.record({ id: fc.string(), content: fc.array(fc.anything(), { maxLength: 4 }) }),
    }),
  )

  it('nunca lanza, acota los bloques y todos son válidos, sea cual sea la transcripción', async () => {
    const { transport, history } = {
      transport: new HistoryTransport(),
      get history() {
        return new ClaudeHistory({ transport: this.transport })
      },
    }
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbMessage, { maxLength: 30 }),
        fc.integer({ min: 0, max: 12 }),
        async (messages, max) => {
          const id = transport.add({ lastModified: 1, messages })
          const t = await history.read({ sessionId: id, maxBlocks: max })
          expect(t.blocks.length).toBeLessThanOrEqual(max)
          for (const b of t.blocks) expect(BlockDraft.safeParse(b.block).success).toBe(true)
        },
      ),
      { numRuns: 150 },
    )
  })

  it('una lista con basura solo conserva las sesiones válidas', async () => {
    const transport = new HistoryTransport()
    const history = new ClaudeHistory({ transport })
    await fc.assert(
      fc.asyncProperty(fc.array(fc.anything(), { maxLength: 20 }), async (raw) => {
        transport.rawList = raw
        const out = await history.list({ limit: 50 })
        for (const s of out) {
          expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
          expect(Number.isSafeInteger(s.updatedAt)).toBe(true)
        }
      }),
      { numRuns: 100 },
    )
  })
})
