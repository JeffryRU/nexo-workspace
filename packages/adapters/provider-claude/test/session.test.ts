import type { ProviderEvent } from '@nexo/contracts'
import { AgentProviderError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { type FakeSdkSession, result, streamStart, streamText } from './helpers.ts'
import { setup, useCleanup, wait } from './setup.ts'

useCleanup()

const requestOf = (events: ProviderEvent[]) => {
  const e = events.find((x) => x.type === 'permission-request' || x.type === 'question-request')
  if (e === undefined) throw new Error('sin solicitud')
  return e
}

describe('permisos', () => {
  it('permitir devuelve allow con la entrada original; rechazar, deny', async () => {
    const { session, events, fake } = await setup()
    await session.send('x')
    const input = { command: 'rm -rf build' }
    const decision = fake.ask({
      toolName: 'Bash',
      input,
      title: 'Claude quiere ejecutar un comando',
    })
    await wait(() => events.some((e) => e.type === 'permission-request'))
    const req = requestOf(events)
    expect(req).toMatchObject({
      type: 'permission-request',
      tool: 'Bash',
      title: 'Claude quiere ejecutar un comando',
    })
    if (req.type !== 'permission-request') throw new Error('tipo')
    expect(req.options.map((o) => o.kind)).toEqual(['allow-once', 'reject-once'])
    expect(req.detail).toContain('rm -rf build')
    await session.respond({ type: 'permission', requestId: req.requestId, optionId: 'allow' })
    expect(await decision).toEqual({ behavior: 'allow', updatedInput: input })

    const second = fake.ask({ toolName: 'Edit' })
    await wait(() => events.filter((e) => e.type === 'permission-request').length === 2)
    const req2 = events.filter((e) => e.type === 'permission-request')[1]
    if (req2?.type !== 'permission-request') throw new Error('tipo')
    await session.respond({ type: 'permission', requestId: req2.requestId, optionId: 'reject' })
    expect(await second).toMatchObject({ behavior: 'deny' })
  })

  it('permitir siempre solo se ofrece con sugerencias y las devuelve como updatedPermissions', async () => {
    const { session, events, fake } = await setup()
    await session.send('x')
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }]
    const decision = fake.ask({ toolName: 'Bash', suggestions })
    await wait(() => events.some((e) => e.type === 'permission-request'))
    const req = requestOf(events)
    if (req.type !== 'permission-request') throw new Error('tipo')
    expect(req.options.map((o) => o.id)).toEqual(['allow', 'allow-always', 'reject'])
    await session.respond({
      type: 'permission',
      requestId: req.requestId,
      optionId: 'allow-always',
    })
    expect(await decision).toMatchObject({ behavior: 'allow', updatedPermissions: suggestions })
  })

  it('responder una pregunta como permiso (o al revés) es INVALID_OPTIONS y no consume la solicitud', async () => {
    const { session, events, fake } = await setup()
    await session.send('x')
    void fake.ask({ toolName: 'Bash' })
    await wait(() => events.some((e) => e.type === 'permission-request'))
    const req = requestOf(events)
    if (req.type !== 'permission-request') throw new Error('tipo')
    await expect(
      session.respond({
        type: 'question',
        requestId: req.requestId,
        answers: [{ questionId: 'q1', selected: ['a'] }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })
    await session.respond({ type: 'permission', requestId: req.requestId, optionId: 'allow' })
  })

  it('el aborto del SDK retira la solicitud con request-cancelled', async () => {
    const { session, events, fake } = await setup()
    await session.send('x')
    const controller = new AbortController()
    const decision = fake.ask({ toolName: 'Bash', signal: controller.signal })
    await wait(() => events.some((e) => e.type === 'permission-request'))
    controller.abort()
    expect(await decision).toMatchObject({ behavior: 'deny' })
    expect(events.some((e) => e.type === 'request-cancelled')).toBe(true)
  })

  it('fuera de un turno se deniega sin emitir nada', async () => {
    const { events, fake } = await setup()
    expect(await fake.ask({ toolName: 'Bash' })).toMatchObject({ behavior: 'deny' })
    expect(events).toEqual([])
  })
})

describe('AskUserQuestion', () => {
  const input = {
    questions: [
      {
        question: '¿Qué librería usamos?',
        header: 'Librería',
        multiSelect: false,
        options: [
          { label: 'date-fns', description: 'ligera' },
          { label: 'luxon', description: 'completa' },
        ],
      },
      {
        question: '¿Qué funciones?',
        header: 'Funciones',
        multiSelect: true,
        options: [
          { label: 'formato', description: 'formatear' },
          { label: 'zonas', description: 'zonas horarias' },
        ],
      },
    ],
  }

  it('emite question-request y responde con updatedInput { questions, answers }', async () => {
    const { session, events, fake } = await setup()
    await session.send('x')
    const decision = fake.ask({ toolName: 'AskUserQuestion', input })
    await wait(() => events.some((e) => e.type === 'question-request'))
    const req = requestOf(events)
    if (req.type !== 'question-request') throw new Error('tipo')
    expect(req.questions.map((q) => [q.id, q.multiSelect, q.allowText])).toEqual([
      ['q1', false, true],
      ['q2', true, true],
    ])
    await session.respond({
      type: 'question',
      requestId: req.requestId,
      answers: [
        { questionId: 'q1', selected: ['luxon'] },
        { questionId: 'q2', selected: ['formato', 'zonas'], text: 'y calendarios' },
      ],
    })
    expect(await decision).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: input.questions,
        answers: {
          '¿Qué librería usamos?': 'luxon',
          '¿Qué funciones?': 'formato, zonas, y calendarios',
        },
      },
    })
  })

  it('respuestas inválidas se rechazan y la pregunta sigue pendiente', async () => {
    const { session, events, fake } = await setup()
    await session.send('x')
    const decision = fake.ask({ toolName: 'AskUserQuestion', input })
    await wait(() => events.some((e) => e.type === 'question-request'))
    const req = requestOf(events)
    if (req.type !== 'question-request') throw new Error('tipo')
    await expect(
      session.respond({
        type: 'question',
        requestId: req.requestId,
        answers: [{ questionId: 'q1', selected: ['no-existe'] }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })
    await session.respond({
      type: 'question',
      requestId: req.requestId,
      answers: [
        { questionId: 'q1', selected: ['luxon'] },
        { questionId: 'q2', text: 'nada', selected: [] },
      ],
    })
    expect(await decision).toMatchObject({ behavior: 'allow' })
  })

  it('una entrada malformada se deniega sin emitir solicitud', async () => {
    const { session, events, fake } = await setup()
    await session.send('x')
    expect(
      await fake.ask({ toolName: 'AskUserQuestion', input: { questions: 'no' } }),
    ).toMatchObject({
      behavior: 'deny',
    })
    expect(await fake.ask({ toolName: 'AskUserQuestion', input: { questions: [] } })).toMatchObject(
      {
        behavior: 'deny',
      },
    )
    expect(events.filter((e) => e.type === 'question-request')).toEqual([])
  })
})

describe('interrupción y cierre', () => {
  it('interrumpir con solicitudes pendientes emite request-cancelled antes del turn-end interrupted', async () => {
    const { session, events, fake } = await setup()
    await session.send('x')
    const a = fake.ask({ toolName: 'Bash' })
    const b = fake.ask({
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }] },
    })
    await wait(
      () =>
        events.filter((e) => e.type === 'permission-request' || e.type === 'question-request')
          .length === 2,
    )
    await session.interrupt()
    await wait(() => events.some((e) => e.type === 'turn-end'))
    const t = events.map((e) => e.type)
    expect(t.filter((x) => x === 'request-cancelled')).toHaveLength(2)
    expect(t.lastIndexOf('request-cancelled')).toBeLessThan(t.indexOf('turn-end'))
    expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ stopReason: 'interrupted' })
    expect(await a).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(await b).toMatchObject({ behavior: 'deny' })
  })

  it('si el SDK no responde a interrupt, el turno termina igual con interrupted y el result tardío se ignora', async () => {
    const { session, events, fake } = await setup()
    fake.onInterrupt = () => new Promise(() => {})
    await session.send('long')
    fake.emit(streamStart(), streamText('hola'))
    await session.interrupt()
    await wait(() => events.some((e) => e.type === 'turn-end'))
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1)
    expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ stopReason: 'interrupted' })
    // el siguiente turno no se confunde con el result tardío del anterior
    fake.onInterrupt = undefined
    await session.send('simple')
    fake.emit(result({ result: 'tardío' }))
    await wait(() => events.filter((e) => e.type === 'turn-end').length === 2)
    await new Promise((r) => setTimeout(r, 20))
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(2)
  })

  it('close deniega lo pendiente, no emite bloques y emite exit una vez', async () => {
    const { session, events, fake } = await setup()
    await session.send('x')
    const decision = fake.ask({ toolName: 'Bash' })
    await wait(() => events.some((e) => e.type === 'permission-request'))
    await session.close()
    expect(await decision).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
    expect(events[events.length - 1]?.type).toBe('exit')
    expect(fake.closed).toBe(true)
  })
})

describe('muerte del proceso', () => {
  it('si el flujo se corta a mitad de turno: bloques cerrados, error fatal y exit; sin turn-end', async () => {
    const { session, events, fake } = await setup()
    await session.send('long')
    fake.emit(streamStart(), streamText('a medias'))
    fake.fail(new Error('Claude Code process exited with code 3'))
    await wait(() => events.some((e) => e.type === 'exit'))
    const t = events.map((e) => e.type)
    expect(t).not.toContain('turn-end')
    expect(t.indexOf('block-end')).toBeLessThan(t.indexOf('error'))
    expect(t[t.length - 1]).toBe('exit')
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: 'PROCESS_DIED', fatal: true },
    })
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ exitCode: 3 })
    await expect(session.send('otra')).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('un fallo de credenciales en stderr se explica con las dos opciones', async () => {
    const { session, events, fake } = await setup()
    fake.options.onStderr?.('Error: Invalid API key · Please run /login')
    await session.send('x')
    fake.fail(new Error('Claude Code process exited with code 1'))
    await wait(() => events.some((e) => e.type === 'exit'))
    const err = events.find((e) => e.type === 'error')
    expect(err).toMatchObject({ error: { code: 'AUTH_REQUIRED', fatal: true } })
    expect(err?.type === 'error' && err.error.message).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('si el flujo termina sin que se pida, también es una muerte', async () => {
    const { events, fake } = await setup()
    fake.end()
    await wait(() => events.some((e) => e.type === 'exit'))
    expect(events.map((e) => e.type)).toEqual(['error', 'exit'])
  })
})

describe('send', () => {
  it('valida el texto y el estado', async () => {
    const { session } = await setup()
    await expect(session.send('   ')).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })
    await expect(session.send('x'.repeat(129 * 1024))).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
    await session.send('long')
    await expect(session.send('otro')).rejects.toBeInstanceOf(AgentProviderError)
  })

  it('un fallo del transporte al enviar libera el turno y rechaza con CLOSED', async () => {
    const { session, fake } = await setup()
    fake.close()
    await expect(session.send('x')).rejects.toMatchObject({ code: 'CLOSED' })
    await expect(session.send('x')).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('un oyente que lanza no rompe la sesión', async () => {
    const { session, events, fake } = await setup()
    session.onEvent(() => {
      throw new Error('oyente roto')
    })
    await session.send('simple')
    await wait(() => events.some((e) => e.type === 'turn-end'))
    expect((fake as FakeSdkSession).sent).toEqual(['simple'])
  })
})
