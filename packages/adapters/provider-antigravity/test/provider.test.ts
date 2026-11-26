import { tmpdir } from 'node:os'
import { AgentProviderError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { buildArgs, createAntigravityProvider, parseModels } from '../src/index.ts'
import { agyErrorLine } from '../src/session.ts'
import { CONV } from './fixtures.ts'
import { FAKE, useFakeAgy, wait } from './helpers.ts'

const fake = useFakeAgy()

describe('disponibilidad y capacidades', () => {
  it('con agy y sesión, está disponible y lista modelos de «agy models»', async () => {
    const p = fake.provider()
    expect(await p.isAvailable()).toBe(true)
    expect(p.unavailableReason?.()).toBeUndefined()
    const caps = await p.capabilities()
    expect(caps.models.map((m) => m.id)).toEqual(['gemini-fake-pro', 'gemini-fake-flash'])
    expect(caps.models[0]?.label).toBe('Gemini Fake Pro')
    expect(caps.defaultModel).toBe('gemini-fake-pro')
    expect(caps).toMatchObject({
      efforts: ['low', 'medium', 'high'],
      permissionModes: ['ask', 'accept-edits', 'plan', 'bypass'],
      resume: true,
      warmup: false,
      streaming: true,
    })
    const models = fake.readLog().find((l) => l.argv?.[0] === 'models')
    expect(models?.argv).toEqual(['models', '--output-format', 'json'])
  })

  it('sin la CLI queda no disponible con un motivo que dice cómo arreglarlo', async () => {
    const p = fake.provider({}, { executable: '/no/existe/agy' })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/No se encontró Antigravity.*NEXO_AGY_EXECUTABLE/)
    await expect(p.open({ cwd: tmpdir() })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('sin sesión iniciada queda no disponible y dice que Nexo no inicia sesión', async () => {
    const p = fake.provider({ FAKE_AGY_LOGGED_OUT: '1' })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toContain('Nexo no inicia sesión por ti')
  })

  it('si «agy models» no responde a tiempo, queda no disponible', async () => {
    const p = fake.provider({ FAKE_AGY_MODELS_HANG: '1' }, { probeTimeoutMs: 300 })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toContain('no respondió')
  })

  it('una lista de modelos ilegible no impide usarlo', async () => {
    const p = fake.provider({ FAKE_AGY_MODELS_BROKEN: '1' })
    expect(await p.isAvailable()).toBe(true)
    expect((await p.capabilities()).models).toEqual([])
  })

  it('reutiliza la comprobación correcta durante probeCacheMs', async () => {
    let now = 1000
    const p = fake.provider({}, { probeCacheMs: 5000, now: () => now })
    await p.isAvailable()
    await p.isAvailable()
    expect(fake.readLog().filter((l) => l.argv?.[0] === 'models')).toHaveLength(1)
    now += 6000
    await p.isAvailable()
    expect(fake.readLog().filter((l) => l.argv?.[0] === 'models')).toHaveLength(2)
  })

  it('un ejecutable que no se puede lanzar queda no disponible con el motivo', async () => {
    const p = createAntigravityProvider({
      env: {},
      executable: FAKE,
      launcher: () => {
        throw new Error('no debería llamarse')
      },
      resolveFs: { isFile: () => false },
    })
    expect(await p.isAvailable()).toBe(false)
  })
})

describe('open', () => {
  it('valida cwd, modelo, esfuerzo, modo y ficha', async () => {
    const p = fake.provider()
    const code = async (o: Parameters<typeof p.open>[0]) =>
      p.open(o).then(
        () => 'ok',
        (e: unknown) => (e instanceof AgentProviderError ? e.code : 'otro'),
      )
    expect(await code({ cwd: '/no/existe/nunca' })).toBe('INVALID_OPTIONS')
    expect(await code({ cwd: tmpdir(), model: 'con espacio' })).toBe('INVALID_OPTIONS')
    expect(await code({ cwd: tmpdir(), effort: 'xhigh' })).toBe('INVALID_OPTIONS')
    expect(await code({ cwd: tmpdir(), permissionMode: 'raro' as 'ask' })).toBe('INVALID_OPTIONS')
    expect(await code({ cwd: tmpdir(), resume: 'no-es-un-uuid' })).toBe('INVALID_OPTIONS')
    expect(await code({ cwd: tmpdir(), resume: CONV })).toBe('ok')
  })
})

describe('turnos', () => {
  it('un turno: mensaje por stdin, banderas de stream-json y texto por deltas', async () => {
    const { session, events } = await fake.open()
    await session.send('simple')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.textOf(events)).toBe('Hola desde agy')
    expect(fake.messages()).toEqual([{ event: 'user', message: { content: 'simple' } }])
    const [args] = fake.turnArgs()
    expect(args).toEqual(['--output-format', 'stream-json', '--input-format', 'stream-json'])
    expect(events.at(-1)).toMatchObject({
      type: 'turn-end',
      stopReason: 'end-turn',
      usage: { inputTokens: 120, outputTokens: 30 },
    })
  })

  it('anuncia la ficha real tras el primer turno y reanuda con --conversation', async () => {
    const { session, events } = await fake.open({ FAKE_AGY_CONVERSATION: CONV })
    const provisional = session.providerSessionId
    await session.send('simple')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(session.providerSessionId).toBe(CONV)
    expect(provisional).not.toBe(CONV)
    expect(
      events.filter((e) => e.type === 'session-info' && e.providerSessionId === CONV).length,
    ).toBeGreaterThan(0)
    await session.send('simple')
    await wait(() => fake.turnEnds(events).length === 2)
    const [first, second] = fake.turnArgs()
    expect(first).not.toContain('--conversation')
    expect(
      second?.slice(second.indexOf('--conversation'), second.indexOf('--conversation') + 2),
    ).toEqual(['--conversation', CONV])
  })

  it('al reanudar con una ficha, el primer turno ya la pasa', async () => {
    const other = '22222222-3333-4444-5555-666666666666'
    const { session, events } = await fake.open({}, {}, { resume: other })
    expect(session.providerSessionId).toBe(other)
    await session.send('simple')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.turnArgs()[0]).toContain(other)
  })

  it('modelo, esfuerzo y modo se traducen a banderas', async () => {
    const cases = [
      ['ask', []],
      ['accept-edits', ['--mode', 'accept-edits']],
      ['plan', ['--mode', 'plan']],
      ['bypass', ['--dangerously-skip-permissions']],
    ] as const
    for (const [mode, flags] of cases) {
      const { session, events } = await fake.open(
        {},
        {},
        { permissionMode: mode, model: 'gemini-fake-pro', effort: 'high' },
      )
      await session.send('simple')
      await wait(() => fake.turnEnds(events).length === 1)
      const args = fake.turnArgs()[0] ?? []
      expect(args).toEqual(
        expect.arrayContaining(['--model', 'gemini-fake-pro', '--effort', 'high', ...flags]),
      )
      expect(events.find((e) => e.type === 'session-info')).toMatchObject({
        permissionMode: mode,
        model: 'gemini-fake-pro',
        effort: 'high',
      })
      await session.close()
    }
    expect(buildArgs({ permissionMode: 'ask' })).toEqual([
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
    ])
  })

  it('acciones: comando, escritura con diff relativo, y herramienta denegada', async () => {
    const { session, events } = await fake.open()
    await session.send('tool')
    await wait(() => fake.turnEnds(events).length === 1)
    const ends = events.flatMap((e) =>
      e.type === 'block-end' && e.block?.type === 'action' ? [e.block] : [],
    )
    expect(ends.map((b) => b.status)).toEqual(['ok', 'ok', 'error'])
    expect(ends[0]).toMatchObject({ kind: 'exec', title: 'echo hola' })
    expect(ends[1]).toMatchObject({ kind: 'edit', path: 'src/a.ts', diff: { path: 'src/a.ts' } })
    expect(ends[2]?.output).toContain('denegado')
    expect(fake.textOf(events)).toBe('Hecho: creé src/a.ts.')
  })

  it('un DONE acumulativo no duplica el texto', async () => {
    const { session, events } = await fake.open()
    await session.send('done-full')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.textOf(events)).toBe('Respuesta larga y completa.')
  })

  it('sin texto en el flujo muestra la respuesta del resultado', async () => {
    const { session, events } = await fake.open()
    await session.send('result-only')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.textOf(events)).toBe('Solo en el resultado.')
  })

  it('respond rechaza: en modo no interactivo agy no pide permisos ni hace preguntas', async () => {
    const { session } = await fake.open()
    await expect(
      session.respond({ type: 'permission', requestId: 'x', optionId: 'y' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_REQUEST' })
    await expect(
      session.respond({
        type: 'question',
        requestId: 'x',
        answers: [{ questionId: 'q', selected: [] }],
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_REQUEST' })
  })

  it('interrumpir corta el turno y permite seguir con la misma conversación', async () => {
    const { session, events } = await fake.open({}, { limits: { interruptGraceMs: 1000 } })
    await session.send('long')
    await wait(() => fake.textOf(events).includes('Trabajando'))
    await session.interrupt()
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.turnEnds(events)[0]).toMatchObject({ stopReason: 'interrupted' })
    await session.send('simple')
    await wait(() => fake.turnEnds(events).length === 2)
    expect(fake.turnArgs()[1]).toContain('--conversation')
  })
})

describe('agyErrorLine', () => {
  it('saca el mensaje de la línea AGY_ERROR; sin ella, nada', () => {
    expect(agyErrorLine('x\nAGY_ERROR: {"message":"cuota agotada"}\n')).toBe('cuota agotada')
    expect(agyErrorLine('AGY_ERROR: {"status":"X"}')).toBe('X')
    expect(agyErrorLine('AGY_ERROR: {roto')).toBeUndefined()
    expect(agyErrorLine('nada')).toBeUndefined()
  })
})

describe('parseModels', () => {
  it('acepta listas, objetos con clave conocida, JSON por líneas y cadenas', () => {
    expect(parseModels('["a","b"]').models.map((m) => m.id)).toEqual(['a', 'b'])
    expect(parseModels('{"data":[{"slug":"s","label":"Eti","isDefault":true}]}')).toEqual({
      models: [{ id: 's', label: 'Eti' }],
      defaultModel: 's',
    })
    expect(parseModels('{"id":"solo"}\n{"id":"otro"}\nbasura').models.map((m) => m.id)).toEqual([
      'solo',
      'otro',
    ])
    expect(parseModels('').models).toEqual([])
    expect(parseModels('{"x":1}').models).toEqual([])
    expect(
      parseModels('[{"id":"con espacio"},{"id":"a"},{"id":"a"},7]').models.map((m) => m.id),
    ).toEqual(['a'])
  })
})
