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

  it('acepta ollama en la lista de proveedores', () => {
    expect(parseEnv({ NEXO_AGENT_PROVIDERS: 'claude,ollama' }).agentProviders).toEqual([
      'claude',
      'ollama',
    ])
  })

  it('acepta codex y lee NEXO_CODEX_EXECUTABLE', () => {
    expect(parseEnv({ NEXO_AGENT_PROVIDERS: 'claude,codex' }).agentProviders).toEqual([
      'claude',
      'codex',
    ])
    expect(parseEnv({}).codexExecutable).toBeUndefined()
    expect(parseEnv({ NEXO_CODEX_EXECUTABLE: '' }).codexExecutable).toBeUndefined()
    expect(parseEnv({ NEXO_CODEX_EXECUTABLE: '/opt/codex' }).codexExecutable).toBe('/opt/codex')
  })

  it('NEXO_OLLAMA_URL: por omisión local, solo http(s) y sin credenciales', () => {
    expect(parseEnv({}).ollamaUrl).toBe('http://127.0.0.1:11434')
    expect(parseEnv({ NEXO_OLLAMA_URL: '' }).ollamaUrl).toBe('http://127.0.0.1:11434')
    expect(parseEnv({ NEXO_OLLAMA_URL: 'https://gpu.local:8443/' }).ollamaUrl).toBe(
      'https://gpu.local:8443',
    )
    for (const bad of ['ftp://x', 'file:///x', 'http://u:p@h', 'nada', 'http://h/?a=1']) {
      expect(() => parseEnv({ NEXO_OLLAMA_URL: bad }), bad).toThrow(/NEXO_OLLAMA_URL/)
    }
  })

  it('lee la ruta del ejecutable de Claude Code', () => {
    expect(parseEnv({ NEXO_CLAUDE_EXECUTABLE: '/usr/bin/claude' }).claudeExecutable).toBe(
      '/usr/bin/claude',
    )
    expect(parseEnv({ NEXO_CLAUDE_EXECUTABLE: '' }).claudeExecutable).toBeUndefined()
  })
})
