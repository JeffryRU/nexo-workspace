import { type HistoryRig, runHistoryConformance } from '@nexo/testkit/conformance'
import { describe, expect, it } from 'vitest'
import { acpRig } from './history-rig.ts'

runHistoryConformance('provider-acp (agente ACP falso, solo lista)', (): HistoryRig => {
  const rig = acpRig()
  return {
    history: rig.history,
    seed: async (s) =>
      rig.add({
        cwd: s.cwd,
        title: s.title,
        updatedAt: new Date(s.updatedAt).toISOString(),
      }),
  }
})

describe('AcpHistory', () => {
  it('lista con título, carpeta y fecha RFC 3339 como milisegundos', async () => {
    const rig = acpRig()
    const id = rig.add({ cwd: '/w/a', title: 'Una sesión', updatedAt: '2025-10-29T14:22:15Z' })
    const [s] = await rig.history.list({ limit: 10 })
    expect(s).toMatchObject({
      sessionId: id,
      title: 'Una sesión',
      cwd: '/w/a',
      updatedAt: Date.parse('2025-10-29T14:22:15Z'),
      resumable: true,
    })
  })

  it('un agente que no anuncia session/list no tiene historial', async () => {
    const rig = acpRig({ FAKE_ACP_LIST: '0' })
    await expect(rig.history.list({ limit: 5 })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('sin loadSession las sesiones de la lista no son reanudables', async () => {
    const rig = acpRig({ FAKE_ACP_NO_LOAD: '1' })
    rig.add({ cwd: '/w/a', updatedAt: '2025-10-29T14:22:15Z' })
    const [s] = await rig.history.list({ limit: 10 })
    expect(s?.resumable).toBe(false)
  })

  it('pasa la carpeta como filtro y recorre las páginas con el cursor', async () => {
    const rig = acpRig({ FAKE_ACP_PAGE: '2' })
    for (let i = 0; i < 5; i++) {
      rig.add({ cwd: '/w/a', updatedAt: new Date(1_700_000_000_000 + i * 1000).toISOString() })
    }
    rig.add({ cwd: '/w/otra', updatedAt: new Date(1_700_000_000_000).toISOString() })
    expect(await rig.history.list({ limit: 50, cwd: '/w/a' })).toHaveLength(5)
    expect(await rig.history.list({ limit: 3, cwd: '/w/a' })).toHaveLength(3)
  })

  it('leer es UNSUPPORTED: solo se lista', async () => {
    const rig = acpRig()
    expect(rig.history.canRead).toBe(false)
    await expect(
      rig.history.read({ sessionId: 'fake-session-1', maxBlocks: 5 }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
  })
})
