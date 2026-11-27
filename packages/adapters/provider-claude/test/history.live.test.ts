import { BlockDraft } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createClaudeProvider } from '../src/provider.ts'

/**
 * Prueba real del historial de Claude Code: solo con `NEXO_LIVE_CLAUDE=1` (nunca en el CI ni en `pnpm check`;
 * se lanza con `pnpm --filter @nexo/adapter-provider-claude test:live`). Es de solo lectura (el SDK lee sus
 * propias sesiones) y no imprime títulos, rutas ni texto de las conversaciones: solo cuentas y formas.
 */
const live = process.env.NEXO_LIVE_CLAUDE === '1'

describe.skipIf(!live)('historial de Claude Code (real)', () => {
  it('lista sesiones con ficha y fecha válidas y lee la transcripción de la más reciente', async () => {
    const provider = createClaudeProvider({})
    const history = provider.history
    expect(history).toBeDefined()
    const sessions = (await history?.list({ limit: 20 })) ?? []
    for (const s of sessions) {
      expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(Number.isSafeInteger(s.updatedAt)).toBe(true)
    }
    const newest = sessions[0]
    if (newest === undefined) return // una cuenta sin sesiones no es un fallo
    const transcript = await history?.read({
      sessionId: newest.sessionId,
      ...(newest.cwd === undefined ? {} : { cwd: newest.cwd }),
      maxBlocks: 200,
    })
    expect(transcript).toBeDefined()
    for (const b of transcript?.blocks ?? [])
      expect(BlockDraft.safeParse(b.block).success).toBe(true)
  })
})
