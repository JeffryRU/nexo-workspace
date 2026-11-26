import { describe, expect, it } from 'vitest'
import { memoryApi } from './memory-api.ts'

describe('memoryApi', () => {
  it('cada método llama a su memory.* con los mismos parámetros', async () => {
    const calls: { method: string; params: unknown }[] = []
    const api = memoryApi({
      call: (async (method: string, params: unknown) => {
        calls.push({ method, params })
        return {}
      }) as never,
    })
    await api.status()
    await api.status({ cwd: '/x' })
    await api.list({ cwd: '/x', limit: 5 })
    await api.search({ cwd: '/x', query: 'pnpm' })
    await api.recall({ sessionId: 's1' as never, range: { from: 0, to: 2 } })
    expect(calls).toEqual([
      { method: 'memory.status', params: {} },
      { method: 'memory.status', params: { cwd: '/x' } },
      { method: 'memory.list', params: { cwd: '/x', limit: 5 } },
      { method: 'memory.search', params: { cwd: '/x', query: 'pnpm' } },
      { method: 'memory.recall', params: { sessionId: 's1', range: { from: 0, to: 2 } } },
    ])
  })
})
