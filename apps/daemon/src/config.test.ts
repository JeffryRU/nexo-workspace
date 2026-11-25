import { describe, expect, it } from 'vitest'
import { parseEnv } from './config.ts'

describe('parseEnv: proveedores de agente', () => {
  it('por omisión solo claude y sin ejecutable propio', () => {
    const env = parseEnv({})
    expect(env.agentProviders).toEqual(['claude'])
    expect(env.claudeExecutable).toBeUndefined()
  })

  it('acepta una lista separada por comas, con espacios', () => {
    expect(parseEnv({ NEXO_AGENT_PROVIDERS: 'fake' }).agentProviders).toEqual(['fake'])
    expect(parseEnv({ NEXO_AGENT_PROVIDERS: ' claude , fake ' }).agentProviders).toEqual([
      'claude',
      'fake',
    ])
  })

  it('una cadena vacía vuelve al valor por omisión', () => {
    expect(parseEnv({ NEXO_AGENT_PROVIDERS: '' }).agentProviders).toEqual(['claude'])
  })

  it('rechaza nombres desconocidos, repetidos o listas vacías', () => {
    for (const bad of ['gpt', 'claude,claude', ',', 'claude,', 'FAKE', 'fake;claude']) {
      expect(() => parseEnv({ NEXO_AGENT_PROVIDERS: bad }), bad).toThrow(/NEXO_AGENT_PROVIDERS/)
    }
  })

  it('lee la ruta del ejecutable de Claude Code', () => {
    expect(parseEnv({ NEXO_CLAUDE_EXECUTABLE: '/usr/bin/claude' }).claudeExecutable).toBe(
      '/usr/bin/claude',
    )
    expect(parseEnv({ NEXO_CLAUDE_EXECUTABLE: '' }).claudeExecutable).toBeUndefined()
  })
})
