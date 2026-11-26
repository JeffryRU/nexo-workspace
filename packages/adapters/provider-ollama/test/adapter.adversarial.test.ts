import type { AgentProviderError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { createOllamaProvider } from '../src/provider.ts'
import { chunk, final, nd } from './fake-ollama.ts'
import { sleep, useFake, wait } from './helpers.ts'

const { fake, open, turnEnds, errors, textOf } = useFake()

const finished = async (events: Parameters<typeof turnEnds>[0], n = 1) =>
  wait(() => turnEnds(events).length >= n)

describe('respuestas hostiles de /api/chat', () => {
  it('NDJSON malformado entre líneas buenas: se ignora y el turno termina bien', async () => {
    fake.chatHandler = (_c, res) => {
      res.write('{"message": {"content": "a"\n')
      res.write('basura\n\n[1,2]\n')
      res.write(nd(chunk('b')))
      res.write('{"message":{"content":5},"done":"quizás"}\n')
      res.end(nd(final()))
    }
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    expect(textOf(events)).toBe('b')
    expect(turnEnds(events)[0]).toMatchObject({ stopReason: 'end-turn' })
    expect(errors(events)).toEqual([])
  })

  it('solo basura: no hay done, el turno acaba con error y no se guarda en el historial', async () => {
    fake.chatHandler = (_c, res) => res.end('basura\nmás basura\n')
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    expect(errors(events)[0]).toMatchObject({ code: 'STREAM_TRUNCATED' })
    expect(turnEnds(events)[0]).toMatchObject({ stopReason: 'error' })
  })

  it('una línea enorme (por encima del tope) corta la respuesta con un error', async () => {
    fake.chatHandler = (_c, res) => {
      res.write(nd(chunk('antes')))
      res.write(`{"message":{"content":"${'x'.repeat(200_000)}"}}\n`)
      res.write(nd(chunk('después'), final()))
      res.end()
    }
    const { session, events } = await open({ limits: { maxLineBytes: 64 * 1024 } })
    await session.send('x')
    await finished(events)
    expect(textOf(events)).toBe('antes')
    expect(errors(events)[0]).toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(turnEnds(events)).toHaveLength(1)
  })

  it('un campo de 600 KiB dentro del tope de línea sale en deltas válidos de a lo sumo 32 KiB', async () => {
    const big = 'ñ'.repeat(300_000)
    fake.chatHandler = (_c, res) => {
      res.write(nd(chunk(big), chunk('', { thinking: big })))
      res.end(nd(final()))
    }
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    const deltas = events.flatMap((e) => (e.type === 'block-delta' ? [e.text] : []))
    expect(deltas.length).toBeGreaterThan(30)
    for (const d of deltas)
      expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(32 * 1024)
    expect(deltas.join('')).toBe(big + big)
    expect(errors(events)).toEqual([])
  })

  it('cierre de la conexión a mitad de respuesta', async () => {
    fake.chatHandler = (_c, res) => {
      res.write(nd(chunk('parte')))
      setTimeout(() => res.destroy(), 20)
    }
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    expect(textOf(events)).toBe('parte')
    expect(errors(events)[0]).toMatchObject({ code: 'STREAM_FAILED', fatal: false })
    expect(turnEnds(events)[0]).toMatchObject({ stopReason: 'error' })
    // la sesión sigue usable
    fake.chatHandler = (_c, res) => res.end(nd(chunk('ya'), final()))
    await session.send('otra')
    await finished(events, 2)
    expect(fake.calls[1]?.messages).toEqual([{ role: 'user', content: 'otra' }])
  })

  it('cuerpo cortado en mitad de una línea JSON', async () => {
    fake.chatHandler = (_c, res) => {
      res.write(nd(chunk('uno')))
      res.end('{"message":{"content":"do')
    }
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    expect(textOf(events)).toBe('uno')
    expect(errors(events)[0]).toMatchObject({ code: 'STREAM_TRUNCATED' })
  })

  it('respuesta sin done pero con cierre limpio', async () => {
    fake.chatHandler = (_c, res) => res.end(nd(chunk('a'), chunk('b')))
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    expect(errors(events)[0]).toMatchObject({ code: 'STREAM_TRUNCATED', retryable: true })
    expect(turnEnds(events)).toHaveLength(1)
  })

  it('cuerpo vacío con 200', async () => {
    fake.chatHandler = (_c, res) => res.end()
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    expect(errors(events)[0]).toMatchObject({ code: 'STREAM_TRUNCATED' })
  })

  it('modelo inexistente (404): error claro y la sesión sigue viva', async () => {
    fake.chatHandler = (_c, res) => {
      res.statusCode = 404
      res.end('{"error":"model \'nada\' not found"}')
    }
    const { session, events } = await open({}, { model: 'nada' })
    await session.send('x')
    await finished(events)
    expect(errors(events)[0]).toMatchObject({ code: 'MODEL_NOT_FOUND' })
    expect(errors(events)[0]?.message).toMatch(/ollama pull nada/)
    expect(turnEnds(events)[0]).toMatchObject({ stopReason: 'error' })
  })

  it('error 500 y 400 por razonamiento no admitido', async () => {
    fake.chatHandler = (_c, res) => {
      res.statusCode = 500
      res.end('<html>\u001b[31mfallo interno\u0000</html>')
    }
    const a = await open()
    await a.session.send('x')
    await finished(a.events)
    expect(errors(a.events)[0]).toMatchObject({ code: 'OLLAMA_HTTP_ERROR', retryable: true })
    const message = errors(a.events)[0]?.message ?? ''
    expect([...message].some((c) => c.charCodeAt(0) < 0x20)).toBe(false)

    fake.chatHandler = (_c, res) => {
      res.statusCode = 400
      res.end('{"error":"\\"llama3.2\\" does not support thinking"}')
    }
    const b = await open({}, { effort: 'think' })
    await b.session.send('x')
    await finished(b.events)
    expect(errors(b.events)[0]).toMatchObject({ code: 'THINK_UNSUPPORTED' })
  })

  it('error dentro del flujo después de texto', async () => {
    fake.chatHandler = (_c, res) => res.end(nd(chunk('a'), { error: 'an error was encountered' }))
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    expect(textOf(events)).toBe('a')
    expect(errors(events)[0]).toMatchObject({ code: 'OLLAMA_ERROR' })
    expect(turnEnds(events)[0]).toMatchObject({ stopReason: 'error' })
  })

  it('una respuesta interminable se corta al llegar al tope del turno', async () => {
    fake.chatHandler = (_c, res) => {
      const timer = setInterval(() => res.write(nd(chunk('x'.repeat(1000)))), 1)
      res.on('close', () => clearInterval(timer))
    }
    const { session, events } = await open({ limits: { maxTurnBytes: 50_000 } })
    await session.send('x')
    await finished(events)
    expect(errors(events)[0]).toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
    await wait(() => fake.aborted === 1)
  })

  it('ráfaga de líneas rotas: se rinde en vez de quedarse leyendo', async () => {
    fake.chatHandler = (_c, res) => {
      res.write('x\n'.repeat(500))
      res.on('close', () => {})
    }
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    expect(errors(events)[0]).toMatchObject({ code: 'INVALID_RESPONSE' })
    await wait(() => fake.aborted === 1)
  })

  it('redirecciones: no se siguen', async () => {
    fake.chatHandler = (_c, res) => {
      res.statusCode = 302
      res.setHeader('location', 'http://127.0.0.1:1/robar')
      res.end()
    }
    const { session, events } = await open()
    await session.send('x')
    await finished(events)
    expect(errors(events)).toHaveLength(1)
    expect(turnEnds(events)[0]).toMatchObject({ stopReason: 'error' })
  })
})

describe('tiempos e interrupciones', () => {
  it('respuesta lenta + interrumpir: turn-end interrupted, se corta la conexión y se puede seguir', async () => {
    fake.chatHandler = (_c, res) => {
      const timer = setInterval(() => res.write(nd(chunk('.'))), 10)
      res.on('close', () => clearInterval(timer))
    }
    const { session, events } = await open()
    await session.send('x')
    await wait(() => textOf(events).length > 3)
    await session.interrupt()
    expect(turnEnds(events)).toHaveLength(1)
    expect(turnEnds(events)[0]).toMatchObject({ stopReason: 'interrupted' })
    await wait(() => fake.aborted === 1)
    const seen = events.length
    await sleep(60)
    expect(events).toHaveLength(seen)
    fake.chatHandler = (_c, res) => res.end(nd(chunk('listo'), final()))
    await session.send('otra')
    await finished(events, 2)
    expect(turnEnds(events)[1]).toMatchObject({ stopReason: 'end-turn' })
  })

  it('interrumpir mientras se espera la primera respuesta (servidor mudo)', async () => {
    fake.chatHandler = () => {}
    const { session, events } = await open()
    await session.send('x')
    await sleep(30)
    await session.interrupt()
    expect(turnEnds(events)).toEqual([{ type: 'turn-end', stopReason: 'interrupted' }])
    await wait(() => fake.aborted === 1)
  })

  it('servidor que no responde: el turno falla por falta de datos', async () => {
    fake.chatHandler = () => {}
    const { session, events } = await open({ limits: { idleTimeoutMs: 120 } })
    await session.send('x')
    await finished(events)
    expect(errors(events)[0]).toMatchObject({ code: 'TIMEOUT', retryable: true })
    expect(turnEnds(events)[0]).toMatchObject({ stopReason: 'error' })
  })

  it('servidor que deja de enviar a mitad: también expira', async () => {
    fake.chatHandler = (_c, res) => {
      res.write(nd(chunk('a')))
    }
    const { session, events } = await open({ limits: { idleTimeoutMs: 120 } })
    await session.send('x')
    await finished(events)
    expect(textOf(events)).toBe('a')
    expect(errors(events)[0]).toMatchObject({ code: 'TIMEOUT' })
  })

  it('un fetch que ignora la señal no impide interrumpir', async () => {
    const provider = createOllamaProvider({
      baseUrl: 'http://ollama.test',
      probeCacheMs: 0,
      fetch: (url) =>
        url.endsWith('/api/tags')
          ? Promise.resolve(new Response('{"models":[{"name":"m:1"}]}'))
          : new Promise<Response>(() => {}),
    })
    const session = await provider.open({ cwd: '/tmp' })
    const events: unknown[] = []
    session.onEvent((e) => events.push(e))
    await session.send('x')
    await session.interrupt()
    expect(events.filter((e) => (e as { type: string }).type === 'turn-end')).toEqual([
      { type: 'turn-end', stopReason: 'interrupted' },
    ])
    await session.close()
  })

  it('un fetch que rechaza da un error de conexión, no una excepción', async () => {
    const provider = createOllamaProvider({
      baseUrl: 'http://ollama.test',
      probeCacheMs: 0,
      fetch: (url) =>
        url.endsWith('/api/tags')
          ? Promise.resolve(new Response('{"models":[{"name":"m:1"}]}'))
          : Promise.reject(new TypeError('fetch failed')),
    })
    const session = await provider.open({ cwd: '/tmp' })
    const events: Parameters<typeof turnEnds>[0] = []
    session.onEvent((e) => events.push(e))
    await session.send('x')
    await finished(events)
    expect(errors(events)[0]).toMatchObject({ code: 'OLLAMA_UNREACHABLE', retryable: true })
    await session.close()
  })

  it('cerrar con un turno en curso: solo exit, sin más bloques ni turn-end', async () => {
    fake.chatHandler = (_c, res) => {
      res.write(nd(chunk('a')))
    }
    const { session, events } = await open()
    await session.send('x')
    await wait(() => textOf(events) === 'a')
    await session.close()
    await session.close()
    await sleep(40)
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
    expect(turnEnds(events)).toHaveLength(0)
    expect(events.at(-1)?.type).toBe('exit')
    const error = await session.send('y').catch((e: unknown) => e)
    expect((error as AgentProviderError).code).toBe('CLOSED')
    await wait(() => fake.aborted === 1)
  })

  it('enviar, interrumpir y enviar en ráfaga mantiene un turn-end por send', async () => {
    fake.chatHandler = (call, res) => {
      if (call.messages.length > 1) res.end(nd(chunk('fin'), final()))
    }
    const { session, events } = await open()
    await session.send('uno')
    const busy = await session.send('dos').catch((e: unknown) => e)
    expect((busy as AgentProviderError).code).toBe('BUSY')
    await Promise.all([session.interrupt(), session.interrupt(), session.interrupt()])
    expect(turnEnds(events)).toHaveLength(1)
    await session.send('tres')
    await finished(events, 2)
    await sleep(30)
    expect(turnEnds(events)).toHaveLength(2)
  })

  it('un oyente que lanza no rompe la sesión', async () => {
    const { session, events } = await open()
    session.onEvent(() => {
      throw new Error('oyente malo')
    })
    await session.send('x')
    await finished(events)
  })
})

describe('/api/tags hostil', () => {
  const prober = () =>
    createOllamaProvider({ baseUrl: fake.url, probeCacheMs: 0, probeTimeoutMs: 150 })

  it('que no conteste: available false dentro del plazo corto y sin lanzar', async () => {
    fake.tagsHandler = () => {}
    const provider = prober()
    const start = Date.now()
    expect(await provider.isAvailable()).toBe(false)
    expect(Date.now() - start).toBeLessThan(2000)
    expect(provider.unavailableReason?.()).toMatch(/no respondió/)
    expect((await provider.capabilities()).models).toEqual([])
  })

  it('500, no JSON, JSON con otra forma y redirecciones', async () => {
    const cases: [(res: import('node:http').ServerResponse) => void, RegExp][] = [
      [
        (r) => {
          r.statusCode = 500
          r.end('x')
        },
        /estado 500/,
      ],
      [(r) => r.end('<html>'), /no parece de Ollama/],
      [(r) => r.end('{"models":"no"}'), /no parece de Ollama/],
      [(r) => r.end('null'), /no parece de Ollama/],
      [
        (r) => {
          r.statusCode = 301
          r.setHeader('location', 'http://127.0.0.1:1/')
          r.end()
        },
        /no responde/,
      ],
    ]
    for (const [handler, reason] of cases) {
      fake.tagsHandler = handler
      const provider = prober()
      expect(await provider.isAvailable()).toBe(false)
      expect(provider.unavailableReason?.()).toMatch(reason)
    }
  })

  it('miles de modelos y nombres enormes: capacidades válidas y acotadas', async () => {
    fake.models = Array.from({ length: 1000 }, (_, i) => `m${i}:latest`).concat(['a'.repeat(5000)])
    const caps = await prober().capabilities()
    expect(caps.models.length).toBe(128)
  })
})
