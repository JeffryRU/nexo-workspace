import { UsageWindow } from '@nexo/contracts'
import type { UsageWindowInfo } from '@nexo/core'
import { runUsageLimitsConformance } from '@nexo/testkit/conformance'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { percentOf, resetMs } from '../src/limits.ts'
import { createClaudeProvider } from '../src/provider.ts'
import { FakeTransport, tempDir } from './helpers.ts'

type Info = Record<string, unknown>
const event = (info: Info, extra: Info = {}) => ({
  type: 'rate_limit_event',
  uuid: 'u-1',
  session_id: 's-1',
  rate_limit_info: info,
  ...extra,
})

async function rig() {
  const dir = tempDir()
  const transport = new FakeTransport()
  const provider = createClaudeProvider({ transport, env: {}, interruptTimeoutMs: 500 })
  const limits = provider.usageLimits
  if (limits === undefined) throw new Error('Claude debe exponer límites')
  const session = await provider.open({ cwd: dir.path })
  const sdk = transport.sessions[0]
  if (sdk === undefined) throw new Error('sin sesión del SDK')
  const got: UsageWindowInfo[][] = []
  limits.onUpdate((r) => got.push(r.windows))
  const settle = () => new Promise((r) => setTimeout(r, 30))
  return {
    provider,
    limits,
    sdk,
    got,
    settle,
    dispose: async () => {
      await session.close()
      dir.remove()
    },
  }
}

runUsageLimitsConformance('provider-claude (transporte falso)', async () => {
  const r = await rig()
  return {
    limits: r.limits,
    seed: async () => {},
    report: async (windows) => {
      for (const w of windows) {
        r.sdk.emit(
          event({
            status: 'allowed',
            rateLimitType: w.id,
            utilization: w.usedPercent / 100,
            ...(w.resetsAt === undefined ? {} : { resetsAt: Math.floor(w.resetsAt / 1000) }),
          }),
        )
      }
      await r.settle()
    },
    dispose: r.dispose,
  }
})

describe('límites de Claude (rate_limit_event del SDK)', () => {
  it('no se puede consultar: sin query; todo viene de las sesiones', async () => {
    const r = await rig()
    expect(r.limits.query).toBeUndefined()
    await r.dispose()
  })

  it('traduce estado, utilización (fracción), reinicio (segundos) y tipo de ventana', async () => {
    const r = await rig()
    r.sdk.emit(
      event({
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.83,
        resetsAt: 4_102_444_800,
      }),
    )
    await r.settle()
    expect(r.got.at(-1)).toEqual([
      {
        id: 'five_hour',
        label: 'Sesión de 5 horas',
        usedPercent: 83,
        windowMinutes: 300,
        resetsAt: 4_102_444_800_000,
        state: 'warning',
      },
    ])
    await r.dispose()
  })

  it('junta ventanas distintas y una rechazada sin utilización cuenta como 100 % y reached', async () => {
    const r = await rig()
    const readings: { reached?: boolean }[] = []
    r.limits.onUpdate((x) => readings.push(x))
    r.sdk.emit(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 }))
    r.sdk.emit(event({ status: 'rejected', rateLimitType: 'seven_day' }))
    await r.settle()
    expect(r.got.at(-1)?.map((w) => [w.id, w.usedPercent, w.state])).toEqual([
      ['five_hour', 10, 'ok'],
      ['seven_day', 100, 'limit'],
    ])
    expect(readings.at(-1)?.reached).toBe(true)
    // Un evento posterior de la misma ventana la sustituye.
    r.sdk.emit(event({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.2 }))
    await r.settle()
    expect(readings.at(-1)?.reached).toBe(false)
    await r.dispose()
  })

  it('el evento no se mezcla con los eventos del turno ni rompe la sesión', async () => {
    const r = await rig()
    r.sdk.emit(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }))
    await r.settle()
    expect(r.got).toHaveLength(1)
    await r.dispose()
  })

  it('percentOf y resetMs: fracción, porcentaje, fuera de rango, segundos y milisegundos', () => {
    expect(percentOf(0.5, false)).toBe(50)
    expect(percentOf(1, false)).toBe(100)
    expect(percentOf(42, false)).toBe(42)
    expect(percentOf(150, false)).toBeUndefined()
    expect(percentOf(-1, false)).toBeUndefined()
    expect(percentOf(Number.NaN, true)).toBe(100)
    expect(percentOf(undefined, false)).toBeUndefined()
    expect(resetMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(resetMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(resetMs(-1)).toBeUndefined()
    expect(resetMs(1e300)).toBeUndefined()
  })

  it('propiedad: percentOf siempre da 0-100 o nada; resetMs siempre un entero de ms válido o nada', () => {
    fc.assert(
      fc.property(fc.double(), fc.boolean(), (u, rejected) => {
        const p = percentOf(u, rejected)
        if (p !== undefined) {
          expect(p).toBeGreaterThanOrEqual(0)
          expect(p).toBeLessThanOrEqual(100)
        }
      }),
    )
    fc.assert(
      fc.property(fc.double(), (v) => {
        const ms = resetMs(v)
        if (ms !== undefined) {
          expect(Number.isSafeInteger(ms)).toBe(true)
          expect(UsageWindow.safeParse({ id: 'x', usedPercent: 0, resetsAt: ms }).success).toBe(
            true,
          )
        }
      }),
    )
  })
})
