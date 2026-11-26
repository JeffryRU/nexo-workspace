import { ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createAntigravityProvider } from '../src/index.ts'

// Prueba real: lanza la CLI `agy` instalada y usa la sesión del usuario (cuenta real, consume cuota).
// Solo corre con NEXO_LIVE_AGY=1 y `pnpm --filter @nexo/adapter-provider-antigravity test:live`; nunca en el CI.
// Comprueba lo que la documentación afirma y el adaptador supone: el formato de stream-json, que el id de
// conversación es un UUID y que `--conversation` reanuda.
const live = process.env.NEXO_LIVE_AGY === '1'

describe.skipIf(!live)('Antigravity real', () => {
  it('abre una sesión, responde a un saludo y reanuda la conversación', async () => {
    const provider = createAntigravityProvider({
      env: process.env,
      ...(process.env.NEXO_AGY_EXECUTABLE === undefined
        ? {}
        : { executable: process.env.NEXO_AGY_EXECUTABLE }),
    })
    expect(await provider.isAvailable(), provider.unavailableReason?.()).toBe(true)
    const caps = await provider.capabilities()
    console.log(`modelos: ${caps.models.map((m) => m.id).join(', ') || '(lista no reconocida)'}`)
    const session = await provider.open({ cwd: process.cwd(), permissionMode: 'plan' })
    const events: ProviderEvent[] = []
    session.onEvent((e) => {
      expect(ProviderEvent.safeParse(e).success).toBe(true)
      events.push(e)
    })
    const turn = async (text: string, n: number) => {
      await session.send(text)
      const deadline = Date.now() + 120_000
      while (events.filter((e) => e.type === 'turn-end').length < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    try {
      await turn('Responde solo con la palabra: hola', 1)
      const text = events
        .flatMap((e) => (e.type === 'block-delta' ? [e.text] : []))
        .join('')
        .toLowerCase()
      expect(text).toContain('hola')
      expect(events.filter((e) => e.type === 'turn-end').at(-1)).toMatchObject({
        stopReason: 'end-turn',
      })
      const id = session.providerSessionId
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      await session.close()
      const again = await provider.open({ cwd: process.cwd(), permissionMode: 'plan', resume: id })
      const second: ProviderEvent[] = []
      again.onEvent((e) => second.push(e))
      try {
        await again.send('¿Qué palabra te pedí antes? Responde solo con ella.')
        const deadline = Date.now() + 120_000
        while (!second.some((e) => e.type === 'turn-end') && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
        }
        const reply = second
          .flatMap((e) => (e.type === 'block-delta' ? [e.text] : []))
          .join('')
          .toLowerCase()
        expect(reply).toContain('hola')
      } finally {
        await again.close()
      }
    } finally {
      await session.close()
    }
  })
})
