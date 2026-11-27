import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runUsageLimitsConformance } from '@nexo/testkit/conformance'
import { describe, expect, it } from 'vitest'
import { dir } from './history-rig.ts'
import { limitsRig, rawResult, rawSnapshot, rawWindow } from './limits-rig.ts'

runUsageLimitsConformance('provider-codex (app-server falso)', () => {
  const rig = limitsRig()
  return { limits: rig.limits, seed: rig.seed, report: rig.report, dispose: rig.dispose }
})

const RESET = 4_102_444_800 // 2100-01-01 en segundos

describe('CodexUsageLimits', () => {
  it('query lee account/rateLimits/read: ventanas por cubo, porcentajes, duración y reinicio en ms', async () => {
    const rig = limitsRig()
    rig.setRead(
      rawResult({
        codex: rawSnapshot(
          'codex',
          rawWindow(42, 300, RESET),
          rawWindow(7, 10_080, RESET + 86_400),
        ),
        codex_other: rawSnapshot('codex_other', rawWindow(100, 60)),
      }),
    )
    const reading = await rig.limits.query({})
    expect(reading.windows).toEqual([
      {
        id: 'primary',
        bucket: 'codex',
        usedPercent: 42,
        windowMinutes: 300,
        resetsAt: RESET * 1000,
      },
      {
        id: 'secondary',
        bucket: 'codex',
        usedPercent: 7,
        windowMinutes: 10_080,
        resetsAt: (RESET + 86_400) * 1000,
      },
      { id: 'primary', bucket: 'codex_other', usedPercent: 100, windowMinutes: 60, state: 'limit' },
    ])
    expect(reading.reached).toBe(false)
    expect(typeof reading.observedAt).toBe('number')
  })

  it('sin mapa por cubo usa el cubo único; rateLimitReachedType marca reached', async () => {
    const rig = limitsRig()
    rig.setRead({
      rateLimits: rawSnapshot(null, rawWindow(55), null, {
        rateLimitReachedType: 'rate_limit_reached',
      }),
    })
    const reading = await rig.limits.query({})
    expect(reading.windows).toEqual([{ id: 'primary', bucket: 'codex', usedPercent: 55 }])
    expect(reading.reached).toBe(true)
  })

  it('nunca llama a account/read: solo initialize y account/rateLimits/read', async () => {
    const log = join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`)
    const rig = limitsRig({ FAKE_CODEX_LOG: log })
    await rig.limits.query({})
    const methods = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"in"'))
      .map((l) => (JSON.parse(JSON.parse(l).in) as { method?: string }).method)
    expect(methods).toEqual(['initialize', 'initialized', 'account/rateLimits/read'])
  })

  it('las notificaciones parciales se juntan con lo ya sabido y se entregan completas', async () => {
    const rig = limitsRig()
    rig.setRead(
      rawResult({ codex: rawSnapshot('codex', rawWindow(10, 300), rawWindow(20, 10_080)) }),
    )
    await rig.limits.query({})
    const got: unknown[][] = []
    rig.limits.onUpdate((r) => got.push(r.windows))
    // Notificación parcial: solo la primaria sube a 77; la secundaria (null) conserva lo que había.
    await rig.notify([{ rateLimits: rawSnapshot('codex', rawWindow(77, 300), null) }])
    expect(got).toHaveLength(1)
    expect(got[0]).toEqual([
      { id: 'primary', bucket: 'codex', usedPercent: 77, windowMinutes: 300 },
      { id: 'secondary', bucket: 'codex', usedPercent: 20, windowMinutes: 10_080 },
    ])
    await rig.dispose()
  })

  it('una notificación que llega en un turno no se mezcla con el turno', async () => {
    const rig = limitsRig()
    const got: unknown[] = []
    rig.limits.onUpdate((r) => got.push(r))
    await rig.notify([{ rateLimits: rawSnapshot('codex', rawWindow(3, 300)) }])
    expect(got).toHaveLength(1)
    await rig.dispose()
  })

  it('con el modo «limites» del falso la sesión entrega la ventana primaria y descarta la basura', async () => {
    const rig = limitsRig()
    const got: unknown[] = []
    rig.limits.onUpdate((r) => got.push(r.windows))
    await rig.notify([], 'limites')
    expect(got).toEqual([
      [
        {
          id: 'primary',
          bucket: 'codex',
          usedPercent: 77,
          windowMinutes: 300,
          resetsAt: RESET * 1000,
        },
      ],
    ])
    await rig.dispose()
  })
})
