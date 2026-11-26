import { UsageWindow } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createCodexProvider } from '../src/index.ts'

// Prueba real de los límites: lanza `codex app-server` y pide `account/rateLimits/read` con la sesión del usuario.
// Solo corre con NEXO_LIVE_CODEX=1 y `pnpm --filter @nexo/adapter-provider-codex test:live`; nunca en el CI.
// Es de solo lectura y no imprime nada de la cuenta ni los porcentajes: solo comprueba formas.
const live = process.env.NEXO_LIVE_CODEX === '1'

describe.skipIf(!live)('límites de Codex (real)', () => {
  it('account/rateLimits/read devuelve ventanas válidas sin datos de cuenta', async () => {
    const provider = createCodexProvider({
      env: process.env,
      ...(process.env.NEXO_CODEX_EXECUTABLE === undefined
        ? {}
        : { executable: process.env.NEXO_CODEX_EXECUTABLE }),
    })
    const reading = await provider.usageLimits?.query?.({})
    expect(reading).toBeDefined()
    // Una cuenta con API key no tiene ventanas: no es un fallo.
    for (const w of reading?.windows ?? []) expect(UsageWindow.safeParse(w).success).toBe(true)
    expect(Object.keys(reading ?? {}).sort()).toEqual(['observedAt', 'reached', 'windows'].sort())
  })
})
