import { describe, expect, it } from 'vitest'
import { historyApi } from './history-api.ts'

const session = (id: string, cwd: string | undefined) => ({
  provider: 'claude',
  sessionId: id,
  ...(cwd === undefined ? {} : { cwd }),
  updatedAt: 1,
  resumable: true,
  readable: true,
})

function fake(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const api = historyApi({
    call: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return handler(method, params)
    }) as never,
  })
  return { api, calls }
}

describe('historyApi', () => {
  it('list y read son envoltorios de history.list y history.read', async () => {
    const { api, calls } = fake(() => ({ projects: [], nextCursor: null, providers: [] }))
    await api.list()
    await api.list({ provider: 'codex', cwd: '/w' })
    await api.read({ provider: 'codex', sessionId: 'abc' })
    expect(calls.map((c) => c.method)).toEqual(['history.list', 'history.list', 'history.read'])
    expect(calls[0]?.params).toEqual({})
  })

  it('listAll sigue los cursores y junta una carpeta partida entre páginas', async () => {
    const pages = [
      {
        projects: [{ cwd: '/w/a', name: 'a', sessions: [session('1', '/w/a')] }],
        nextCursor: 'c1',
        providers: [],
      },
      {
        projects: [
          { cwd: '/w/a', name: 'a', sessions: [session('2', '/w/a')] },
          { cwd: null, name: '(sin carpeta)', sessions: [session('3', undefined)] },
        ],
        nextCursor: null,
        providers: [{ provider: 'claude', status: 'ok' }],
      },
    ]
    const { api, calls } = fake(() => pages.shift())
    const all = await api.listAll()
    expect(all.projects).toHaveLength(2)
    expect(all.projects[0]?.sessions.map((s) => s.sessionId)).toEqual(['1', '2'])
    expect(calls[1]?.params).toEqual({ cursor: 'c1' })
    expect(all.providers).toHaveLength(1)
  })

  it('listAll se para al llegar a maxSessions', async () => {
    const { api, calls } = fake(() => ({
      projects: [{ cwd: '/w', name: 'w', sessions: [session('1', '/w'), session('2', '/w')] }],
      nextCursor: 'siguiente',
      providers: [],
    }))
    await api.listAll({}, { maxSessions: 2 })
    expect(calls).toHaveLength(1)
  })

  it('readAll junta las páginas y marca partial al cortar en maxBlocks', async () => {
    const block = (i: number) => ({ index: i, turn: 1, block: { type: 'user', text: `m${i}` } })
    let page = 0
    const { api } = fake((_m, p) => {
      page++
      return {
        provider: 'claude',
        sessionId: 'abc',
        blocks: [block(page * 2 - 2), block(page * 2 - 1)],
        nextCursor: page < 3 ? `o${page * 2}` : null,
        total: 6,
        truncated: false,
        ...(p.cursor === undefined ? {} : {}),
      }
    })
    const full = await api.readAll({ provider: 'claude', sessionId: 'abc' })
    expect(full.blocks).toHaveLength(6)
    expect(full.partial).toBe(false)
    page = 0
    const cut = await api.readAll({ provider: 'claude', sessionId: 'abc' }, { maxBlocks: 3 })
    expect(cut.blocks).toHaveLength(3)
    expect(cut.partial).toBe(true)
  })
})
