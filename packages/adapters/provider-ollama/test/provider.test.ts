import { ProviderCapabilities } from '@nexo/contracts'
import type { AgentProviderError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { createOllamaProvider, parseOllamaUrl } from '../src/provider.ts'
import { chunk, final, nd } from './fake-ollama.ts'
import { sleep, useFake, wait } from './helpers.ts'

const { fake, open, turnEnds, errors, textOf } = useFake()

describe('parseOllamaUrl', () => {
  it('acepta http y https y quita la barra final', () => {
    expect(parseOllamaUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434')
    expect(parseOllamaUrl('https://ollama.local/api-base//')).toBe('https://ollama.local/api-base')
  })
  it('rechaza lo que no es http(s), lleva credenciales o parámetros', () => {
    for (const bad of [
      'ftp://x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://u:p@host',
      'http://host/?a=1',
      'http://host/#x',
      'no es url',
      '',
    ]) {
      expect(() => parseOllamaUrl(bad), bad).toThrow()
    }
  })
  it('createOllamaProvider lanza con una URL inválida', () => {
    expect(() => createOllamaProvider({ baseUrl: 'ws://x' })).toThrow()
  })
})

describe('capacidades y disponibilidad', () => {
  it('lista los modelos de /api/tags, el primero por omisión, sin resume ni permisos', async () => {
    const { provider } = await open()
    const caps = await provider.capabilities()
    expect(ProviderCapabilities.safeParse(caps).success).toBe(true)
    expect(caps.models.map((m) => m.id)).toEqual(['llama3.2:latest', 'qwen3:8b'])
    expect(caps).toMatchObject({
      defaultModel: 'llama3.2:latest',
      efforts: ['think', 'no-think'],
      permissionModes: ['ask'],
      resume: false,
      warmup: false,
      streaming: true,
    })
    expect(await provider.isAvailable()).toBe(true)
    expect(provider.unavailableReason?.()).toBeUndefined()
  })

  it('descarta nombres inválidos y repetidos', async () => {
    fake.models = ['ok:1', 'ok:1', 'con espacio', '', '../x', 'hf.co/user/model:Q4_K_M']
    const { provider } = await open()
    expect((await provider.capabilities()).models.map((m) => m.id)).toEqual([
      'ok:1',
      'hf.co/user/model:Q4_K_M',
    ])
  })

  it('sin modelos instalados: capacidades válidas sin modelo por omisión y open lo explica', async () => {
    fake.models = []
    const provider = createOllamaProvider({ baseUrl: fake.url, probeCacheMs: 0 })
    const caps = await provider.capabilities()
    expect(caps.models).toEqual([])
    expect(caps.defaultModel).toBeUndefined()
    const error = await provider.open({ cwd: '/tmp' }).catch((e: unknown) => e)
    expect((error as AgentProviderError).code).toBe('INVALID_OPTIONS')
    expect((error as Error).message).toMatch(/ollama pull/)
  })

  it('si Ollama no responde: available false con motivo y sin lanzar', async () => {
    const provider = createOllamaProvider({ baseUrl: 'http://127.0.0.1:1', probeCacheMs: 0 })
    expect(await provider.isAvailable()).toBe(false)
    expect(provider.unavailableReason?.()).toMatch(/Ollama no responde en http:\/\/127\.0\.0\.1:1/)
    const caps = await provider.capabilities()
    expect(ProviderCapabilities.safeParse(caps).success).toBe(true)
    expect(caps.models).toEqual([])
    const error = await provider.open({ cwd: '/tmp' }).catch((e: unknown) => e)
    expect((error as AgentProviderError).code).toBe('UNAVAILABLE')
  })

  it('reutiliza la comprobación dentro de probeCacheMs y la repite después', async () => {
    const provider = createOllamaProvider({ baseUrl: fake.url, probeCacheMs: 60 })
    const before = fake.tagsHits.length
    await Promise.all([provider.isAvailable(), provider.capabilities(), provider.isAvailable()])
    expect(fake.tagsHits.length - before).toBe(1)
    await provider.capabilities()
    expect(fake.tagsHits.length - before).toBe(1)
    await sleep(90)
    await provider.capabilities()
    expect(fake.tagsHits.length - before).toBe(2)
  })

  it('usa el fetch inyectado', async () => {
    const urls: string[] = []
    const provider = createOllamaProvider({
      baseUrl: 'http://ollama.test:1234/',
      fetch: async (url) => {
        urls.push(url)
        return new Response(JSON.stringify({ models: [{ name: 'x:1' }] }))
      },
    })
    expect((await provider.capabilities()).models).toEqual([{ id: 'x:1', label: 'x:1' }])
    expect(urls).toEqual(['http://ollama.test:1234/api/tags'])
  })
})

describe('open', () => {
  const code = async (p: Promise<unknown>) =>
    ((await p.catch((e: unknown) => e)) as AgentProviderError).code
  it('rechaza reanudar, modelo o esfuerzo inválidos y modos distintos de ask', async () => {
    const provider = createOllamaProvider({ baseUrl: fake.url, probeCacheMs: 0 })
    expect(await code(provider.open({ cwd: '/tmp', resume: 'ollama-abc' }))).toBe('INVALID_OPTIONS')
    expect(await code(provider.open({ cwd: '/tmp', model: 'con espacio' }))).toBe('INVALID_OPTIONS')
    expect(await code(provider.open({ cwd: '/tmp', effort: 'high' }))).toBe('INVALID_OPTIONS')
    expect(await code(provider.open({ cwd: '/tmp', permissionMode: 'bypass' }))).toBe(
      'INVALID_OPTIONS',
    )
    expect(await code(provider.open({ cwd: '' }))).toBe('INVALID_OPTIONS')
  })
  it('la ficha de sesión es propia y distinta en cada sesión', async () => {
    const a = await open()
    const b = await open()
    expect(a.session.providerSessionId).toMatch(/^ollama-/)
    expect(a.session.providerSessionId).not.toBe(b.session.providerSessionId)
  })
})

describe('turnos', () => {
  it('emite session-info, razonamiento, texto y uso; reenvía el historial en el segundo turno', async () => {
    const { session, events } = await open()
    await session.send('uno')
    await wait(() => turnEnds(events).length === 1)
    expect(events[0]).toMatchObject({
      type: 'session-info',
      model: 'llama3.2:latest',
      permissionMode: 'ask',
    })
    expect(events.find((e) => e.type === 'block-start')).toMatchObject({
      block: { type: 'reasoning' },
    })
    expect(textOf(events)).toBe('piensohola')
    expect(turnEnds(events)[0]).toMatchObject({
      stopReason: 'end-turn',
      usage: { inputTokens: 7, outputTokens: 3 },
    })
    await session.send('dos')
    await wait(() => turnEnds(events).length === 2)
    expect(events.filter((e) => e.type === 'session-info')).toHaveLength(1)
    expect(fake.calls[1]?.messages).toEqual([
      { role: 'user', content: 'uno' },
      { role: 'assistant', content: 'hola' },
      { role: 'user', content: 'dos' },
    ])
    expect(fake.calls[0]).toMatchObject({ model: 'llama3.2:latest', stream: true })
    expect('think' in (fake.calls[0] ?? {})).toBe(false)
  })

  it('el esfuerzo se traduce a think y el modelo elegido llega tal cual', async () => {
    const a = await open({}, { model: 'qwen3:8b', effort: 'think' })
    await a.session.send('x')
    await wait(() => turnEnds(a.events).length === 1)
    expect(fake.calls[0]).toMatchObject({ model: 'qwen3:8b', think: true })
    const b = await open({}, { effort: 'no-think' })
    await b.session.send('x')
    await wait(() => turnEnds(b.events).length === 1)
    expect(fake.calls[1]).toMatchObject({ think: false })
  })

  it('el historial tiene un tope en bytes: descarta lo más antiguo y conserva lo último', async () => {
    const { session, events } = await open({ limits: { maxHistoryBytes: 40 } })
    let n = 0
    for (const text of ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']) {
      await session.send(text)
      n++
      await wait(() => turnEnds(events).length === n)
    }
    const last = fake.calls[2]?.messages ?? []
    expect(last.at(-1)).toEqual({ role: 'user', content: 'cccccccccc' })
    expect(last.some((m) => m.content === 'aaaaaaaaaa')).toBe(false)
    expect(last[0]?.role).toBe('user')
    const bytes = last.reduce((n, m) => n + new TextEncoder().encode(m.content).length, 0)
    expect(bytes).toBeLessThanOrEqual(40)
  })

  it('un mensaje que no cabe en el tope se rechaza', async () => {
    const { session } = await open({ limits: { maxHistoryBytes: 10 } })
    const error = await session.send('x'.repeat(11)).catch((e: unknown) => e)
    expect((error as AgentProviderError).code).toBe('INVALID_OPTIONS')
  })

  it('un turno fallido retira la pregunta del historial para poder reintentar', async () => {
    const { session, events } = await open()
    fake.chatHandler = (_c, res) => {
      res.statusCode = 500
      res.end('{"error":"boom"}')
    }
    await session.send('primero')
    await wait(() => turnEnds(events).length === 1)
    expect(errors(events)[0]).toMatchObject({ code: 'OLLAMA_HTTP_ERROR', fatal: false })
    expect(turnEnds(events)[0]).toMatchObject({ stopReason: 'error' })
    fake.chatHandler = (_c, res) => {
      res.end(nd(chunk('ok'), final()))
    }
    await session.send('segundo')
    await wait(() => turnEnds(events).length === 2)
    expect(fake.calls[1]?.messages).toEqual([{ role: 'user', content: 'segundo' }])
  })

  it('tras interrumpir se conserva lo respondido hasta entonces', async () => {
    const { session, events } = await open()
    await session.send('long')
    await wait(() => textOf(events).includes('empiezo'))
    await session.interrupt()
    expect(turnEnds(events)).toHaveLength(1)
    await session.send('siguiente')
    await wait(() => turnEnds(events).length === 2)
    expect(fake.calls[1]?.messages).toEqual([
      { role: 'user', content: 'long' },
      { role: 'assistant', content: 'empiezo ' },
      { role: 'user', content: 'siguiente' },
    ])
  })

  it('respond rechaza siempre: no hay permisos ni preguntas', async () => {
    const { session } = await open()
    const error = await session
      .respond({ type: 'permission', requestId: 'x', optionId: 'y' })
      .catch((e: unknown) => e)
    expect((error as AgentProviderError).code).toBe('UNKNOWN_REQUEST')
  })
})
