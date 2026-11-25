import { LIMITS, ProviderEvent, utf8ByteLength } from '@nexo/contracts'
import * as kit from '@nexo/testkit'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ClaudeTranslator } from '../src/translator.ts'
import { bootClaude } from './boot.ts'
import {
  messageStart,
  result,
  streamStart,
  streamStop,
  streamText,
  toolResult,
  toolUse,
  translateAll,
  types,
} from './helpers.ts'
import { setup, useCleanup, wait } from './setup.ts'

useCleanup()

const allValid = (events: readonly unknown[]) => {
  for (const e of events) expect(ProviderEvent.safeParse(e).success, JSON.stringify(e)).toBe(true)
}

describe('SDK hostil: mensajes rotos, desconocidos y fuera de orden', () => {
  it('basura arbitraria nunca lanza ni produce un evento inválido', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 30 }), (messages) => {
        const t = new ClaudeTranslator()
        t.beginTurn()
        const events = messages.flatMap((m) => t.translate(m))
        allValid(events)
      }),
    )
  })

  const kinds = ['stream_event', 'assistant', 'user', 'result', 'system', 'auth_status']
  it('mensajes de tipos conocidos con campos al azar tampoco rompen nada', () => {
    const arbMessage = fc.record({
      type: fc.constantFrom(...kinds, 'otro'),
      subtype: fc.option(fc.constantFrom('init', 'success', 'error_during_execution', 'x'), {
        nil: undefined,
      }),
      parent_tool_use_id: fc.option(fc.constantFrom(null, 'p'), { nil: undefined }),
      error: fc.option(fc.constantFrom('authentication_failed', 'rate_limit', 'nuevo'), {
        nil: undefined,
      }),
      event: fc.option(
        fc.record({
          type: fc.constantFrom(
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
          ),
          index: fc.oneof(fc.nat(3), fc.constant(-1), fc.constant('x')),
          content_block: fc.option(
            fc.record({
              type: fc.constantFrom('text', 'thinking', 'tool_use', 'raro'),
              id: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
              name: fc.option(
                fc.constantFrom('Bash', 'TodoWrite', 'AskUserQuestion', '__proto__'),
                { nil: undefined },
              ),
            }),
            { nil: undefined },
          ),
          delta: fc.option(
            fc.record({
              type: fc.constantFrom('text_delta', 'thinking_delta', 'input_json_delta'),
              text: fc.string({ maxLength: 10 }),
              partial_json: fc.string({ maxLength: 10 }),
            }),
            { nil: undefined },
          ),
        }),
        { nil: undefined },
      ),
      message: fc.option(
        fc.record({
          id: fc.option(fc.string({ maxLength: 4 }), { nil: undefined }),
          content: fc.oneof(
            fc.array(
              fc.record({
                type: fc.constantFrom('text', 'tool_use', 'tool_result', 'thinking'),
                text: fc.string({ maxLength: 10 }),
                id: fc.string({ maxLength: 3 }),
                tool_use_id: fc.string({ maxLength: 3 }),
                name: fc.constantFrom('Edit', 'Write', 'MultiEdit', 'TodoWrite'),
                input: fc.jsonValue(),
                is_error: fc.boolean(),
              }),
              { maxLength: 3 },
            ),
            fc.string(),
          ),
        }),
        { nil: undefined },
      ),
      is_error: fc.option(fc.boolean(), { nil: undefined }),
      result: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
      total_cost_usd: fc.option(fc.oneof(fc.double(), fc.constant(-1), fc.constant(Number.NaN)), {
        nil: undefined,
      }),
    })
    fc.assert(
      fc.property(fc.array(arbMessage, { maxLength: 40 }), (messages) => {
        const t = new ClaudeTranslator()
        for (let round = 0; round < 3; round++) {
          t.beginTurn()
          allValid(messages.flatMap((m) => t.translate(m)))
          allValid(t.abandonTurn('interrupted'))
        }
      }),
      { numRuns: 200 },
    )
  })

  it('un tipo de mensaje nuevo o un campo nuevo se ignora sin consecuencias', () => {
    const { events, translator } = translateAll([
      { type: 'mensaje_del_futuro', x: 1 },
      { type: 'system', subtype: 'algo_nuevo', session_id: 's' },
      { type: 'rate_limit_event' },
      { type: 'tool_progress' },
      { ...result(), campo_nuevo: { a: 1 } },
    ])
    expect(types(events)).toEqual(['turn-end'])
    expect(translator.stats.ignored).toBe(4)
  })

  it('cadenas, nulos, arrays y números como mensajes se ignoran', () => {
    const { events } = translateAll(['{"type":"result"', null, [], 42, undefined, true, '', {}])
    expect(events).toEqual([])
  })

  it('JSON de herramienta cortado o enorme no rompe: la acción sigue y se cierra', () => {
    const start = (name: string, id: string) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name, input: {} },
      },
    })
    const json = (s: string) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: s },
      },
    })
    const { events, translator } = translateAll([
      start('Bash', 'b1'),
      json('{"command": "ls'),
      streamStop(0),
      start('Write', 'w1'),
      json(`{"file_path":"/x","content":"${'z'.repeat(2 * 1024 * 1024)}"}`),
      json('"}'),
      streamStop(0),
      toolResult('b1', 'ok'),
      result(),
    ])
    expect(translator.stats.invalid).toBeGreaterThan(0)
    const ends = events.filter((e) => e.type === 'block-end')
    expect(ends).toHaveLength(2)
  })

  it('tool_use repetido, índice repetido y eventos de subagentes no duplican bloques', () => {
    const { events } = translateAll([
      messageStart(),
      streamStart('text', 0),
      streamStart('text', 0),
      { ...streamText('x'), parent_tool_use_id: 'sub' },
      streamText('a'),
      streamStop(0),
      streamStop(0),
      toolUse('dup', 'Read', { file_path: '/a' }),
      toolUse('dup', 'Read', { file_path: '/a' }),
      toolResult('dup', 'uno'),
      toolResult('dup', 'dos'),
      result(),
    ])
    expect(events.filter((e) => e.type === 'block-start')).toHaveLength(2)
    const refs = events.filter((e) => e.type === 'block-start').map((e) => e.ref)
    expect(new Set(refs).size).toBe(refs.length)
    expect(events.filter((e) => e.type === 'block-end')).toHaveLength(2)
    allValid(events)
  })

  it('un result suelto, repetido o antes de empezar no cuenta como fin de turno', () => {
    const t = new ClaudeTranslator()
    expect(t.translate(result())).toEqual([])
    t.beginTurn()
    expect(types(t.translate(result()))).toEqual(['turn-end'])
    expect(t.translate(result())).toEqual([])
  })

  it('claves peligrosas en la entrada de una herramienta son inertes', () => {
    const { events } = translateAll([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm',
          content: [
            {
              type: 'tool_use',
              id: '__proto__',
              name: '__proto__',
              input: JSON.parse('{"__proto__":{"x":1},"file_path":"/a"}'),
            },
            { type: 'tool_use', id: 'constructor', name: 'constructor', input: { constructor: 1 } },
          ],
        },
      },
      toolResult('__proto__', 'a'),
      result(),
    ])
    allValid(events)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('TodoWrite enorme o inválido: plan acotado o ignorado', () => {
    const todos = Array.from({ length: 400 }, (_, i) => ({
      content: `tarea ${i}`,
      status: 'pending',
    }))
    const { events } = translateAll([
      toolUse('p1', 'TodoWrite', { todos }),
      toolUse('p2', 'TodoWrite', {
        todos: [
          { content: '', status: 'pending' },
          { content: 'x', status: 'raro' },
        ],
      }),
      toolUse('p3', 'TodoWrite', 'no'),
      result(),
    ])
    const plan = events.find((e) => e.type === 'block-start' && e.block.type === 'plan')
    expect(
      plan?.type === 'block-start' && plan.block.type === 'plan' && plan.block.entries.length,
    ).toBe(LIMITS.maxPlanEntries)
    allValid(events)
  })

  it('más llamadas de las que se siguen en un turno: las sobrantes no abren bloque', () => {
    const calls = Array.from({ length: 700 }, (_, i) => toolUse(`c${i}`, 'Bash', { command: 'x' }))
    const { events } = translateAll([...calls, result()])
    expect(events.filter((e) => e.type === 'block-start')).toHaveLength(512)
    allValid(events)
  })
})

describe('textos hostiles', () => {
  it('NUL, sustitutos sueltos y control salen como texto válido', () => {
    const { events } = translateAll([
      streamStart('text', 0),
      streamText('a\u0000b\ud800c\udc00d\u001b[0m '),
      streamStop(0),
      toolUse('x', 'Bash', {
        command: 'echo\u0000\nhi\ud800',
        description: '\u0007\n  títu\u0000lo  ',
      }),
      toolResult('x', 'sal\u0000ida\ud83d'),
      result(),
    ])
    allValid(events)
    const title = events.find((e) => e.type === 'block-update')
    expect(
      title?.type === 'block-update' && title.block.type === 'action' && title.block.title,
    ).toBe('títu�lo')
  })

  it('un delta enorme se parte en trozos válidos sin separar un par', () => {
    const big = '😀'.repeat(300_000) // 1,2 MB
    const { events } = translateAll([
      streamStart('text', 0),
      streamText(big),
      streamStop(0),
      result(),
    ])
    allValid(events)
    const deltas = events.filter((e) => e.type === 'block-delta')
    expect(deltas.length).toBeGreaterThan(30)
    for (const d of deltas) expect(utf8ByteLength(d.text)).toBeLessThanOrEqual(LIMITS.maxDeltaBytes)
    expect(deltas.map((d) => d.text).join('')).toBe(big)
  })

  it('una salida de herramienta gigante se recorta y queda marcada', () => {
    const { events } = translateAll([
      toolUse('big', 'Bash', { command: 'cat gordo' }),
      toolResult('big', 'x'.repeat(5 * 1024 * 1024)),
      result(),
    ])
    allValid(events)
    const end = events.find((e) => e.type === 'block-end' && e.block?.type === 'action')
    expect(end?.type === 'block-end' && end.block?.type === 'action' && end.block.truncated).toBe(
      true,
    )
  })

  it('una pregunta con textos enormes o con caracteres de control se normaliza', async () => {
    const { session, events, fake } = await setup()
    await session.send('long')
    void fake.ask({
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: `¿${'p'.repeat(10_000)}?\u0000`,
            header: 'cabecera\nlarguísima de más de doce',
            multiSelect: false,
            options: Array.from({ length: 30 }, (_, i) => ({
              label: `op\n${i}`,
              description: `d\u0007${i}`,
            })),
          },
        ],
      },
    })
    await wait(() =>
      events.some((e) => e.type === 'question-request' || e.type === 'request-cancelled'),
    )
    allValid(events)
    expect(events.some((e) => e.type === 'question-request')).toBe(true)
  })
})

describe('procesos hostiles y carreras', () => {
  it('proceso colgado a mitad de herramienta: interrumpir cierra el turno y close termina', async () => {
    const { session, events, fake } = await setup()
    fake.onInterrupt = () => new Promise(() => {})
    await session.send('long')
    fake.emit(toolUse('slow', 'Bash', { command: 'sleep 1000' }))
    await wait(() => events.some((e) => e.type === 'block-start'))
    await session.interrupt()
    await wait(() => events.some((e) => e.type === 'turn-end'))
    const t = types(events)
    expect(t.lastIndexOf('block-end')).toBeLessThan(t.indexOf('turn-end'))
    expect(events.find((e) => e.type === 'block-end' && e.block !== undefined)).toMatchObject({
      block: { type: 'action', status: 'error' },
    })
    await session.close()
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
    allValid(events)
  })

  it('proceso que muere a mitad de herramienta: error + exit y la sesión queda inutilizable', async () => {
    const { session, events, fake } = await setup()
    await session.send('long')
    fake.emit(toolUse('mid', 'Bash', { command: 'make' }))
    fake.fail(new Error('EPIPE'))
    await wait(() => events.some((e) => e.type === 'exit'))
    expect(types(events).filter((x) => x === 'turn-end')).toHaveLength(0)
    await expect(session.send('otra vez')).rejects.toMatchObject({ code: 'CLOSED' })
    await expect(
      session.respond({ type: 'permission', requestId: 'r', optionId: 'a' }),
    ).rejects.toMatchObject({
      code: 'CLOSED',
    })
    await session.interrupt()
    await session.close()
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
  })

  it('permiso que nunca se responde: el turno sigue abierto sin consumir nada y close lo libera', async () => {
    const { session, events, fake } = await setup()
    await session.send('long')
    const decision = fake.ask({ toolName: 'Bash' })
    await wait(() => events.some((e) => e.type === 'permission-request'))
    await new Promise((r) => setTimeout(r, 100))
    expect(events.some((e) => e.type === 'turn-end')).toBe(false)
    await session.close()
    expect(await decision).toMatchObject({ behavior: 'deny' })
  })

  it('interrumpir durante canUseTool: se cancela, se deniega y el turno termina una vez', async () => {
    const { session, events, fake } = await setup()
    await session.send('long')
    const decision = fake.ask({ toolName: 'Edit' })
    await wait(() => events.some((e) => e.type === 'permission-request'))
    await Promise.all([session.interrupt(), session.interrupt()])
    expect(await decision).toMatchObject({ behavior: 'deny', interrupt: true })
    await wait(() => events.some((e) => e.type === 'turn-end'))
    await new Promise((r) => setTimeout(r, 120))
    expect(types(events).filter((x) => x === 'turn-end')).toHaveLength(1)
    expect(types(events).filter((x) => x === 'request-cancelled')).toHaveLength(1)
  })

  it('muchas solicitudes a la vez: se atienden hasta el tope y el resto se deniega', async () => {
    const { session, events, fake } = await setup()
    await session.send('long')
    const decisions = Array.from({ length: 50 }, () => fake.ask({ toolName: 'Bash' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(events.filter((e) => e.type === 'permission-request')).toHaveLength(32)
    await session.interrupt()
    const settled = await Promise.all(decisions)
    expect(settled.every((d) => d.behavior === 'deny')).toBe(true)
  })

  it('responder dos veces o a una solicitud inventada rechaza sin efectos', async () => {
    const { session, events, fake } = await setup()
    await session.send('long')
    void fake.ask({ toolName: 'Bash' })
    await wait(() => events.some((e) => e.type === 'permission-request'))
    const req = events.find((e) => e.type === 'permission-request')
    if (req?.type !== 'permission-request') throw new Error('tipo')
    const answers = await Promise.allSettled([
      session.respond({ type: 'permission', requestId: req.requestId, optionId: 'allow' }),
      session.respond({ type: 'permission', requestId: req.requestId, optionId: 'reject' }),
      session.respond({ type: 'permission', requestId: '__proto__', optionId: 'allow' }),
    ])
    expect(answers.map((a) => a.status)).toEqual(['fulfilled', 'rejected', 'rejected'])
  })

  it('una avalancha de mensajes del SDK se procesa completa y en orden', async () => {
    const t = await bootClaude(kit.createHarness())
    t.fake.onSend = () => {
      t.fake.emit(messageStart('big'), streamStart('text', 0))
      for (let i = 0; i < 5000; i++) t.fake.emit(streamText(`${i},`, 0))
      t.fake.emit(streamStop(0))
      t.fake.finish()
    }
    await t.service.send({ sessionId: t.session.id, text: 'go' })
    await t.until(t.turnEnded, 15_000)
    const text = t.document().find((b) => b.type === 'text')
    const expected = Array.from({ length: 5000 }, (_, i) => `${i},`).join('')
    expect(text?.type === 'text' && text.text).toBe(expected)
  })

  it('tras close no salen más eventos aunque el SDK siga hablando', async () => {
    const { session, events, fake } = await setup()
    await session.send('long')
    await session.close()
    const before = events.length
    fake.emit(streamStart(), streamText('fantasma'), result())
    await new Promise((r) => setTimeout(r, 30))
    expect(events).toHaveLength(before)
  })

  it('el servicio no cuenta eventos inválidos con ningún guion hostil', async () => {
    const t = await bootClaude(kit.createHarness())
    t.fake.onSend = () => {
      t.fake.emit(
        { type: 'raro' },
        'basura',
        streamStart('thinking', 0),
        streamText('x', 5),
        toolResult('nada', 'huérfano'),
        streamStop(0),
        toolUse('z', 'Bash', {}),
        result({ stop_reason: 'algo-nuevo' }),
      )
      t.fake.turnOpen = false
    }
    await t.service.send({ sessionId: t.session.id, text: 'go' })
    await t.until(t.turnEnded)
    expect(t.service.stats(t.session.id)?.invalidEvents).toBe(0)
  })
})
