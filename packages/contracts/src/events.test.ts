import { describe, expect, it } from 'vitest'
import { events, parseServerMessage } from './index.ts'

const msg = (event: string, data: unknown) => JSON.stringify({ v: 1, event, seq: 1, data })

describe('workspace.changed', () => {
  it('acepta el espacio resumido y el cierre', () => {
    const ok = events['workspace.changed']
    expect(
      ok.safeParse({ workspace: { id: 'w1', name: 'n', tabs: [{ id: 't1', title: 'x' }] } })
        .success,
    ).toBe(true)
    expect(ok.safeParse({ workspaceId: 'w1', removed: true }).success).toBe(true)
  })

  it('rechaza formas mixtas, removed falso, claves extra y títulos con control', () => {
    const bad = events['workspace.changed']
    expect(bad.safeParse({ workspaceId: 'w1', removed: false }).success).toBe(false)
    expect(bad.safeParse({ workspaceId: 'w1' }).success).toBe(false)
    expect(bad.safeParse({ workspaceId: 'w1', removed: true, extra: 1 }).success).toBe(false)
    expect(
      bad.safeParse({
        workspace: { id: 'w1', name: 'n', tabs: [{ id: 't1', title: 'a\u001b[0m' }] },
      }).success,
    ).toBe(false)
    expect(bad.safeParse({ workspace: { id: '../x', name: 'n', tabs: [] } }).success).toBe(false)
  })

  it('viaja como evento tipado', () => {
    const r = parseServerMessage(msg('workspace.changed', { workspaceId: 'w1', removed: true }))
    expect(r.ok).toBe(true)
  })
})

describe('client.resync', () => {
  it('exige motivo conocido y un conteo positivo', () => {
    const e = events['client.resync']
    expect(e.safeParse({ reason: 'backpressure', dropped: 3 }).success).toBe(true)
    expect(e.safeParse({ reason: 'backpressure', dropped: 0 }).success).toBe(false)
    expect(e.safeParse({ reason: 'otro', dropped: 1 }).success).toBe(false)
  })
})
