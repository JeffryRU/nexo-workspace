import { UsageWindow } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { RateLimitsResult, readingOf, windowsOf } from '../src/limits.ts'

const anyNumber = fc.oneof(
  fc.double({ noNaN: false }),
  fc.integer(),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, -0, 1e300, 1e11, 9e15),
)
const maybe = (arb: fc.Arbitrary<unknown>) =>
  fc.oneof(arb, fc.constant(null), fc.constant(undefined))
const rawWindow = fc.record(
  { usedPercent: anyNumber, windowDurationMins: maybe(anyNumber), resetsAt: maybe(anyNumber) },
  { requiredKeys: [] },
)
const rawSnapshot = fc.record(
  {
    limitId: maybe(fc.string({ maxLength: 100 })),
    limitName: maybe(fc.string({ maxLength: 300 })),
    primary: maybe(rawWindow),
    secondary: maybe(rawWindow),
    rateLimitReachedType: maybe(fc.string()),
    accountId: fc.string(),
    planType: fc.string(),
  },
  { requiredKeys: [] },
)
const rawResult = fc.record(
  {
    rateLimits: rawSnapshot,
    rateLimitsByLimitId: maybe(fc.dictionary(fc.string({ maxLength: 80 }), rawSnapshot)),
    accountId: fc.string(),
  },
  { requiredKeys: ['rateLimits'] },
)

describe('normalización de límites de Codex (propiedades)', () => {
  it('toda ventana que sale es válida para el contrato, con porcentaje en 0-100', () => {
    fc.assert(
      fc.property(rawResult, (raw) => {
        const parsed = RateLimitsResult.safeParse(raw)
        if (!parsed.success) return
        const reading = readingOf(parsed.data)
        for (const w of reading.windows) {
          expect(UsageWindow.safeParse(w).success, JSON.stringify(w)).toBe(true)
          expect(w.usedPercent).toBeGreaterThanOrEqual(0)
          expect(w.usedPercent).toBeLessThanOrEqual(100)
        }
        expect(reading.windows.length).toBeLessThanOrEqual(16)
      }),
      { numRuns: 300 },
    )
  })

  it('ningún campo de cuenta sobrevive al análisis (el esquema los descarta)', () => {
    fc.assert(
      fc.property(rawResult, (raw) => {
        const parsed = RateLimitsResult.safeParse(raw)
        if (!parsed.success) return
        const keys = new Set(Object.keys(parsed.data))
        expect([...keys].every((k) => k === 'rateLimits' || k === 'rateLimitsByLimitId')).toBe(true)
        for (const snap of [
          parsed.data.rateLimits,
          ...Object.values(parsed.data.rateLimitsByLimitId ?? {}),
        ]) {
          for (const k of Object.keys(snap)) {
            expect([
              'limitId',
              'limitName',
              'primary',
              'secondary',
              'rateLimitReachedType',
            ]).toContain(k)
          }
        }
      }),
      { numRuns: 200 },
    )
  })

  it('windowsOf es determinista y no lanza con cualquier instantánea válida', () => {
    fc.assert(
      fc.property(rawSnapshot, (raw) => {
        const parsed = RateLimitsResult.safeParse({ rateLimits: raw })
        if (!parsed.success) return
        expect(windowsOf(parsed.data.rateLimits)).toEqual(windowsOf(parsed.data.rateLimits))
      }),
    )
  })
})
