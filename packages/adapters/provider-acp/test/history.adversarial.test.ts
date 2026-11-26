import { describe, expect, it } from 'vitest'
import { acpRig } from './history-rig.ts'

describe('AcpHistory: respuestas hostiles del agente', () => {
  it('descarta sesiones con id, fecha o forma inválidos y limpia los títulos', async () => {
    const rig = acpRig({
      FAKE_ACP_LIST_RAW: JSON.stringify({
        sessions: [
          {
            sessionId: 'ok-1',
            cwd: '/w',
            title: 'a\u001b[2J\nb',
            updatedAt: '2025-01-01T00:00:00Z',
          },
          { sessionId: '../../x', cwd: '/w', updatedAt: '2025-01-01T00:00:00Z' },
          { sessionId: 'sin-fecha', cwd: '/w' },
          { sessionId: 'fecha-mala', cwd: '/w', updatedAt: 'ayer por la tarde' },
          { sessionId: 'sin-cwd', updatedAt: '2025-01-01T00:00:00Z' },
          { sessionId: 'x'.repeat(300), cwd: '/w', updatedAt: '2025-01-01T00:00:00Z' },
          null,
          'texto',
          9,
        ],
        nextCursor: null,
      }),
    })
    const out = await rig.history.list({ limit: 50 })
    expect(out.map((s) => s.sessionId)).toEqual(['ok-1'])
    expect(out[0]?.title).toBe('a [2J b')
  })

  it('una respuesta sin «sessions» da UNAVAILABLE', async () => {
    const rig = acpRig({ FAKE_ACP_LIST_RAW: JSON.stringify({ nada: 1 }) })
    await expect(rig.history.list({ limit: 5 })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('un error del agente da UNAVAILABLE', async () => {
    const rig = acpRig({ FAKE_ACP_LIST_FAIL: '1' })
    await expect(rig.history.list({ limit: 5 })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('un cursor que nunca termina se corta', async () => {
    const rig = acpRig({
      FAKE_ACP_LIST_RAW: JSON.stringify({
        sessions: [{ sessionId: 'a-1', cwd: '/w', updatedAt: '2025-01-01T00:00:00Z' }],
        nextCursor: 'siempre',
      }),
    })
    const out = await rig.history.list({ limit: 1000 })
    expect(out.length).toBeLessThanOrEqual(20)
  })

  it('un agente que no responde se corta con la cancelación', async () => {
    const rig = acpRig({ FAKE_ACP_HISTORY_HANG: '1' })
    const signal = {
      aborted: false,
      l: undefined as undefined | (() => void),
      addEventListener(_t: 'abort', l: () => void) {
        this.l = l
      },
      removeEventListener() {},
    }
    const pending = rig.history.list({ limit: 5, signal })
    setTimeout(() => {
      signal.aborted = true
      signal.l?.()
    }, 200)
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
