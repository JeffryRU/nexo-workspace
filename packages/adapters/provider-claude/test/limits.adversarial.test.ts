import { UsageWindow } from '@nexo/contracts'
import type { UsageReading } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { ClaudeUsageLimits } from '../src/limits.ts'

const ev = (info: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'rate_limit_event',
  rate_limit_info: info,
  ...extra,
})

function collect() {
  const limits = new ClaudeUsageLimits({ now: () => 1_000 })
  const got: UsageReading[] = []
  limits.onUpdate((r) => got.push(r))
  return { limits, got }
}

describe('límites de Claude: entradas hostiles', () => {
  it('lo que no es un rate_limit_event no se trata (devuelve false) y no avisa', () => {
    const { limits, got } = collect()
    for (const m of [null, 5, 'x', [], {}, { type: 'assistant' }, { type: 'result' }]) {
      expect(limits.ingest(m)).toBe(false)
    }
    expect(got).toEqual([])
  })

  it('eventos malformados se tragan sin avisar', () => {
    const { limits, got } = collect()
    for (const info of [
      undefined,
      null,
      5,
      {},
      { status: 'raro' },
      { status: 'allowed' },
      { status: 'allowed', utilization: 'mucho' },
      { status: 'allowed', utilization: 300 },
      { status: 'allowed', utilization: -1 },
      { status: 'allowed', utilization: Number.NaN },
      { status: 'allowed_warning', rateLimitType: 'five_hour' },
    ]) {
      expect(limits.ingest(ev(info))).toBe(true)
    }
    expect(got).toEqual([])
  })

  it('campos de cuenta o créditos del evento no salen: solo las claves de la ventana', () => {
    const { limits, got } = collect()
    limits.ingest(
      ev(
        {
          status: 'allowed',
          utilization: 0.3,
          rateLimitType: 'five_hour',
          overageDisabledReason: 'SECRETO',
          hasChargeableSavedPaymentMethod: true,
          canUserPurchaseCredits: true,
          email: 'yo@example.com',
        },
        { session_id: 'SECRETO-sesion', uuid: 'SECRETO-uuid', email: 'yo@example.com' },
      ),
    )
    expect(got).toHaveLength(1)
    expect(JSON.stringify(got)).not.toMatch(/SECRETO|example\.com|payment|credits/i)
    expect(Object.keys(got[0]?.windows[0] ?? {}).sort()).toEqual(
      ['id', 'label', 'resetsAt', 'state', 'usedPercent', 'windowMinutes'].filter(
        (k) => k !== 'resetsAt',
      ),
    )
  })

  it('tipos de ventana hostiles pasan a «unknown»; ids sin fin no hacen crecer la lista', () => {
    const { limits, got } = collect()
    limits.ingest(ev({ status: 'allowed', utilization: 0.1, rateLimitType: '../../etc/passwd' }))
    expect(got[0]?.windows[0]?.id).toBe('unknown')
    for (let i = 0; i < 200; i++) {
      limits.ingest(ev({ status: 'allowed', utilization: 0.1, rateLimitType: `t${i}` }))
    }
    const last = got.at(-1)?.windows ?? []
    expect(last.length).toBeLessThanOrEqual(16)
    for (const w of last) expect(UsageWindow.safeParse(w).success).toBe(true)
  })

  it('fechas de reinicio raras se omiten sin esconder la ventana', () => {
    const { limits, got } = collect()
    for (const resetsAt of [-5, 1e300, Number.MAX_VALUE, Number.NaN, 9e15]) {
      limits.ingest(
        ev({ status: 'allowed', utilization: 0.1, rateLimitType: 'five_hour', resetsAt }),
      )
    }
    for (const r of got) {
      expect(r.windows[0]?.resetsAt).toBeUndefined()
      expect(UsageWindow.safeParse(r.windows[0]).success).toBe(true)
    }
  })

  it('una avalancha de 5000 eventos entrega lecturas válidas y acotadas (la contención es del servicio)', () => {
    const { limits, got } = collect()
    for (let i = 0; i < 5000; i++) {
      limits.ingest(
        ev({ status: 'allowed', utilization: (i % 100) / 100, rateLimitType: 'five_hour' }),
      )
    }
    expect(got).toHaveLength(5000)
    expect(got.at(-1)?.windows).toHaveLength(1)
  })

  it('un oyente que lanza no impide avisar a los demás', () => {
    const limits = new ClaudeUsageLimits()
    const got: UsageReading[] = []
    limits.onUpdate(() => {
      throw new Error('roto')
    })
    limits.onUpdate((r) => got.push(r))
    limits.ingest(ev({ status: 'allowed', utilization: 0.5, rateLimitType: 'seven_day' }))
    expect(got).toHaveLength(1)
  })
})
