import { ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createAcpProvider, DEFAULT_ACP_AGENTS } from '../src/index.ts'

// Prueba real: lanza el agente ACP instalado (por omisión Gemini CLI con `--acp`) y usa la sesión del usuario
// (cuenta real, consume cuota). Solo corre con NEXO_LIVE_ACP=1 y `pnpm --filter @nexo/adapter-provider-acp
// test:live`; nunca en el CI. NEXO_LIVE_ACP_COMMAND y NEXO_LIVE_ACP_ARGS (separados por espacios) cambian el agente.
const live = process.env.NEXO_LIVE_ACP === '1'

const gemini = DEFAULT_ACP_AGENTS[0]
const agent = {
  id: 'live-acp',
  name: 'Agente ACP',
  command: process.env.NEXO_LIVE_ACP_COMMAND ?? gemini?.command ?? 'gemini',
  args: process.env.NEXO_LIVE_ACP_ARGS?.split(' ').filter((a) => a !== '') ?? gemini?.args ?? [],
}

describe.skipIf(!live)('Agente ACP real', () => {
  it('abre una sesión, responde a un saludo y la anuncia', async () => {
    const provider = createAcpProvider({ agent, env: process.env })
    expect(await provider.isAvailable(), provider.unavailableReason?.()).toBe(true)
    const session = await provider.open({ cwd: process.cwd(), permissionMode: 'ask' })
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
