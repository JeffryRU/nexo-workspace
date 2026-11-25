import { PaneId, TabId, TerminalId, WorkspaceId } from '@nexo/contracts'
import { describe, expect, it, vi } from 'vitest'
import { MemoryEventBus } from './event-bus.ts'
import { SystemClock } from './system-clock.ts'
import { UuidIds } from './uuid-ids.ts'

describe('UuidIds', () => {
  it('genera ids válidos para el contrato y únicos', () => {
    const ids = new UuidIds()
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      for (const [schema, id] of [
        [WorkspaceId, ids.workspace()],
        [TabId, ids.tab()],
        [PaneId, ids.pane()],
        [TerminalId, ids.terminal()],
      ] as const) {
        expect(schema.safeParse(id).success).toBe(true)
        seen.add(id)
      }
    }
    expect(seen.size).toBe(800)
  })
})

describe('SystemClock', () => {
  it('now es la hora real y los temporizadores se pueden cancelar', async () => {
    const clock = new SystemClock()
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50)
    const fired = vi.fn()
    clock.setTimeout(fired, 10)()
    const ok = vi.fn()
    clock.setTimeout(ok, 5)
    await new Promise((r) => setTimeout(r, 40))
    expect(fired).not.toHaveBeenCalled()
    expect(ok).toHaveBeenCalledOnce()
    const neg = vi.fn()
    clock.setTimeout(neg, -50)
    await new Promise((r) => setTimeout(r, 20))
    expect(neg).toHaveBeenCalled()
  })
})

describe('MemoryEventBus', () => {
  it('entrega a todos, deja de entregar al cancelar y aísla errores', () => {
    const errors: unknown[] = []
    const bus = new MemoryEventBus((e) => errors.push(e))
    const got: string[] = []
    bus.subscribe(() => {
      throw new Error('mal suscriptor')
    })
    const off = bus.subscribe((e) => got.push(e.event))
    bus.publish({ event: 'pane.title', data: { paneId: PaneId.parse('p'), title: 't' } })
    off()
    bus.publish({ event: 'pane.title', data: { paneId: PaneId.parse('p'), title: 't' } })
    expect(got).toEqual(['pane.title'])
    expect(errors).toHaveLength(2)
    expect(bus.size).toBe(1)
  })

  it('un suscriptor que se cancela durante la entrega no rompe la iteración', () => {
    const bus = new MemoryEventBus()
    const calls: number[] = []
    const off1 = bus.subscribe(() => {
      calls.push(1)
      off1()
    })
    bus.subscribe(() => calls.push(2))
    bus.publish({ event: 'pane.title', data: { paneId: PaneId.parse('p'), title: 't' } })
    expect(calls).toEqual([1, 2])
  })
})
