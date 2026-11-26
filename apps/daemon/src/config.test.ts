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

  it('acepta antigravity y lee NEXO_AGY_EXECUTABLE', () => {
    expect(parseEnv({ NEXO_AGENT_PROVIDERS: 'claude,antigravity' }).agentProviders).toEqual([
      'claude',
      'antigravity',
    ])
    expect(parseEnv({}).agyExecutable).toBeUndefined()
    expect(parseEnv({ NEXO_AGY_EXECUTABLE: '' }).agyExecutable).toBeUndefined()
    expect(parseEnv({ NEXO_AGY_EXECUTABLE: '/opt/agy' }).agyExecutable).toBe('/opt/agy')
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

  it('gemini existe por omisión y se acepta en NEXO_AGENT_PROVIDERS', () => {
    const env = parseEnv({ NEXO_AGENT_PROVIDERS: 'claude,gemini' })
    expect(env.agentProviders).toEqual(['claude', 'gemini'])
    expect(env.acpAgents).toEqual([
      { id: 'gemini', name: 'Gemini', command: 'gemini', args: ['--acp'] },
    ])
    expect(parseEnv({}).acpAgents.map((a) => a.id)).toEqual(['gemini'])
  })

  it('NEXO_ACP_AGENTS: los agentes declarados valen como proveedores y se validan', () => {
    const declared = JSON.stringify([
      { id: 'otro', name: 'Otro', command: 'otro-cli', args: ['--acp'] },
    ])
    const env = parseEnv({ NEXO_ACP_AGENTS: declared, NEXO_AGENT_PROVIDERS: 'gemini,otro' })
    expect(env.agentProviders).toEqual(['gemini', 'otro'])
    expect(env.acpAgents.map((a) => a.id)).toEqual(['gemini', 'otro'])
    expect(parseEnv({ NEXO_ACP_AGENTS: '' }).acpAgents.map((a) => a.id)).toEqual(['gemini'])
    // Un id sin declarar sigue siendo desconocido.
    expect(() => parseEnv({ NEXO_AGENT_PROVIDERS: 'otro' })).toThrow(/NEXO_AGENT_PROVIDERS/)
    for (const bad of [
      '{',
      '[{"id":"claude","name":"x","command":"x"}]',
      '[{"id":"a","name":"x","command":"x"},{"id":"a","name":"y","command":"y"}]',
      '[{"id":"A b","name":"x","command":"x"}]',
      '[{"id":"a","name":"x"}]',
    ]) {
      expect(() => parseEnv({ NEXO_ACP_AGENTS: bad }), bad).toThrow(/NEXO_ACP_AGENTS/)
    }
  })

  it('declarar «gemini» sustituye el agente por omisión', () => {
    const env = parseEnv({
      NEXO_ACP_AGENTS: JSON.stringify([{ id: 'gemini', name: 'Mi Gemini', command: '/x/gemini' }]),
    })
    expect(env.acpAgents).toEqual([
      { id: 'gemini', name: 'Mi Gemini', command: '/x/gemini', args: [] },
    ])
  })
})
