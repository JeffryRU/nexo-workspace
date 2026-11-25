import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AgentPrinter } from './agent-render.ts'
import { runCli } from './cli.ts'
import { buildResponse } from './commands/agent.ts'
import { CliError } from './errors.ts'
import {
  agentHandlers,
  agentSession,
  blk,
  makeEnv,
  PERMISSION,
  QUESTION,
  SESSION_ID,
  type TestEnv,
} from './test-helpers.ts'
import { sanitizeMultiline } from './text.ts'

/** Caracteres de control (salvo salto y tabulador), separadores de línea y bidireccionales. */
const badChars = (s: string): string[] =>
  [...s].filter((ch) => {
    const c = ch.codePointAt(0) ?? 0
    return (
      (c < 0x20 && c !== 0x0a && c !== 0x09) ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202e
    )
  })

const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)
const text = (n: number, body: string, complete = true, seq = 0) =>
  blk(n, { type: 'text', text: body, complete, seq })

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error('tiempo agotado')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('nexo agent: entradas enormes y hostiles', () => {
  it('un mensaje por argumentos mayor que el máximo se rechaza sin llamar al daemon', async () => {
    const env = makeEnv()
    agentHandlers(env.client, () => [])
    const huge = 'x'.repeat(2 * 1024 * 1024)
    expect(await run(env, 'agent', 'send', SESSION_ID, huge)).toBe(1)
    expect(env.cap.err).toContain('supera el máximo')
    expect(env.client.callsTo('agent.send')).toHaveLength(0)
  })

  it('un mensaje enorme por stdin se rechaza igual', async () => {
    const env = makeEnv({
      stdin: async function* () {
        for (let i = 0; i < 40; i++) yield 'y'.repeat(100_000)
      },
    })
    agentHandlers(env.client, () => [])
    expect(await run(env, 'agent', 'send', SESSION_ID, '--stdin')).toBe(1)
    expect(env.client.callsTo('agent.send')).toHaveLength(0)
  })

  it('mensaje vacío o solo espacios, y referencias vacías o enormes', async () => {
    const env = makeEnv()
    agentHandlers(env.client, () => [])
    expect(await run(env, 'agent', 'send', SESSION_ID, '   ')).toBe(1)
    expect(await run(env, 'agent', 'close', '')).toBe(1)
    expect(await run(env, 'agent', 'close', 'a'.repeat(5000))).toBe(1)
    expect(env.client.callsTo('agent.close')).toHaveLength(0)
  })

  it('el texto del agente no cuela secuencias de escape en la terminal', async () => {
    const evil = text(0, 'hola\u001b[2J\u001b]0;pwn\u0007‮ fin\r\nsegunda\u0085línea')
    const action = blk(1, {
      type: 'action',
      kind: 'exec',
      status: 'ok',
      tool: 'Ba\u001bsh',
      title: 'ls\u001b[31m',
      output: '\u001b[2Jsalida\u0000\n',
      exitCode: 0,
    })
    const env = makeEnv()
    agentHandlers(env.client, () => [evil, action])
    expect(await run(env, 'agent', 'attach', SESSION_ID, '--no-follow')).toBe(0)
    expect(badChars(env.cap.out)).toEqual([])
    expect(env.cap.out).toContain('segunda')
  })

  it('un bloque gigante se imprime acotado', async () => {
    const env = makeEnv()
    agentHandlers(env.client, () => [text(0, 'a'.repeat(5_000_000))])
    expect(await run(env, 'agent', 'attach', SESSION_ID, '--no-follow')).toBe(0)
    expect(env.cap.out.length).toBeLessThan(250_000)
  })
})

describe('nexo agent attach: servidor hostil', () => {
  it('snapshot paginado con páginas cortas se recorre entero', async () => {
    const env = makeEnv()
    const all = Array.from({ length: 7 }, (_, n) => text(n, `bloque ${n}`))
    env.client.handlers.set('agent.list', () => ({ sessions: [agentSession()] }))
    env.client.handlers.set('agent.snapshot', (p) => {
      const from = (p as { fromIndex?: number }).fromIndex ?? 0
      const page = all.slice(from, from + 2)
      return {
        session: agentSession(),
        blocks: page,
        nextIndex: from + 2 < all.length ? from + 2 : null,
      }
    })
    expect(await run(env, 'agent', 'attach', SESSION_ID, '--no-follow')).toBe(0)
    for (let n = 0; n < 7; n++) expect(env.cap.out).toContain(`bloque ${n}`)
    expect(env.client.callsTo('agent.snapshot')).toHaveLength(4)
  })

  it('un nextIndex que no avanza termina con error, no en bucle', async () => {
    const env = makeEnv()
    env.client.handlers.set('agent.list', () => ({ sessions: [agentSession()] }))
    env.client.handlers.set('agent.snapshot', () => ({
      session: agentSession(),
      blocks: [],
      nextIndex: 0,
    }))
    expect(await run(env, 'agent', 'attach', SESSION_ID, '--no-follow')).toBe(4)
  })

  it('deltas repetidos o con hueco: se imprime una sola vez y se resincroniza', async () => {
    let truth = [text(0, 'Ho', false, 1)]
    const env = makeEnv({
      stdin: async function* () {},
    })
    agentHandlers(env.client, () => truth)
    const done = run(env, 'agent', 'attach', SESSION_ID, '--json')
    await until(() => env.client.listenerCount('agent.delta') > 0)
    const delta = (seq: number, t: string) =>
      env.client.emit('agent.delta', {
        sessionId: SESSION_ID as never,
        blockId: truth[0]?.id as never,
        field: 'text',
        seq,
        text: t,
      })
    delta(2, 'la')
    delta(2, 'la')
    delta(1, 'Ho')
    const snapshotsBefore = env.client.callsTo('agent.snapshot').length
    truth = [text(0, 'Hola mundo', true, 6)]
    delta(9, 'zzz')
    await until(() => env.client.callsTo('agent.snapshot').length > snapshotsBefore)
    await new Promise((r) => setTimeout(r, 20))
    env.abort.abort()
    expect(await done).toBe(0)
    const deltas = env.cap.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; text?: string })
      .filter((l) => l.event === 'delta')
    expect(deltas).toHaveLength(1)
  })

  it('el servidor corta en medio del streaming: salida 3 y cliente cerrado', async () => {
    const env = makeEnv()
    agentHandlers(env.client, () => [text(0, 'a', false)])
    const done = run(env, 'agent', 'attach', SESSION_ID)
    await until(() => env.client.listenerCount('state') > 0)
    env.client.emitState('closed')
    expect(await done).toBe(3)
    expect(env.client.closed).toBe(true)
  })

  it('respuestas inválidas por teclado reintentan sin llamar al daemon y luego se rinden', async () => {
    const env = makeEnv({
      stdin: async function* () {
        yield '9\nquizás\nnada\n'
      },
    })
    agentHandlers(env.client, () => [PERMISSION(0)])
    const done = run(env, 'agent', 'attach', SESSION_ID)
    await until(() => env.cap.err.split('opción no válida').length > 3)
    expect(env.client.callsTo('agent.respond')).toHaveLength(0)
    env.abort.abort()
    expect(await done).toBe(0)
  })
})

describe('buildResponse / sanitizeMultiline: propiedades', () => {
  it('cualquier entrada produce una respuesta válida o un error de uso, nunca otra excepción', () => {
    const blocks = [PERMISSION(0), QUESTION(1)]
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.constantFrom(0, 1), (input, which) => {
        try {
          const r = buildResponse(blocks[which] as never, input)
          expect(['permission', 'question']).toContain(r.type)
        } catch (error) {
          expect(error).toBeInstanceOf(CliError)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('el saneado multilínea no deja controles salvo salto y tabulador', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), (input) => {
        const out = sanitizeMultiline(input)
        expect(badChars(out)).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  it('el pintor nunca repite lo ya mostrado, sea cual sea la partición del texto', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 15 }), (parts) => {
        const printer = new AgentPrinter()
        let acc = ''
        let out = ''
        for (const p of parts) {
          acc += p
          out += printer.feed(text(0, acc, false))
          out += printer.feed(text(0, acc, false))
        }
        out += printer.feed(text(0, acc, true))
        out += printer.feed(text(0, acc, true))
        expect(out.replace(/\n$/, '')).toBe(sanitizeMultiline(acc).replace(/\n$/, ''))
      }),
      { numRuns: 200 },
    )
  })
})
