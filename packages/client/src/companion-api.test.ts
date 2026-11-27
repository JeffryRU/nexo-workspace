import { describe, expect, it } from 'vitest'
import { companionApi } from './companion-api.ts'

function fake() {
  const calls: { method: string; params: unknown }[] = []
  const handlers: ((d: unknown) => void)[] = []
  const api = companionApi({
    call: (async (method: string, params: unknown) => {
      calls.push({ method, params })
      return {}
    }) as never,
    on: ((event: string, handler: (d: unknown) => void) => {
      expect(event).toBe('companion.state')
      handlers.push(handler)
      return () => handlers.splice(handlers.indexOf(handler), 1)
    }) as never,
  })
  return { api, calls, handlers }
}

describe('companionApi', () => {
  it('cada método llama a su companion.*', async () => {
    const { api, calls } = fake()
    await api.list()
    await api.get({ id: 'tiny' })
    await api.select({ id: null })
    await api.asset({ id: 'tiny', path: 'idle.png' })
    await api.state()
    expect(calls).toEqual([
      { method: 'companion.list', params: {} },
      { method: 'companion.get', params: { id: 'tiny' } },
      { method: 'companion.select', params: { id: null } },
      { method: 'companion.asset', params: { id: 'tiny', path: 'idle.png' } },
      { method: 'companion.state', params: {} },
    ])
  })

  it('onState se suscribe a companion.state y devuelve la baja', () => {
    const { api, handlers } = fake()
    const seen: unknown[] = []
    const off = api.onState((s) => seen.push(s))
    handlers[0]?.({ state: 'idle', since: 1, selected: null })
    expect(seen).toEqual([{ state: 'idle', since: 1, selected: null }])
    off()
    expect(handlers).toHaveLength(0)
  })
})
