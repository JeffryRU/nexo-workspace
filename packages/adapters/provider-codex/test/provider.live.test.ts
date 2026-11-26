import { ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createCodexProvider } from '../src/index.ts'

// Prueba real: lanza la CLI `codex` instalada y usa la sesión del usuario (cuenta real, consume cuota).
// Solo corre con NEXO_LIVE_CODEX=1 y `pnpm --filter @nexo/adapter-provider-codex test:live`; nunca en el CI.
const live = process.env.NEXO_LIVE_CODEX === '1'

describe.skipIf(!live)('Codex real', () => {
  it('abre una sesión, responde a un saludo y recuerda el hilo', async () => {
    const provider = createCodexProvider({
      env: process.env,
      ...(process.env.NEXO_CODEX_EXECUTABLE === undefined
        ? {}
        : { executable: process.env.NEXO_CODEX_EXECUTABLE }),
    })
    expect(await provider.isAvailable(), provider.unavailableReason?.()).toBe(true)
    const caps = await provider.capabilities()
    expect(caps.models.length).toBeGreaterThan(0)
    const session = await provider.open({ cwd: process.cwd(), permissionMode: 'plan' })
    const events: ProviderEvent[] = []
    session.onEvent((e) => {
      expect(ProviderEvent.safeParse(e).success).toBe(true)
      events.push(e)
    })
    try {
      await session.send('Responde solo con la palabra: hola')
      const deadline = Date.now() + 120_000
      while (!events.some((e) => e.type === 'turn-end') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      const text = events
        .flatMap((e) => (e.type === 'block-delta' ? [e.text] : []))
        .join('')
        .toLowerCase()
      expect(text).toContain('hola')
      expect(events.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'end-turn' })
    } finally {
      await session.close()
    }
  })
})
