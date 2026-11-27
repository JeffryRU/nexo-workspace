import type { ProviderLimits } from '@nexo/contracts'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  formatPercent,
  formatRemaining,
  formatResetAt,
  HIGH_AT,
  levelOf,
  percentOf,
  replaceProvider,
  summarize,
  summaryText,
  WARN_AT,
  windowDuration,
  windowName,
  worstPercent,
} from './view.ts'

const lim = (
  provider: string,
  percents: number[],
  status: ProviderLimits['status'] = 'ok',
): ProviderLimits => ({
  provider,
  status,
  windows: percents.map((usedPercent, i) => ({ id: `w${i}`, usedPercent })),
})

describe('límites: formato', () => {
  it('percentOf acota y descarta lo que no es número', () => {
    expect(percentOf({ usedPercent: 50 })).toBe(50)
    expect(percentOf({ usedPercent: 500 })).toBe(100)
    expect(percentOf({ usedPercent: -1 })).toBe(0)
    expect(percentOf({ usedPercent: Number.NaN })).toBeUndefined()
    expect(percentOf({ usedPercent: 'x' as unknown as number })).toBeUndefined()
  })

  it('umbrales de color', () => {
    expect(levelOf(WARN_AT - 0.1)).toBe('ok')
    expect(levelOf(WARN_AT)).toBe('warn')
    expect(levelOf(HIGH_AT - 0.1)).toBe('warn')
    expect(levelOf(HIGH_AT)).toBe('high')
    expect(levelOf(undefined)).toBe('ok')
  })

  it('formatPercent redondea y nunca devuelve NaN', () => {
    expect(formatPercent(83.5)).toBe('84 %')
    expect(formatPercent(undefined)).toBe('?')
    expect(formatPercent(Number.NaN)).toBe('?')
    expect(formatPercent(1e9)).toBe('100 %')
  })

  it('duración de la ventana', () => {
    expect(windowDuration(300)).toBe('5 h')
    expect(windowDuration(10080)).toBe('7 d')
    expect(windowDuration(45)).toBe('45 min')
    expect(windowDuration(90)).toBe('1 h 30 min')
    expect(windowDuration(0)).toBeUndefined()
    expect(windowDuration(Number.NaN)).toBeUndefined()
  })

  it('fecha de reinicio local y tiempo restante', () => {
    expect(formatResetAt(Date.now())).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatResetAt(Number.NaN)).toBe('?')
    expect(formatResetAt(8.64e15 + 1)).toBe('?')
    const now = 1_000_000_000_000
    expect(formatRemaining(now + 5 * 60_000, now)).toBe('en 5 min')
    expect(formatRemaining(now + 125 * 60_000, now)).toBe('en 2 h 5 min')
    expect(formatRemaining(now + 3 * 86_400_000 + 5 * 3_600_000, now)).toBe('en 3 d 5 h')
    expect(formatRemaining(now - 1, now)).toBe('ya pasó')
    expect(formatRemaining(undefined, now)).toBeUndefined()
    expect(formatRemaining(Number.NaN, now)).toBeUndefined()
    // La resta desborda a Infinity aunque ambos sean finitos.
    expect(formatRemaining(Number.MAX_VALUE, -Number.MAX_VALUE)).toBeUndefined()
    expect(formatRemaining(-Number.MAX_VALUE, Number.MAX_VALUE)).toBeUndefined()
  })

  it('nombre de ventana: etiqueta del proveedor, nombre conocido o el id', () => {
    expect(windowName({ id: 'primary', label: 'Mi ventana' })).toBe('Mi ventana')
    expect(windowName({ id: 'five_hour' })).toBe('de 5 horas')
    expect(windowName({ id: 'rara' })).toBe('rara')
    expect(windowName({ id: 'constructor' })).toBe('constructor')
  })
})

describe('límites: resumen', () => {
  it('ordena por proveedor, oculta los que no ofrecen límites y marca desconocidos y alcanzados', () => {
    const s = summarize([
      lim('zeta', [10, 95]),
      lim('ollama', [], 'unsupported'),
      lim('alfa', [], 'unknown'),
      { ...lim('beta', [20]), reached: true },
      { provider: 'gamma', status: 'ok', windows: [{ id: 'a', usedPercent: 10, state: 'limit' }] },
    ])
    expect(s.map((x) => x.provider)).toEqual(['alfa', 'beta', 'gamma', 'zeta'])
    expect(s.map(summaryText)).toEqual(['desconocido', '20 %', '10 %', '95 %'])
    expect(s.map((x) => x.reached)).toEqual([false, true, true, false])
    expect(s[3]?.level).toBe('high')
  })

  it('un error con último dato conocido sigue mostrando el dato', () => {
    const [s] = summarize([{ ...lim('x', [33], 'error'), reason: 'falló el refresco' }])
    expect(s?.unknown).toBe(false)
    expect(summaryText(s as NonNullable<typeof s>)).toBe('33 %')
  })

  it('replaceProvider sustituye o añade sin tocar el resto', () => {
    const a = lim('a', [1])
    const b = lim('b', [2])
    expect(replaceProvider([a, b], lim('a', [9]))).toEqual([lim('a', [9]), b])
    expect(replaceProvider([a], b)).toEqual([a, b])
  })
})

describe('propiedades (fast-check)', () => {
  it('worstPercent es el máximo de los porcentajes acotados, y el resumen nunca trae NaN', () => {
    fc.assert(
      fc.property(fc.array(fc.double(), { maxLength: 10 }), (ps) => {
        const windows = ps.map((usedPercent) => ({ usedPercent }))
        const worst = worstPercent(windows)
        const valid = ps.filter((p) => !Number.isNaN(p)).map((p) => Math.min(100, Math.max(0, p)))
        expect(worst).toBe(valid.length === 0 ? undefined : Math.max(...valid))
        expect(formatPercent(worst)).not.toContain('NaN')
        if (worst !== undefined) {
          expect(worst).toBeGreaterThanOrEqual(0)
          expect(worst).toBeLessThanOrEqual(100)
        }
      }),
    )
  })

  it('levelOf es monótono', () => {
    const rank = { ok: 0, warn: 1, high: 2 } as const
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          expect(rank[levelOf(lo)]).toBeLessThanOrEqual(rank[levelOf(hi)])
        },
      ),
    )
  })

  it('replaceProvider deja una sola entrada por proveedor y la última gana', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 0, max: 100 })), {
          maxLength: 30,
        }),
        (updates) => {
          let state: ProviderLimits[] = []
          const last = new Map<string, number>()
          for (const [p, n] of updates) {
            state = replaceProvider(state, lim(p, [n]))
            last.set(p, n)
          }
          expect(state.map((s) => s.provider).sort()).toEqual([...last.keys()].sort())
          for (const s of state) expect(s.windows[0]?.usedPercent).toBe(last.get(s.provider))
        },
      ),
    )
  })

  it('formatResetAt y formatRemaining nunca devuelven NaN', () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), (ms, now) => {
        expect(formatResetAt(ms)).not.toContain('NaN')
        expect(formatRemaining(ms, now) ?? '').not.toContain('NaN')
      }),
    )
  })
})
