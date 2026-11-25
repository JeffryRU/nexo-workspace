import { methods } from '@nexo/contracts'
import { bootHarness, createHarness } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { SnapshotService } from './snapshot-service.ts'

describe('SnapshotService', () => {
  it('daemon.info valida con el esquema y fija el protocolo 1', () => {
    const h = createHarness()
    const info = h.snapshot.daemonInfo()
    expect(methods['daemon.info'].result.parse(info)).toEqual(info)
    expect(info).toEqual({
      version: '0.0.0-test',
      protocol: 1,
      pid: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('snapshot incluye el seq actual y el estado completo, y valida', async () => {
    const t = await bootHarness()
    await t.spawn()
    const snap = t.snapshot.snapshot()
    expect(methods.snapshot.result.parse(snap)).toBeDefined()
    expect(snap.seq).toBe(t.bus.events.length)
    expect(snap.workspaces[0]?.tabs[0]?.panes[0]?.terminalId).toBeDefined()
  })

  it('sin fuente de seq devuelve 0', () => {
    const h = createHarness()
    const s = new SnapshotService({
      layout: h.layout,
      identity: { version: '1', pid: 2, startedAt: 'x' },
    })
    expect(s.snapshot()).toEqual({ seq: 0, workspaces: [] })
  })
})
