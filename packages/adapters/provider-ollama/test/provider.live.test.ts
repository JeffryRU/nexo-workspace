import type { ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createOllamaProvider, DEFAULT_OLLAMA_URL } from '../src/provider.ts'

/**
 * Prueba real contra un Ollama en marcha: solo con `NEXO_LIVE_OLLAMA=1` (URL en `NEXO_OLLAMA_URL`; usa el primer
 * modelo instalado o `NEXO_LIVE_OLLAMA_MODEL`). No corre en el CI ni en `pnpm check`:
 * `NEXO_LIVE_OLLAMA=1 pnpm --filter @nexo/adapter-provider-ollama test:live`.
 */
const live = process.env.NEXO_LIVE_OLLAMA === '1'

describe.skipIf(!live)('proveedor Ollama (real)', () => {
  it('responde a un saludo con texto, un turn-end y recuerda el turno anterior', async () => {
    const provider = createOllamaProvider({
      baseUrl: process.env.NEXO_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    })
    expect(await provider.isAvailable(), provider.unavailableReason?.()).toBe(true)
    const caps = await provider.capabilities()
    expect(caps.models.length).toBeGreaterThan(0)
    const model = process.env.NEXO_LIVE_OLLAMA_MODEL ?? caps.defaultModel
    const session = await provider.open({
      cwd: process.cwd(),
      ...(model === undefined ? {} : { model }),
    })
    const events: ProviderEvent[] = []
    session.onEvent((e) => events.push(e))
    const turn = async (text: string, n: number) => {
      await session.send(text)
      const start = Date.now()
      while (events.filter((e) => e.type === 'turn-end').length < n) {
        if (Date.now() - start > 150_000) throw new Error('sin respuesta en 150 s')
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    await turn('Mi palabra secreta es zafiro. Responde solo: entendido', 1)
    await turn('¿Cuál era mi palabra secreta? Responde solo con la palabra.', 2)
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    const text = events
      .flatMap((e) => (e.type === 'block-delta' ? [e.text] : []))
      .join('')
      .toLowerCase()
    expect(text).toContain('zafiro')
    await session.close()
  })
})
