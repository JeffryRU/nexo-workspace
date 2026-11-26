import { ProviderLimits, UsageWindow } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { normalizeUsageReading } from './usage-limits-service.ts'

const junk = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.double({ noNaN: false }),
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
)
const rawWindow = fc.record(
  {
    id: junk,
    bucket: junk,
    label: junk,
    usedPercent: junk,
    windowMinutes: junk,
    resetsAt: junk,
    state: fc.oneof(junk, fc.constantFrom('ok', 'warning', 'limit')),
    email: fc.string(),
    accountId: fc.string(),
  },
  { requiredKeys: [] },
)
const reading = fc.record(
  {
    windows: fc.array(fc.oneof(rawWindow, junk), { maxLength: 60 }),
    reached: junk,
    observedAt: junk,
  },
  { requiredKeys: [] },
)

describe('normalizeUsageReading (propiedades)', () => {
  it('toda ventana que sale cumple UsageWindow, sin campos extra, y como mucho 16 sin repetir clave', () => {
    fc.assert(
      fc.property(reading, (raw) => {
        const n = normalizeUsageReading(raw)
        if (n === undefined) return
        expect(n.windows.length).toBeLessThanOrEqual(16)
        const keys = new Set<string>()
        for (const w of n.windows) {
          expect(UsageWindow.safeParse(w).success).toBe(true)
          expect(Object.keys(w).filter((k) => k === 'email' || k === 'accountId')).toEqual([])
          const key = `${w.bucket}|${w.id}`
          expect(keys.has(key)).toBe(false)
          keys.add(key)
        }
        expect(
          ProviderLimits.safeParse({ provider: 'p', status: 'ok', windows: n.windows }).success,
        ).toBe(true)
      }),
      { numRuns: 400 },
    )
  })

  it('es idempotente: normalizar lo ya normalizado no cambia nada', () => {
    fc.assert(
      fc.property(reading, (raw) => {
        const n = normalizeUsageReading(raw)
        if (n === undefined) return
        expect(normalizeUsageReading({ windows: n.windows })?.windows).toEqual(n.windows)
      }),
    )
  })
})
