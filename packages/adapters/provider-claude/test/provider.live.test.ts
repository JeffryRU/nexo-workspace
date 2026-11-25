import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createClaudeProvider } from '../src/provider.ts'

/**
 * Prueba real contra Claude Code: solo con `NEXO_LIVE_CLAUDE=1` (y credenciales propias en el entorno:
 * ANTHROPIC_API_KEY o CLAUDE_CODE_OAUTH_TOKEN). No corre en el CI ni en `pnpm check`: se lanza con
 * `pnpm --filter @nexo/adapter-provider-claude test:live`. Un modelo pequeño y un prompt trivial.
 */
const live = process.env.NEXO_LIVE_CLAUDE === '1'

describe.skipIf(!live)('proveedor Claude (real)', () => {
  it('responde a un saludo con texto, un turn-end y un id de sesión reanudable', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexo-live-'))
    const provider = createClaudeProvider({ checkCwd: true })
    try {
      expect(await provider.isAvailable()).toBe(true)
      const session = await provider.open({ cwd, model: 'haiku', permissionMode: 'plan' })
      const events: ProviderEvent[] = []
      session.onEvent((e) => events.push(e))
      await session.send('Responde solo con la palabra: hola')
      const start = Date.now()
      while (!events.some((e) => e.type === 'turn-end' || e.type === 'exit')) {
        if (Date.now() - start > 90_000) throw new Error('sin respuesta en 90 s')
        await new Promise((r) => setTimeout(r, 100))
      }
      const errors = events.filter((e) => e.type === 'error')
      expect(errors, JSON.stringify(errors)).toEqual([])
      expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1)
      const text = events
        .filter((e) => e.type === 'block-delta' && e.field === 'text')
        .map((e) => (e.type === 'block-delta' ? e.text : ''))
        .join('')
      expect(text.toLowerCase()).toContain('hola')
      await session.close()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 120_000)
})
