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

describe('parseEnv: memoria observacional (F3.5.2)', () => {
  it('apagada por omisión, sin resumidor ni umbrales propios', () => {
    expect(parseEnv({}).memory).toEqual({
      enabled: false,
      summarizer: undefined,
      observerTokens: undefined,
      reflectorTokens: undefined,
    })
    expect(parseEnv({ NEXO_MEMORY: '', NEXO_MEMORY_SUMMARIZER: '' }).memory.enabled).toBe(false)
  })

  it('NEXO_MEMORY acepta on/off, 1/0 y true/false', () => {
    for (const on of ['on', '1', 'true'])
      expect(parseEnv({ NEXO_MEMORY: on }).memory.enabled).toBe(true)
    for (const off of ['off', '0', 'false']) {
      expect(parseEnv({ NEXO_MEMORY: off }).memory.enabled).toBe(false)
    }
    for (const bad of ['yes', 'ON', '2', 'si']) {
      expect(() => parseEnv({ NEXO_MEMORY: bad }), bad).toThrow(/NEXO_MEMORY/)
    }
  })

  it('NEXO_MEMORY_SUMMARIZER: ollama:<modelo> (con ":" en el modelo) y provider:<id>[:<modelo>]', () => {
    const spec = (v: string) => parseEnv({ NEXO_MEMORY_SUMMARIZER: v }).memory.summarizer
    expect(spec('ollama:llama3.2:3b')).toEqual({ kind: 'ollama', model: 'llama3.2:3b' })
    expect(spec('provider:claude')).toEqual({ kind: 'provider', id: 'claude' })
    expect(spec('provider:claude:haiku')).toEqual({
      kind: 'provider',
      id: 'claude',
      model: 'haiku',
    })
    expect(spec('provider:gemini:gemini-2.5-flash')).toEqual({
      kind: 'provider',
      id: 'gemini',
      model: 'gemini-2.5-flash',
    })
    expect(spec('fake')).toEqual({ kind: 'fake' })
  })

  it('NEXO_MEMORY_SUMMARIZER rechaza lo mal formado', () => {
    for (const bad of [
      'ollama:',
      'ollama',
      'provider:',
      'provider::x',
      'provider:cl aude',
      'provider:claude:',
      'openai:gpt',
      'ollama:mod el',
      `ollama:${'a'.repeat(300)}`,
      'ollama:x\nollama:y',
    ]) {
      expect(() => parseEnv({ NEXO_MEMORY_SUMMARIZER: bad }), bad).toThrow(/NEXO_MEMORY_SUMMARIZER/)
    }
  })

  it('umbrales: enteros dentro de rango y el del Reflector al menos el doble del del Observador', () => {
    const m = parseEnv({
      NEXO_MEMORY_OBSERVER_TOKENS: '2000',
      NEXO_MEMORY_REFLECTOR_TOKENS: '20000',
    }).memory
    expect(m.observerTokens).toBe(2000)
    expect(m.reflectorTokens).toBe(20000)
    for (const bad of ['499', '200001', 'abc', '1.5', '-1']) {
      expect(() => parseEnv({ NEXO_MEMORY_OBSERVER_TOKENS: bad }), bad).toThrow(
        /NEXO_MEMORY_OBSERVER_TOKENS/,
      )
    }
    expect(() => parseEnv({ NEXO_MEMORY_REFLECTOR_TOKENS: '999' })).toThrow(
      /NEXO_MEMORY_REFLECTOR_TOKENS/,
    )
    expect(() =>
      parseEnv({ NEXO_MEMORY_OBSERVER_TOKENS: '9000', NEXO_MEMORY_REFLECTOR_TOKENS: '10000' }),
    ).toThrow(/al menos el doble/)
    // con el Observador por omisión (6000), el Reflector pide al menos 12000
    expect(() => parseEnv({ NEXO_MEMORY_REFLECTOR_TOKENS: '11000' })).toThrow(/al menos el doble/)
    expect(() => parseEnv({ NEXO_MEMORY_REFLECTOR_TOKENS: '12000' })).not.toThrow()
  })
})
