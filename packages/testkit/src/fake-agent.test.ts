import type { ProviderEvent, Question } from '@nexo/contracts'
import { AgentProviderError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPABILITIES, FakeAgentProvider, type FakeStep, textTurn } from './fake-agent.ts'
import { FakeClock } from './fakes.ts'
import { sleep } from './timers.ts'

const collect = (session: { onEvent: (l: (e: ProviderEvent) => void) => unknown }) => {
  const events: unknown[] = []
  session.onEvent((e) => events.push(e))
  return events
}
const types = (events: unknown[]) => events.map((e) => (e as { type: string }).type)
const pause = (ms = 20) => sleep(ms)

describe('FakeAgentProvider', () => {
  it('los retardos los gobierna el reloj inyectado', async () => {
    const clock = new FakeClock()
    const provider = new FakeAgentProvider('fake', {
      clock,
      script: () => textTurn(['a']).map((s): FakeStep => ({ ...s, delayMs: 10 })),
    })
    const session = await provider.open({ cwd: '/w' })
    const events = collect(session)
    await session.send('x')
    expect(events).toHaveLength(0)
    clock.advance(10)
    expect(types(events)).toEqual(['block-start'])
    clock.advance(30)
    expect(types(events)).toEqual(['block-start', 'block-delta', 'block-end', 'turn-end'])
  })

  it('basura: emite valores sin validar, en orden', async () => {
    const clock = new FakeClock()
    const garbage = [null, 42, '{"roto"', { type: 'magia' }, JSON.parse('{"__proto__":{"x":1}}')]
    const provider = new FakeAgentProvider('fake', {
      clock,
      script: () => garbage.map((value): FakeStep => ({ type: 'raw', value })),
    })
    const session = await provider.open({ cwd: '/w' })
    const events = collect(session)
    await session.send('x')
    for (let i = 0; i < 6; i++) clock.advance(0)
    expect(events.slice(0, 5)).toEqual(garbage)
    expect(types(events.slice(5))).toEqual(['turn-end'])
    expect(session.emitted).toHaveLength(6)
  })

  it('colgarse: no termina hasta interrupt', async () => {
    const clock = new FakeClock()
    const provider = new FakeAgentProvider('fake', { clock, script: () => [{ type: 'hang' }] })
    const session = await provider.open({ cwd: '/w' })
    const events = collect(session)
    await session.send('x')
    clock.advance(100_000)
    expect(events).toHaveLength(0)
    expect(session.active).toBe(true)
    await session.interrupt()
    expect(types(events)).toEqual(['turn-end'])
  })

  it('morir: emite exit, cierra y rechaza turnos nuevos', async () => {
    const clock = new FakeClock()
    const provider = new FakeAgentProvider('fake', {
      clock,
      script: () => [
        ...textTurn(['a']).slice(0, 1),
        { type: 'die', exitCode: 137, signal: 'SIGKILL' },
      ],
    })
    const session = await provider.open({ cwd: '/w' })
    const events = collect(session)
    await session.send('x')
    clock.advance(0)
    clock.advance(0)
    expect(types(events)).toEqual(['block-start', 'exit'])
    expect(events[1]).toEqual({ type: 'exit', exitCode: 137, signal: 'SIGKILL' })
    expect(session.closed).toBe(true)
    await expect(session.send('y')).rejects.toBeInstanceOf(AgentProviderError)
    session.crash()
    expect(events).toHaveLength(2)
  })

  it('crash externo mientras espera un permiso', async () => {
    const provider = new FakeAgentProvider('fake')
    const session = await provider.open({ cwd: '/w' })
    const events = collect(session)
    await session.send('permission')
    await pause(30)
    expect(types(events)).toContain('permission-request')
    session.crash(1, null)
    expect(types(events).at(-1)).toBe('exit')
    await expect(
      session.respond({ type: 'permission', requestId: 'req-1', optionId: 'allow' }),
    ).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('preguntas: valida las respuestas contra las preguntas', async () => {
    const q: Question = {
      id: 'q1',
      question: 'Cuál?',
      options: [{ label: 'A' }, { label: 'B' }],
      multiSelect: false,
      allowText: false,
    }
    const provider = new FakeAgentProvider('fake', {
      script: () => [
        { type: 'emit', event: { type: 'question-request', requestId: 'r', questions: [q] } },
      ],
    })
    const session = await provider.open({ cwd: '/w' })
    const events = collect(session)
    await session.send('x')
    await pause()
    await expect(
      session.respond({
        type: 'question',
        requestId: 'r',
        answers: [{ questionId: 'q1', selected: ['Z'] }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })
    await expect(
      session.respond({ type: 'permission', requestId: 'r', optionId: 'a' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_REQUEST' })
    await session.respond({
      type: 'question',
      requestId: 'r',
      answers: [{ questionId: 'q1', selected: ['A'] }],
    })
    await pause()
    expect(types(events)).toEqual(['question-request', 'turn-end'])
    expect(session.responses).toHaveLength(1)
  })

  it('request-cancelled del guion retira la solicitud', async () => {
    const provider = new FakeAgentProvider('fake', {
      script: () => [
        {
          type: 'emit',
          event: {
            type: 'permission-request',
            requestId: 'r',
            tool: 'T',
            title: 't',
            options: [{ id: 'a', label: 'a', kind: 'allow-once' }],
          },
        },
        { type: 'emit', event: { type: 'request-cancelled', requestId: 'r' } },
      ],
    })
    const session = await provider.open({ cwd: '/w' })
    await session.send('x')
    await pause()
    await session.respond({ type: 'permission', requestId: 'r', optionId: 'a' })
    await pause()
    await expect(
      session.respond({ type: 'permission', requestId: 'r', optionId: 'a' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_REQUEST' })
  })

  it('valida las opciones de open según las capacidades', async () => {
    const provider = new FakeAgentProvider('fake')
    const bad = [
      { cwd: '/w', model: 'otro' },
      { cwd: '/w', effort: 'extremo' },
      { cwd: '/w', resume: 'x' },
    ]
    for (const o of bad) {
      await expect(provider.open(o)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })
    }
    const noResume = new FakeAgentProvider('f2', {
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        resume: false,
        warmup: false,
        permissionModes: ['ask'],
      },
    })
    const s = await noResume.open({ cwd: '/w' })
    await expect(noResume.open({ cwd: '/w', resume: s.providerSessionId })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
    await expect(noResume.open({ cwd: '/w', permissionMode: 'bypass' })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
    await noResume.warmUp({ cwd: '/w' })
    expect(noResume.warmed).toEqual([])
  })

  it('no disponible: open y warmUp rechazan con UNAVAILABLE; precalentar registra el cwd', async () => {
    const provider = new FakeAgentProvider('fake')
    await provider.warmUp({ cwd: '/w' })
    expect(provider.warmed).toEqual(['/w'])
    provider.available = false
    expect(await provider.isAvailable()).toBe(false)
    await expect(provider.open({ cwd: '/w' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(provider.warmUp({ cwd: '/w' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('cerrar durante un turno corta los eventos pendientes', async () => {
    const clock = new FakeClock()
    const provider = new FakeAgentProvider('fake', { clock })
    const session = await provider.open({ cwd: '/w' })
    const events = collect(session)
    await session.send('long')
    clock.advance(0)
    await session.close()
    clock.advance(1000)
    expect(types(events)).toEqual(['block-start', 'block-delta', 'exit'])
    expect(session.sent).toEqual(['long'])
  })
})
