import type { MethodResult } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { LimitsOutput } from './schemas.ts'
import { makeEnv } from './test-helpers.ts'

const status = (): MethodResult<'limits.status'> => ({
  providers: [
    {
      provider: 'codex',
      status: 'ok',
      windows: [
        {
          id: 'primary',
          bucket: 'codex',
          usedPercent: 42.4,
          windowMinutes: 300,
          resetsAt: 4_102_444_800_000,
        },
        {
          id: 'secondary',
          bucket: 'codex',
          usedPercent: 100,
          windowMinutes: 10_080,
          state: 'limit',
        },
      ],
      reached: true,
      source: 'query',
      observedAt: 1_700_000_000_000,
      fresh: false,
    },
    {
      provider: 'claude',
      status: 'unknown',
      windows: [],
      reason: 'Claude Code aún no ha informado sus límites (solo los informa durante una sesión)',
    },
    {
      provider: 'ollama',
      status: 'unsupported',
      windows: [],
      reason: 'Ollama no ofrece límites de uso',
    },
  ],
})

describe('nexo limits', () => {
  it('muestra ventanas, origen, frescura y el estado de los proveedores sin datos', async () => {
    const env = makeEnv()
    env.client.handlers.set('limits.status', () => status())
    expect(await runCli(['limits'], env.deps)).toBe(0)
    expect(env.cap.out).toContain('codex primary: 42 % usado · ventana 5 h')
    expect(env.cap.out).toContain('ventana 7 d · LÍMITE ALCANZADO')
    expect(env.cap.out).toContain('origen: consulta directa')
    expect(env.cap.out).toContain('puede estar desactualizado')
    expect(env.cap.out).toContain('claude\n  desconocido')
    expect(env.cap.out).toContain('ollama\n  unsupported')
    expect(env.client.callsTo('limits.status')[0]).toEqual({})
  })

  it('--provider y --refresh llegan al método', async () => {
    const env = makeEnv()
    env.client.handlers.set('limits.status', () => ({ providers: [] }))
    expect(await runCli(['limits', '--provider', 'codex', '--refresh'], env.deps)).toBe(0)
    expect(env.client.callsTo('limits.status')[0]).toEqual({ provider: 'codex', refresh: true })
    expect(env.cap.out).toContain('no hay proveedores')
  })

  it('--json emite el resultado de limits.status, válido contra el esquema de salida', async () => {
    const env = makeEnv()
    env.client.handlers.set('limits.status', () => status())
    expect(await runCli(['limits', '--json'], env.deps)).toBe(0)
    const parsed = LimitsOutput.safeParse(JSON.parse(env.cap.out))
    expect(parsed.success).toBe(true)
  })

  it('rechaza argumentos de más con error de uso', async () => {
    const env = makeEnv()
    expect(await runCli(['limits', 'extra'], env.deps)).toBe(1)
    expect(env.cap.err).toContain('uso: nexo limits')
  })
})
