import { describe, expect, it } from 'vitest'
import { agentApi } from './agent-api.ts'

describe('agentApi.renew', () => {
  it('llama a agent.renew con la sesión y deja pasar el plazo', async () => {
    const calls: { method: string; params: unknown; options: unknown }[] = []
    const api = agentApi({
      call: (async (method: string, params: unknown, options: unknown) => {
        calls.push({ method, params, options })
        return {}
      }) as never,
    })
    await api.renew({ sessionId: 's1' as never }, { timeoutMs: 5 })
    expect(calls).toEqual([
      { method: 'agent.renew', params: { sessionId: 's1' }, options: { timeoutMs: 5 } },
    ])
  })
})
