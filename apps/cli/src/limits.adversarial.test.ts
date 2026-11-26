import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { makeEnv } from './test-helpers.ts'

describe('nexo limits: contenido hostil', () => {
  it('proveedores, etiquetas y motivos con secuencias de escape se sanean', async () => {
    const env = makeEnv()
    env.client.handlers.set('limits.status', () => ({
      providers: [
        {
          provider: 'codex',
          status: 'ok',
          windows: [
            { id: 'primary', label: '\u001b[31mroja\u001b[0m\u001b]0;pwned\u0007', usedPercent: 5 },
          ],
          source: 'session',
          reason: '\u001b[2Jfallo',
        },
      ],
    }))
    expect(await runCli(['limits'], env.deps)).toBe(0)
    expect(env.cap.out).not.toContain('\u001b')
    expect(env.cap.out).not.toContain('\u0007')
    expect(env.cap.out).toContain('roja')
  })
})
