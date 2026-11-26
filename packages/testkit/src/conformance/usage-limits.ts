import { UsageWindow } from '@nexo/contracts'
import { UsageLimitsError, type UsageLimitsPort, type UsageWindowInfo } from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { sleep } from '../timers.ts'

/** Lo que la suite necesita para ejercitar un `UsageLimitsPort` (el falso o un adaptador con su CLI/SDK de prueba). */
export type UsageLimitsRig = {
  limits: UsageLimitsPort
  /** Hace que el proveedor de prueba conteste estas ventanas a `query` (solo si el puerto consulta). */
  seed(windows: UsageWindowInfo[]): Promise<void>
  /** Hace que el proveedor de prueba informe estas ventanas por su cuenta (notificación / evento de sesión). */
  report(windows: UsageWindowInfo[]): Promise<void>
  dispose?(): Promise<void> | void
}

const WINDOWS: UsageWindowInfo[] = [
  {
    id: 'primary',
    bucket: 'codex',
    usedPercent: 12,
    windowMinutes: 300,
    resetsAt: 4_000_000_000_000,
  },
  { id: 'secondary', bucket: 'codex', usedPercent: 40, windowMinutes: 10_080 },
]

/** Claves que nunca deben salir de un adaptador (datos de la cuenta). */
const ACCOUNT_KEYS = /account|email|mail|user|plan|name|credit|token/i

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('no llegó la lectura a tiempo')
    await sleep(10)
  }
}

/**
 * Suite de conformidad de `UsageLimitsPort`: la ejecutan el falso (testkit) y cada adaptador de proveedor.
 * Comprueba consulta (si la hay), cancelación, avisos espontáneos, desuscripción y que no se filtren datos de cuenta.
 */
export function runUsageLimitsConformance(
  name: string,
  create: () => Promise<UsageLimitsRig> | UsageLimitsRig,
): void {
  describe(`UsageLimitsPort conformance: ${name}`, () => {
    let rig: UsageLimitsRig | undefined
    const make = async (): Promise<UsageLimitsRig> => {
      rig = await create()
      return rig
    }
    afterEach(async () => {
      await rig?.dispose?.()
      rig = undefined
    })

    it('declara su proveedor', async () => {
      const { limits } = await make()
      expect(limits.providerId.length).toBeGreaterThan(0)
    })

    it('query devuelve ventanas válidas sin campos de cuenta', async () => {
      const r = await make()
      if (r.limits.query === undefined) return
      await r.seed(WINDOWS)
      const reading = await r.limits.query({})
      expect(reading.windows.length).toBe(WINDOWS.length)
      for (const w of reading.windows) {
        expect(UsageWindow.safeParse(w).success, JSON.stringify(w)).toBe(true)
        for (const key of Object.keys(w)) expect(key).not.toMatch(ACCOUNT_KEYS)
      }
      expect(Object.keys(reading).filter((k) => ACCOUNT_KEYS.test(k))).toEqual([])
    })

    it('query con la señal ya cancelada rechaza con ABORTED', async () => {
      const r = await make()
      if (r.limits.query === undefined) return
      const signal = {
        aborted: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      }
      await expect(r.limits.query({ signal })).rejects.toMatchObject({
        name: UsageLimitsError.name,
        code: 'ABORTED',
      })
    })

    it('onUpdate avisa de lo que el proveedor informa y deja de avisar al cancelar', async () => {
      const r = await make()
      const got: UsageWindowInfo[][] = []
      const off = r.limits.onUpdate((reading) => got.push(reading.windows))
      await r.report(WINDOWS)
      await waitFor(() => got.length > 0)
      expect(got[0]?.length).toBeGreaterThan(0)
      for (const w of got[0] ?? []) {
        expect(UsageWindow.safeParse(w).success, JSON.stringify(w)).toBe(true)
        for (const key of Object.keys(w)) expect(key).not.toMatch(ACCOUNT_KEYS)
      }
      off()
      const n = got.length
      await r.report([{ id: 'primary', bucket: 'codex', usedPercent: 99 }])
      await sleep(100)
      expect(got.length).toBe(n)
    })

    it('un oyente que lanza no impide avisar a los demás', async () => {
      const r = await make()
      const got: number[] = []
      r.limits.onUpdate(() => {
        throw new Error('oyente roto')
      })
      r.limits.onUpdate((reading) => got.push(reading.windows.length))
      await r.report(WINDOWS)
      await waitFor(() => got.length > 0)
    })
  })
}
