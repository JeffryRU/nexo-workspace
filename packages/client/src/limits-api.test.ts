import { describe, expect, it } from 'vitest'
import { limitsApi } from './limits-api.ts'

function fake() {
  const calls: { method: string; params: unknown }[] = []
  const handlers: ((d: unknown) => void)[] = []
  const api = limitsApi({
    call: (async (method: string, params: unknown) => {
      calls.push({ method, params })
      return { providers: [] }
    }) as never,
    on: ((event: string, handler: (d: unknown) => void) => {
      expect(event).toBe('limits.updated')
      handlers.push(handler)
      return () => handlers.splice(handlers.indexOf(handler), 1)
    }) as never,
  })
  return { api, calls, handlers }
}

describe('limitsApi', () => {
  it('status y refresh son envoltorios de limits.status', async () => {
    const { api, calls } = fake()
    await api.status()
    await api.status({ provider: 'codex' })
    await api.refresh({ provider: 'codex' })
    expect(calls).toEqual([
      { method: 'limits.status', params: {} },
      { method: 'limits.status', params: { provider: 'codex' } },
      { method: 'limits.status', params: { provider: 'codex', refresh: true } },
    ])
  })

  it('onUpdated se suscribe a limits.updated y devuelve la baja', () => {
    const { api, handlers } = fake()
    const got: unknown[] = []
    const off = api.onUpdated((l) => got.push(l))
    handlers[0]?.({ provider: 'codex' })
    expect(got).toEqual([{ provider: 'codex' }])
    off()
    expect(handlers).toHaveLength(0)
  })
})
