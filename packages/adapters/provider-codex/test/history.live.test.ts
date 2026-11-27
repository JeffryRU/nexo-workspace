import { BlockDraft } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createCodexProvider } from '../src/index.ts'

// Prueba real del historial: lanza `codex app-server` y consulta los hilos de la cuenta del usuario.
// Solo corre con NEXO_LIVE_CODEX=1 y `pnpm --filter @nexo/adapter-provider-codex test:live`; nunca en el CI.
// Es de solo lectura y no imprime títulos, rutas ni texto de las conversaciones: solo cuentas y formas.
const live = process.env.NEXO_LIVE_CODEX === '1'

describe.skipIf(!live)('historial de Codex (real)', () => {
  it('lista hilos con ficha y fecha válidas y lee la transcripción del más reciente', async () => {
    const provider = createCodexProvider({
      env: process.env,
      ...(process.env.NEXO_CODEX_EXECUTABLE === undefined
        ? {}
        : { executable: process.env.NEXO_CODEX_EXECUTABLE }),
    })
    const history = provider.history
    expect(history).toBeDefined()
    const sessions = (await history?.list({ limit: 20 })) ?? []
    for (const s of sessions) {
      expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(Number.isSafeInteger(s.updatedAt)).toBe(true)
    }
    const newest = sessions[0]
    if (newest === undefined) return // una cuenta sin hilos no es un fallo
    const transcript = await history?.read({ sessionId: newest.sessionId, maxBlocks: 200 })
    expect(transcript).toBeDefined()
    for (const b of transcript?.blocks ?? [])
      expect(BlockDraft.safeParse(b.block).success).toBe(true)
  })
})
