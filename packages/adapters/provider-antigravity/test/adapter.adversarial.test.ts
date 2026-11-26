import { describe, expect, it } from 'vitest'
import { LineSplitter } from '../src/lines.ts'
import { type ExitInfo, spawnAgyProcess } from '../src/process.ts'
import { useFakeAgy, wait } from './helpers.ts'

const fake = useFakeAgy()

describe('agy hostil o defectuoso', () => {
  it('líneas que no son JSON, eventos desconocidos y formas raras se ignoran y el turno sigue', async () => {
    const { session, events } = await fake.open()
    await session.send('garbage')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.textOf(events)).toBe('Sobrevivió.')
    expect(fake.turnEnds(events)[0]).toMatchObject({ stopReason: 'end-turn' })
    expect(fake.logs.some((l) => l.message.includes('no es JSON'))).toBe(true)
  })

  it('una línea enorme se descarta sin tumbar la sesión', async () => {
    const { session, events } = await fake.open(
      { FAKE_AGY_BIG: '300000' },
      { maxLineLength: 100_000 },
    )
    await session.send('bigline')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.textOf(events)).toBe('Tras la línea enorme.')
    expect(fake.logs.some((l) => l.message.includes('supera el tamaño máximo'))).toBe(true)
  })

  it('el resultado ERROR se muestra como error y no mata la sesión', async () => {
    const { session, events } = await fake.open()
    await session.send('error')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.errors(events)[0]).toMatchObject({ code: 'AGY_ERROR', fatal: false })
    expect(fake.turnEnds(events)[0]).toMatchObject({ stopReason: 'error' })
    await session.send('simple')
    await wait(() => fake.turnEnds(events).length === 2)
    expect(fake.turnEnds(events)[1]).toMatchObject({ stopReason: 'end-turn' })
  })

  it('un 401 se explica como falta de sesión, sin iniciar sesión por el usuario', async () => {
    const { session, events } = await fake.open()
    await session.send('auth')
    await wait(() => fake.turnEnds(events).length === 1)
    const [error] = fake.errors(events)
    expect(error).toMatchObject({ code: 'AUTH_REQUIRED', fatal: true })
    expect(error?.message).toContain('Nexo no inicia sesión por ti')
  })

  it('si agy muere sin resultado, el error sale de AGY_ERROR en stderr y el turno acaba', async () => {
    const { session, events } = await fake.open()
    await session.send('crash')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.errors(events)[0]).toMatchObject({ code: 'USAGE_LIMIT' })
    expect(fake.turnEnds(events)[0]).toMatchObject({ stopReason: 'error' })
  })

  it('sin actividad más allá del plazo, el turno falla con TIMEOUT y se mata el proceso', async () => {
    const { session, events } = await fake.open({}, { limits: { idleTimeoutMs: 300 } })
    await session.send('silent')
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.errors(events)[0]).toMatchObject({ code: 'TIMEOUT', retryable: true })
    await session.send('simple')
    await wait(() => fake.turnEnds(events).length === 2)
  })

  it('cerrar con un turno en curso mata el proceso, no emite turn-end y emite exit una vez', async () => {
    const { session, events } = await fake.open()
    await session.send('long')
    await wait(() => fake.textOf(events).includes('Trabajando'))
    await session.close()
    await session.close()
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
    expect(fake.turnEnds(events)).toHaveLength(0)
    await expect(session.send('x')).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('un segundo send con el turno en curso es BUSY y no lanza otro proceso', async () => {
    const { session, events } = await fake.open()
    await session.send('long')
    await expect(session.send('otro')).rejects.toMatchObject({ code: 'BUSY' })
    await wait(() => fake.turnArgs().length >= 1)
    expect(fake.turnArgs()).toHaveLength(1)
    await session.interrupt()
    await wait(() => fake.turnEnds(events).length === 1)
  })

  it('un mensaje con comillas, saltos de línea y unicode llega íntegro por stdin', async () => {
    const { session, events } = await fake.open()
    const text = 'echo "hola"\n\tlínea 2 \u{1f600} \\ {"event":"user"}'
    await session.send(text)
    await wait(() => fake.turnEnds(events).length === 1)
    expect(fake.messages()).toEqual([{ event: 'user', message: { content: text } }])
  })

  it('si el turno no se puede lanzar, da un error fatal y exit', async () => {
    const { session, events } = await fake.open(
      {},
      {
        launcher: (o) => {
          if (o.args[0] === 'models') return spawnAgyProcess(o)
          let onExit: (i: ExitInfo) => void = () => {}
          return {
            writeAndClose: () => {},
            onStdout: () => {},
            onStderr: () => {},
            onExit: (l) => {
              onExit = l
              queueMicrotask(() =>
                onExit({ exitCode: null, signal: null, error: new Error('EACCES') }),
              )
            },
            interrupt: () => {},
            kill: () => {},
          }
        },
      },
    )
    await session.send('simple')
    await wait(() => events.some((e) => e.type === 'exit'))
    expect(fake.errors(events)[0]).toMatchObject({ code: 'AGY_EXITED', fatal: true })
    expect(fake.turnEnds(events)).toHaveLength(0)
    await expect(session.send('x')).rejects.toMatchObject({ code: 'CLOSED' })
  })
})

describe('LineSplitter', () => {
  const collect = (max: number, chunks: string[]) => {
    const lines: string[] = []
    let overflow = 0
    const s = new LineSplitter({
      maxLength: max,
      onLine: (l) => lines.push(l),
      onOverflow: () => overflow++,
    })
    for (const c of chunks) s.push(c)
    s.flush()
    return { lines, overflow }
  }

  it('une trozos partidos, quita \\r y salta líneas vacías', () => {
    expect(collect(100, ['{"a"', ':1}\r\n\n{"b":2}', '\n{"c"'])).toEqual({
      lines: ['{"a":1}', '{"b":2}', '{"c"'],
      overflow: 0,
    })
  })

  it('descarta una línea larga hasta su salto aunque llegue en muchos trozos', () => {
    const r = collect(10, ['aaaaa', 'bbbbbb', 'cc', '\nok\n'])
    expect(r).toEqual({ lines: ['ok'], overflow: 1 })
  })

  it('una línea larga que llega de golpe con su salto también se descarta', () => {
    expect(collect(5, ['abcdefgh\nxy\n'])).toEqual({ lines: ['xy'], overflow: 1 })
  })

  it('el resto sin salto de línea tras desbordar no se entrega', () => {
    expect(collect(3, ['abcdef'])).toEqual({ lines: [], overflow: 1 })
  })
})
