import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { AgentActionOutput, MemoryConfigureOutput } from './schemas.ts'
import { agentHandlers, makeEnv, SESSION_ID, type TestEnv } from './test-helpers.ts'

const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)

function setup(): TestEnv {
  const env = makeEnv()
  env.client.handlers.set('memory.configure', (p) => {
    const params = p as { enabled?: boolean; renewAtTokens?: number | null }
    return {
      enabled: params.enabled ?? true,
      ...(typeof params.renewAtTokens === 'number' ? { renewAtTokens: params.renewAtTokens } : {}),
    }
  })
  return env
}

describe('nexo memory config', () => {
  it('--on y --renew-at mandan los ajustes y los cuentan', async () => {
    const env = setup()
    expect(await run(env, 'memory', 'config', '--on', '--renew-at', '50000')).toBe(0)
    expect(env.client.callsTo('memory.configure')).toEqual([
      { enabled: true, renewAtTokens: 50_000 },
    ])
    expect(env.cap.out).toContain('Memoria: activada')
    expect(env.cap.out).toContain('a ~50000 tokens')
  })

  it('--off y --renew-at off; --json emite el resultado validado', async () => {
    const env = setup()
    expect(await run(env, 'memory', 'config', '--off', '--renew-at', 'off', '--json')).toBe(0)
    expect(env.client.callsTo('memory.configure')).toEqual([
      { enabled: false, renewAtTokens: null },
    ])
    expect(MemoryConfigureOutput.parse(JSON.parse(env.cap.out))).toEqual({ enabled: false })
  })

  it('sin opciones, con --on y --off a la vez o con valores fuera de rango es un error de uso', async () => {
    for (const args of [
      ['memory', 'config'],
      ['memory', 'config', '--on', '--off'],
      ['memory', 'config', '--renew-at', '9999'],
      ['memory', 'config', '--renew-at', '5000001'],
      ['memory', 'config', '--renew-at', 'mucho'],
      ['memory', 'config', '--renew-at', '-5'],
      ['memory', 'config', 'sobra', '--on'],
    ]) {
      const env = setup()
      expect(await run(env, ...args), args.join(' ')).toBe(1)
      expect(env.client.callsTo('memory.configure')).toEqual([])
    }
  })
})

describe('nexo agent renew', () => {
  it('llama a agent.renew con la sesión (id o prefijo) y lo cuenta', async () => {
    const env = makeEnv()
    agentHandlers(env.client, () => [])
    env.client.handlers.set('agent.renew', () => ({}))
    expect(await run(env, 'agent', 'renew', SESSION_ID, '--json')).toBe(0)
    expect(AgentActionOutput.parse(JSON.parse(env.cap.out)).action).toBe('renew')
    expect(env.client.callsTo('agent.renew')).toEqual([{ sessionId: SESSION_ID }])
    const plain = makeEnv()
    agentHandlers(plain.client, () => [])
    plain.client.handlers.set('agent.renew', () => ({}))
    expect(await run(plain, 'agent', 'renew', SESSION_ID)).toBe(0)
    expect(plain.cap.out).toContain('renovada')
  })

  it('sesión inexistente: salida 2', async () => {
    const env = makeEnv()
    agentHandlers(env.client, () => [])
    expect(await run(env, 'agent', 'renew', 'zzz')).toBe(2)
  })
})
