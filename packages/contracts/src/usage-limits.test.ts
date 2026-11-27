import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { events } from './events.ts'
import { limitsMethods, ProviderLimits, UsageWindow } from './usage-limits.ts'

describe('UsageWindow', () => {
  it('acepta una ventana completa y una mínima', () => {
    expect(
      UsageWindow.safeParse({
        id: 'primary',
        bucket: 'codex',
        label: 'Sesión',
        usedPercent: 42.5,
        windowMinutes: 300,
        resetsAt: 4_102_444_800_000,
        state: 'warning',
      }).success,
    ).toBe(true)
    expect(UsageWindow.safeParse({ id: 'x', usedPercent: 0 }).success).toBe(true)
  })

  it('rechaza porcentajes fuera de rango, ids hostiles, campos de cuenta y fechas negativas', () => {
    for (const bad of [
      { id: 'x', usedPercent: 100.1 },
      { id: 'x', usedPercent: -1 },
      { id: 'x', usedPercent: Number.NaN },
      { id: '../x', usedPercent: 1 },
      { id: '', usedPercent: 1 },
      { id: 'x', usedPercent: 1, resetsAt: -1 },
      { id: 'x', usedPercent: 1, windowMinutes: 0 },
      { id: 'x', usedPercent: 1, email: 'yo@example.com' },
      { id: 'x', usedPercent: 1, planType: 'plus' },
    ]) {
      expect(UsageWindow.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('propiedad: lo que acepta tiene porcentaje en 0-100 y no lleva claves de más', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const r = UsageWindow.safeParse(value)
        if (!r.success) return
        expect(r.data.usedPercent).toBeGreaterThanOrEqual(0)
        expect(r.data.usedPercent).toBeLessThanOrEqual(100)
        for (const k of Object.keys(r.data)) {
          expect([
            'id',
            'bucket',
            'label',
            'usedPercent',
            'windowMinutes',
            'resetsAt',
            'state',
          ]).toContain(k)
        }
      }),
      { numRuns: 500 },
    )
  })
})

describe('limits.status y limits.updated', () => {
  it('params estrictos; el resultado y el evento comparten ProviderLimits', () => {
    const { params, result } = limitsMethods['limits.status']
    expect(params.safeParse({}).success).toBe(true)
    expect(params.safeParse({ provider: 'codex', refresh: true }).success).toBe(true)
    expect(params.safeParse({ provider: 'Codex!' }).success).toBe(false)
    expect(params.safeParse({ extra: 1 }).success).toBe(false)
    const limits = {
      provider: 'codex',
      status: 'ok',
      windows: [{ id: 'primary', usedPercent: 1 }],
      source: 'query',
      observedAt: 1,
      fresh: true,
    }
    expect(result.safeParse({ providers: [limits] }).success).toBe(true)
    expect(events['limits.updated'].safeParse(limits).success).toBe(true)
    expect(ProviderLimits.safeParse({ ...limits, status: 'raro' }).success).toBe(false)
    expect(
      ProviderLimits.safeParse({ ...limits, windows: Array(17).fill({ id: 'a', usedPercent: 1 }) })
        .success,
    ).toBe(false)
  })
})
