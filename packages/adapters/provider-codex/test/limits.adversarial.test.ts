import { UsageWindow } from '@nexo/contracts'
import { UsageLimitsError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { limitsRig, rawResult, rawSnapshot, rawWindow } from './limits-rig.ts'

const SECRETS = /SECRETO|example\.com/

describe('límites de Codex: entradas hostiles', () => {
  it('descarta los datos de cuenta de la respuesta: nada con SECRETO sale del adaptador', async () => {
    const rig = limitsRig()
    rig.setRead(
      rawResult(
        { codex: rawSnapshot('codex', rawWindow(10, 300), rawWindow(20, 10_080)) },
        { email: 'yo@example.com', account: { email: 'yo@example.com', planType: 'SECRETO' } },
      ),
    )
    const reading = await rig.limits.query({})
    expect(JSON.stringify(reading)).not.toMatch(SECRETS)
    for (const w of reading.windows) {
      expect(Object.keys(w).sort()).not.toContain('planType')
      expect(UsageWindow.safeParse(w).success).toBe(true)
    }
  })

  it('las notificaciones con datos de cuenta tampoco los dejan salir', async () => {
    const rig = limitsRig()
    const got: unknown[] = []
    rig.limits.onUpdate((r) => got.push(r))
    await rig.notify([
      {
        rateLimits: rawSnapshot('codex', rawWindow(5, 300), null, {
          accountId: 'SECRETO-1',
          limitName: null,
        }),
        accountId: 'SECRETO-2',
      },
    ])
    expect(got).toHaveLength(1)
    expect(JSON.stringify(got)).not.toMatch(SECRETS)
    await rig.dispose()
  })

  it('el mensaje de un error del servidor (con correo) no llega a quien llama', async () => {
    const rig = limitsRig({ FAKE_CODEX_LIMITS_MODE: 'fail' })
    const error = await rig.limits.query({}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UsageLimitsError)
    expect(String((error as Error).message)).not.toMatch(SECRETS)
    expect((error as UsageLimitsError).code).toBe('UNAVAILABLE')
  })

  it('una respuesta que no es un objeto de límites rechaza con UNAVAILABLE', async () => {
    const rig = limitsRig({ FAKE_CODEX_LIMITS_MODE: 'garbage' })
    await expect(rig.limits.query({})).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('porcentajes fuera de rango: se acota a 100; negativos, nulos o texto descartan solo esa ventana', async () => {
    const rig = limitsRig()
    rig.setRead(
      rawResult({
        codex: rawSnapshot('codex', rawWindow(250, 300), rawWindow(-5, 60)),
        otro: rawSnapshot('otro', rawWindow(Number.NaN as number, 60), {
          usedPercent: '50',
          windowDurationMins: 60,
        }),
      }),
    )
    const reading = await rig.limits.query({})
    expect(reading.windows).toEqual([
      { id: 'primary', bucket: 'codex', usedPercent: 100, windowMinutes: 300, state: 'limit' },
    ])
  })

  it('fechas y duraciones raras se omiten sin esconder la ventana', async () => {
    const rig = limitsRig()
    const weird = [
      rawWindow(10, 0, -1),
      rawWindow(10, 1e12, 9e15),
      rawWindow(10, 1.5, 1e11),
      rawWindow(10, -3, Number.MAX_SAFE_INTEGER),
    ]
    rig.setRead(
      rawResult(Object.fromEntries(weird.map((w, i) => [`b${i}`, rawSnapshot(`b${i}`, w)]))),
    )
    const reading = await rig.limits.query({})
    expect(reading.windows).toHaveLength(4)
    for (const w of reading.windows) {
      expect(UsageWindow.safeParse(w).success, JSON.stringify(w)).toBe(true)
      expect(w.resetsAt).toBeUndefined()
    }
    expect(reading.windows[2]?.windowMinutes).toBe(1)
  })

  it('cubos con nombres hostiles o en exceso: se acotan y el id vuelve al por omisión', async () => {
    const rig = limitsRig()
    const byId: Record<string, Record<string, unknown>> = {}
    for (let i = 0; i < 50; i++) byId[`b${i}`] = rawSnapshot(`b${i}`, rawWindow(i))
    byId['../../etc/passwd'] = rawSnapshot('../../etc/passwd', rawWindow(1))
    rig.setRead(rawResult(byId))
    const reading = await rig.limits.query({})
    expect(reading.windows.length).toBeLessThanOrEqual(16)
    for (const w of reading.windows) expect(UsageWindow.safeParse(w).success).toBe(true)
  })

  it('una etiqueta enorme o con control se limpia y se acota', async () => {
    const rig = limitsRig()
    rig.setRead(
      rawResult({
        codex: rawSnapshot('codex', rawWindow(1), null, {
          limitName: `${'x'.repeat(500)}\u0000‮\n`,
        }),
      }),
    )
    const [w] = (await rig.limits.query({})).windows
    expect(UsageWindow.safeParse(w).success).toBe(true)
    expect(w?.label?.length).toBeLessThanOrEqual(64)
  })

  it('notificaciones malformadas se ignoran sin avisar', async () => {
    const rig = limitsRig()
    const got: unknown[] = []
    rig.limits.onUpdate((r) => got.push(r))
    await rig.notify([
      { rateLimits: 'basura' },
      {},
      { rateLimits: { primary: { usedPercent: 'mucho' } } },
      { rateLimits: { primary: null, secondary: null } },
      null,
      [1, 2],
    ])
    expect(got).toEqual([])
    await rig.dispose()
  })

  it('una avalancha de 500 notificaciones: cada una entrega una lectura completa y válida', async () => {
    const rig = limitsRig()
    const got: { windows: unknown[] }[] = []
    rig.limits.onUpdate((r) => got.push(r))
    await rig.notify([], 'avalancha')
    expect(got.length).toBe(500)
    for (const r of got) expect(r.windows).toHaveLength(1)
    await rig.dispose()
  })

  it('un proveedor que no responde: query termina al cancelar la señal y no deja el proceso', async () => {
    const rig = limitsRig({ FAKE_CODEX_LIMITS_MODE: 'hang' })
    const listeners = new Set<() => void>()
    const signal = {
      aborted: false,
      addEventListener: (_: 'abort', l: () => void) => listeners.add(l),
      removeEventListener: (_: 'abort', l: () => void) => listeners.delete(l),
    }
    const pending = rig.limits.query({ signal })
    setTimeout(() => {
      signal.aborted = true
      for (const l of listeners) l()
    }, 200)
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('un ejecutable que no existe rechaza con UNAVAILABLE', async () => {
    const { createCodexProvider } = await import('../src/index.ts')
    const provider = createCodexProvider({
      env: { PATH: '' },
      executable: '/no/existe/codex',
    })
    await expect(provider.usageLimits?.query?.({})).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
