import { tmpdir } from 'node:os'
import { UsageWindow } from '@nexo/contracts'
import type { UsageReading } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { createClaudeProvider } from '../src/provider.ts'

/**
 * Prueba real de los límites de Claude Code: solo con `NEXO_LIVE_CLAUDE=1` (nunca en el CI ni en `pnpm check`;
 * `pnpm --filter @nexo/adapter-provider-claude test:live`). Abre una sesión con la cuenta del usuario, envía un
 * mensaje mínimo y comprueba la forma de los `rate_limit_event` que el SDK emita (puede no emitir ninguno: una
 * cuenta con API key o sin avisos no es un fallo). No imprime porcentajes ni nada de la cuenta.
 */
const live = process.env.NEXO_LIVE_CLAUDE === '1'

describe.skipIf(!live)('límites de Claude Code (real)', () => {
  it('los rate_limit_event de una sesión real se traducen a ventanas válidas', async () => {
    const provider = createClaudeProvider({})
    const readings: UsageReading[] = []
    provider.usageLimits?.onUpdate((r) => readings.push(r))
    const session = await provider.open({ cwd: tmpdir(), permissionMode: 'plan' })
    try {
      let ended = false
      session.onEvent((e) => {
        if (e.type === 'turn-end') ended = true
      })
      await session.send('Responde solo con la palabra OK.')
      const until = Date.now() + 120_000
      while (!ended && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
      expect(ended).toBe(true)
    } finally {
      await session.close()
    }
    for (const r of readings) {
      for (const w of r.windows) expect(UsageWindow.safeParse(w).success).toBe(true)
    }
  })
})
