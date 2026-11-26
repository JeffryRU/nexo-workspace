import { describe, expect, it } from 'vitest'
import { createAcpProvider, DEFAULT_ACP_AGENTS } from '../src/index.ts'

// Prueba real del historial por ACP: lanza el agente instalado y llama a `session/list` solo si lo anuncia. Solo corre
// con NEXO_LIVE_ACP=1 y `pnpm --filter @nexo/adapter-provider-acp test:live`; nunca en el CI. Es de solo lectura y no
// imprime títulos ni rutas: solo cuentas y formas.
const live = process.env.NEXO_LIVE_ACP === '1'

const gemini = DEFAULT_ACP_AGENTS[0]
const agent = {
  id: 'live-acp',
  name: 'Agente ACP',
  command: process.env.NEXO_LIVE_ACP_COMMAND ?? gemini?.command ?? 'gemini',
  args: process.env.NEXO_LIVE_ACP_ARGS?.split(' ').filter((a) => a !== '') ?? gemini?.args ?? [],
}

describe.skipIf(!live)('historial del agente ACP (real)', () => {
  it('lista sesiones si el agente anuncia session/list y, si no, responde UNSUPPORTED', async () => {
    const provider = createAcpProvider({ agent, env: process.env })
    const history = provider.history
    expect(history).toBeDefined()
    try {
      const sessions = (await history?.list({ limit: 20 })) ?? []
      for (const s of sessions) {
        expect(s.sessionId.length).toBeGreaterThan(0)
        expect(Number.isSafeInteger(s.updatedAt)).toBe(true)
      }
    } catch (error) {
      expect((error as { code?: string }).code).toBe('UNSUPPORTED')
    }
  })
})
