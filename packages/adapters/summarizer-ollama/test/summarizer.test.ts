import { SummarizerError } from '@nexo/core'
import { sampleObserveRequest, sampleReflectRequest } from '@nexo/testkit'
import { runSummarizerConformance } from '@nexo/testkit/conformance'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OllamaSummarizer, parseOllamaBaseUrl } from '../src/index.ts'
import { FakeOllama, sensibleChat } from './fake-ollama.ts'

const fake = new FakeOllama()
beforeAll(async () => {
  await fake.start()
})
afterAll(() => fake.stop())

const make = (over: Partial<ConstructorParameters<typeof OllamaSummarizer>[0]> = {}) =>
  new OllamaSummarizer({ model: 'llama3.2:3b', baseUrl: fake.url, ...over })

async function failure(promise: Promise<unknown>): Promise<SummarizerError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SummarizerError)
    return error as SummarizerError
  }
  throw new Error('debía fallar')
}

runSummarizerConformance('OllamaSummarizer (servidor HTTP falso)', () => {
  fake.chatHandler = sensibleChat
  return { summarizer: make() }
})

describe('OllamaSummarizer', () => {
  it('pide /api/chat sin streaming, con JSON, mensaje de sistema y de usuario y ventana de contexto', async () => {
    fake.chatHandler = sensibleChat
    fake.calls.length = 0
    await make().summarize(sampleObserveRequest())
    const call = fake.calls[0]
    expect(fake.paths.at(-1)).toBe('POST /api/chat')
    expect(call?.model).toBe('llama3.2:3b')
    expect(call?.stream).toBe(false)
    expect(call?.format).toBe('json')
    expect(call?.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(call?.messages[0]?.content).toContain('Observador')
    expect(call?.messages[1]?.content).toContain('<transcripcion sesion="s1"')
    expect(call?.options?.temperature).toBeLessThan(0.5)
    expect(call?.options?.num_ctx).toBeGreaterThanOrEqual(4096)
    expect(call?.options?.num_ctx).toBeLessThanOrEqual(65_536)
  })

  it('observar devuelve observaciones estructuradas y el uso real de Ollama', async () => {
    fake.chatHandler = sensibleChat
    const r = await make().summarize(sampleObserveRequest())
    expect(r.kind).toBe('observe')
    if (r.kind !== 'observe') return
    expect(r.content).toEqual({
      format: 'observations',
      observations: [
        { priority: 'high', scope: 'project', text: '2026-11-26 el proyecto usa pnpm' },
        { priority: 'medium', scope: 'session', text: '2026-11-26 se añadieron pruebas' },
      ],
    })
    expect(r.usage).toEqual({
      model: 'llama3.2:3b',
      inputTokens: 321,
      outputTokens: 45,
      costUsd: 0,
      durationMs: 1500,
    })
  })

  it('reflexionar no pide JSON y devuelve el texto', async () => {
    fake.chatHandler = sensibleChat
    fake.calls.length = 0
    const r = await make().summarize(sampleReflectRequest())
    expect(r).toMatchObject({ kind: 'reflect', text: expect.stringContaining('pnpm y vitest') })
    expect(fake.calls[0]?.format).toBeUndefined()
    expect(fake.calls[0]?.messages[0]?.content).toContain('Reflector')
  })

  it('con json: false pide líneas de texto y no manda format', async () => {
    fake.chatHandler = sensibleChat
    fake.calls.length = 0
    const r = await make({ json: false }).summarize(sampleObserveRequest())
    expect(fake.calls[0]?.format).toBeUndefined()
    expect(r).toMatchObject({
      kind: 'observe',
      content: { format: 'text', text: expect.stringContaining('[alta]') },
    })
  })

  it('si el modelo no respeta el JSON, se lee su salida como texto', async () => {
    fake.chatHandler = (call, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          message: { role: 'assistant', content: '- [media] [sesion] sale en texto plano' },
          done: true,
        }),
      )
      void call
    }
    const r = await make().summarize(sampleObserveRequest())
    expect(r).toMatchObject({
      kind: 'observe',
      content: { format: 'text', text: '- [media] [sesion] sale en texto plano' },
    })
    // sin contadores de Ollama, el uso conserva el modelo y una duración medida
    expect(r.usage.model).toBe('llama3.2:3b')
    expect(r.usage.inputTokens).toBeUndefined()
    expect(r.usage.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('errores HTTP: 404 modelo ausente (no retryable), 5xx y 429 retryable, 400 salida inválida', async () => {
    const status =
      (code: number, body: unknown = { error: 'algo\u0000 salió\nmal' }) =>
      (_call: unknown, res: import('node:http').ServerResponse) => {
        res.statusCode = code
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }
    fake.chatHandler = status(404, { error: 'model "x" not found, try pulling it first' })
    const notFound = await failure(make().summarize(sampleObserveRequest()))
    expect(notFound).toMatchObject({ code: 'UNAVAILABLE', retryable: false })
    expect(notFound.message).toContain('no está instalado')
    expect(notFound.message).toContain('try pulling it first')
    for (const code of [500, 503, 429, 408]) {
      fake.chatHandler = status(code)
      const e = await failure(make().summarize(sampleObserveRequest()))
      expect(e, String(code)).toMatchObject({ code: 'UNAVAILABLE', retryable: true })
      // el texto del servidor llega saneado: sin controles ni saltos
      expect(e.message.includes(String.fromCharCode(0))).toBe(false)
      expect(e.message.includes(String.fromCharCode(10))).toBe(false)
    }
    fake.chatHandler = status(400)
    expect(await failure(make().summarize(sampleObserveRequest()))).toMatchObject({
      code: 'INVALID_OUTPUT',
      retryable: false,
    })
  })

  it('un servidor caído es UNAVAILABLE retryable', async () => {
    const dead = new FakeOllama()
    await dead.start()
    const url = dead.url
    await dead.stop()
    const e = await failure(make({ baseUrl: url }).summarize(sampleObserveRequest()))
    expect(e).toMatchObject({ code: 'UNAVAILABLE', retryable: true })
  })

  it('una respuesta que no es JSON, con otra forma o vacía es INVALID_OUTPUT', async () => {
    const reply = (body: string) => (_c: unknown, res: import('node:http').ServerResponse) => {
      res.setHeader('content-type', 'application/json')
      res.end(body)
    }
    for (const body of [
      'no es json',
      '{}',
      '{"message":{"content":5}}',
      '{"message":null}',
      '[]',
      'null',
      JSON.stringify({ message: { role: 'assistant', content: '   ' }, done: true }),
    ]) {
      fake.chatHandler = reply(body)
      const e = await failure(make().summarize(sampleObserveRequest()))
      expect(e.code, body).toBe('INVALID_OUTPUT')
      expect(e.retryable).toBe(false)
    }
  })

  it('un cuerpo que pasa del tope se corta con INVALID_OUTPUT', async () => {
    fake.chatHandler = (_c, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'x'.repeat(5000) } }))
    }
    const e = await failure(make({ maxResponseBytes: 1000 }).summarize(sampleObserveRequest()))
    expect(e.code).toBe('INVALID_OUTPUT')
  })

  it('un servidor que no contesta a tiempo: TIMEOUT retryable', async () => {
    fake.chatHandler = () => {}
    const e = await failure(make({ timeoutMs: 80 }).summarize(sampleObserveRequest()))
    expect(e).toMatchObject({ code: 'TIMEOUT', retryable: true })
  })

  it('cancelar con la señal corta la petición: ABORTED', async () => {
    fake.chatHandler = () => {}
    const listeners: (() => void)[] = []
    const signal = {
      aborted: false,
      addEventListener: (_t: 'abort', l: () => void) => void listeners.push(l),
      removeEventListener: () => {},
    }
    const pending = failure(make().summarize(sampleObserveRequest(), { signal }))
    await new Promise((r) => setTimeout(r, 40))
    signal.aborted = true
    for (const l of listeners) l()
    const e = await pending
    expect(e).toMatchObject({ code: 'ABORTED', retryable: false })
  })

  it('una petición que no cabe en la ventana falla con TOO_LARGE sin llamar al servidor', async () => {
    fake.calls.length = 0
    const big = sampleObserveRequest({ transcript: `[#0] usuario: ${'palabra '.repeat(60_000)}` })
    const e = await failure(make({ maxContextTokens: 8192 }).summarize(big))
    expect(e).toMatchObject({ code: 'TOO_LARGE', retryable: false })
    expect(fake.calls).toHaveLength(0)
  })

  it('no sigue redirecciones', async () => {
    fake.chatHandler = (_c, res) => {
      res.statusCode = 302
      res.setHeader('location', 'http://127.0.0.1:1/robar')
      res.end()
    }
    const e = await failure(make().summarize(sampleObserveRequest()))
    expect(e.code).toBe('UNAVAILABLE')
  })

  it('isAvailable: modelo instalado, con ":latest" implícito, ausente o servidor caído', async () => {
    fake.tagsHandler = undefined
    expect(await make().isAvailable()).toBe(true)
    expect(await make({ model: 'qwen3' }).isAvailable()).toBe(true)
    expect(await make({ model: 'otro:7b' }).isAvailable()).toBe(false)
    fake.tagsHandler = (res) => {
      res.statusCode = 500
      res.end('{}')
    }
    expect(await make().isAvailable()).toBe(false)
    fake.tagsHandler = (res) => {
      res.end('no es json')
    }
    expect(await make().isAvailable()).toBe(false)
    fake.tagsHandler = (res) => {
      res.end('{"models":5}')
    }
    expect(await make().isAvailable()).toBe(false)
    fake.tagsHandler = undefined
    const dead = new FakeOllama()
    await dead.start()
    const url = dead.url
    await dead.stop()
    expect(await make({ baseUrl: url }).isAvailable()).toBe(false)
  })

  it('el id lleva el modelo', () => {
    expect(make().id).toBe('ollama:llama3.2:3b')
  })
})

describe('parseOllamaBaseUrl', () => {
  it('acepta http(s), quita la barra final y rechaza credenciales, otros esquemas y parámetros', () => {
    expect(parseOllamaBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434')
    expect(parseOllamaBaseUrl('https://gpu.local:8443/ollama//')).toBe(
      'https://gpu.local:8443/ollama',
    )
    for (const bad of [
      'no url',
      'file:///etc/passwd',
      'ftp://x',
      'http://u:p@x',
      'http://x?a=1',
      'http://x#f',
    ]) {
      expect(() => parseOllamaBaseUrl(bad), bad).toThrow()
    }
    expect(() => new OllamaSummarizer({ model: 'm', baseUrl: 'file:///x' })).toThrow()
  })
})
