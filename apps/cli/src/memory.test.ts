import type { Block, BlockId, MethodResult, Observation } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { parseBlockRange } from './commands/memory.ts'
import {
  MemoryListOutput,
  MemoryRecallOutput,
  MemorySearchOutput,
  MemoryStatusOutput,
} from './schemas.ts'
import { agentHandlers, makeEnv, SESSION_ID, type TestEnv, WORK } from './test-helpers.ts'

const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)

const USAGE = { calls: 3, inputTokens: 1200, outputTokens: 90, costUsd: 0.0042 }
const ZERO = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }

const obs = (seq: number, over: Partial<Observation> = {}): Observation => ({
  seq,
  at: 1_700_000_000_000 + seq,
  priority: 'medium',
  scope: 'project',
  sessionId: SESSION_ID as never,
  range: { from: seq, to: seq + 1 },
  text: `observación ${seq}`,
  ...over,
})

function status(over: Partial<MethodResult<'memory.status'>> = {}): MethodResult<'memory.status'> {
  return {
    enabled: true,
    summarizer: 'ollama:llama3.2:3b',
    thresholds: { observerBatchTokens: 6000, reflectorTokens: 40000 },
    usage: USAGE,
    roles: { observer: { ...USAGE, calls: 2 }, reflector: { ...USAGE, calls: 1 } },
    ...over,
  }
}

const block = (index: number, text: string): Block =>
  ({
    id: `b${index}` as BlockId,
    index,
    turn: 1,
    seq: 0,
    createdAt: 1,
    type: 'user',
    text,
  }) as Block

describe('nexo memory status', () => {
  it('muestra estado, resumidor, umbrales y uso; pide la carpeta actual', async () => {
    const env = makeEnv()
    env.client.handlers.set('memory.status', () =>
      status({
        project: {
          cwd: WORK,
          observations: 4,
          observationTokens: 321,
          reflectionTokens: 80,
          generation: 2,
          sessions: 1,
          updatedAt: 1,
        },
        projectUsage: USAGE,
      }),
    )
    expect(await run(env, 'memory', 'status')).toBe(0)
    expect(env.client.callsTo('memory.status')[0]).toEqual({ cwd: WORK })
    expect(env.cap.out).toContain('Memoria: activada')
    expect(env.cap.out).toContain('Resumidor: ollama:llama3.2:3b')
    expect(env.cap.out).toContain('Observador 6000 tokens, Reflector 40000 tokens')
    expect(env.cap.out).toContain('Observador: 2 llamadas')
    expect(env.cap.out).toContain('$0.0042')
    expect(env.cap.out).toContain('4 observaciones')
    expect(env.cap.out).toContain('generación 2')
  })

  it('apagada y en pausa se explican', async () => {
    const off = makeEnv()
    off.client.handlers.set('memory.status', () => ({
      enabled: false,
      thresholds: { observerBatchTokens: 6000, reflectorTokens: 40000 },
      usage: ZERO,
    }))
    expect(await run(off, 'memory', 'status')).toBe(0)
    expect(off.cap.out).toContain('apagada (NEXO_MEMORY=on la activa)')
    expect(off.cap.out).toContain('(ninguno)')

    const paused = makeEnv()
    paused.client.handlers.set('memory.status', () =>
      status({ pausedReason: 'Ollama no responde' }),
    )
    expect(await run(paused, 'memory', 'status')).toBe(0)
    expect(paused.cap.out).toContain('En pausa: Ollama no responde')
  })

  it('--json emite el resultado validado; --cwd cambia la carpeta', async () => {
    const env = makeEnv()
    env.client.handlers.set('memory.status', () => status())
    expect(await run(env, 'memory', '--json', 'status', '--cwd', '/otra/carpeta')).toBe(0)
    expect(MemoryStatusOutput.parse(JSON.parse(env.cap.out)).enabled).toBe(true)
    expect((env.client.callsTo('memory.status')[0] as { cwd: string }).cwd).toMatch(/otra/)
  })
})

describe('nexo memory ls', () => {
  it('lista reflexión y observaciones con prioridad, alcance y rango', async () => {
    const env = makeEnv()
    env.client.handlers.set('memory.list', () => ({
      reflection: {
        generation: 3,
        createdAt: 1_700_000_000_000,
        coversThroughSeq: 0,
        text: 'Usa pnpm.\nVitest.',
        sources: [],
      },
      observations: [obs(1, { priority: 'high' }), obs(2, { scope: 'session', priority: 'low' })],
      nextSeq: 3,
    }))
    expect(
      await run(
        env,
        'memory',
        'ls',
        '--limit',
        '2',
        '--scope',
        'project',
        '--min-priority',
        'low',
        '--from',
        '1',
      ),
    ).toBe(0)
    expect(env.client.callsTo('memory.list')[0]).toMatchObject({
      cwd: WORK,
      limit: 2,
      fromSeq: 1,
      scope: 'project',
      minPriority: 'low',
    })
    expect(env.cap.out).toContain('Reflexión (generación 3')
    expect(env.cap.out).toContain('  Usa pnpm.')
    expect(env.cap.out).toContain('#1 [')
    expect(env.cap.out).toContain('[alta] [proyecto]')
    expect(env.cap.out).toContain('[baja] [sesión]')
    expect(env.cap.out).toContain('Hay más: sigue con --from 3')
  })

  it('sin nada explica cómo activarla; --json es estable', async () => {
    const env = makeEnv()
    env.client.handlers.set('memory.list', () => ({
      reflection: null,
      observations: [],
      nextSeq: null,
    }))
    expect(await run(env, 'memory', 'ls')).toBe(0)
    expect(env.cap.out).toContain('NEXO_MEMORY=on')
    const j = makeEnv()
    j.client.handlers.set('memory.list', () => ({
      reflection: null,
      observations: [obs(1)],
      nextSeq: null,
    }))
    expect(await run(j, 'memory', 'ls', '--json')).toBe(0)
    expect(MemoryListOutput.parse(JSON.parse(j.cap.out)).observations).toHaveLength(1)
  })

  it('rechaza opciones inválidas sin llamar al daemon', async () => {
    for (const args of [
      ['--limit', '0'],
      ['--limit', '101'],
      ['--limit', 'x'],
      ['--from', '0'],
      ['--scope', 'todo'],
      ['--min-priority', 'urgente'],
      ['--cwd', ''],
      ['sobra'],
    ]) {
      const env = makeEnv()
      expect(await run(env, 'memory', 'ls', ...args), args.join(' ')).toBe(1)
      expect(env.client.callsTo('memory.list')).toHaveLength(0)
    }
  })
})

describe('nexo memory search', () => {
  it('busca y muestra coincidencias; avisa si hay más', async () => {
    const env = makeEnv()
    env.client.handlers.set('memory.search', () => ({
      observations: [obs(4, { text: 'usa pnpm' })],
      truncated: true,
    }))
    expect(await run(env, 'memory', 'search', 'usa', 'pnpm', '--limit', '5')).toBe(0)
    expect(env.client.callsTo('memory.search')[0]).toEqual({
      cwd: WORK,
      query: 'usa pnpm',
      limit: 5,
    })
    expect(env.cap.out).toContain('usa pnpm')
    expect(env.cap.out).toContain('Hay más coincidencias')
    const none = makeEnv()
    none.client.handlers.set('memory.search', () => ({ observations: [], truncated: false }))
    expect(await run(none, 'memory', 'search', 'nada')).toBe(0)
    expect(none.cap.out).toContain('Sin coincidencias')
    const j = makeEnv()
    j.client.handlers.set('memory.search', () => ({ observations: [], truncated: false }))
    expect(await run(j, 'memory', 'search', '--json', 'x')).toBe(0)
    expect(MemorySearchOutput.parse(JSON.parse(j.cap.out)).truncated).toBe(false)
  })

  it('exige consulta y la acota', async () => {
    const env = makeEnv()
    expect(await run(env, 'memory', 'search')).toBe(1)
    expect(await run(env, 'memory', 'search', '   ')).toBe(1)
    expect(await run(env, 'memory', 'search', 'x'.repeat(300))).toBe(1)
    expect(env.client.callsTo('memory.search')).toHaveLength(0)
  })
})

describe('nexo memory recall', () => {
  function setup(blocks: Block[] = [block(2, 'hola'), block(3, 'adiós')], truncated = false) {
    const env = makeEnv()
    agentHandlers(env.client, () => [])
    env.client.handlers.set('memory.recall', () => ({ blocks, truncated }))
    return env
  }

  it('resuelve la sesión por prefijo y devuelve el texto original del rango', async () => {
    const env = setup()
    expect(await run(env, 'memory', 'recall', SESSION_ID.slice(0, 12), '2-3')).toBe(0)
    expect(env.client.callsTo('memory.recall')[0]).toEqual({
      sessionId: SESSION_ID,
      range: { from: 2, to: 3 },
    })
    expect(env.cap.out).toContain('--- #2 user ---')
    expect(env.cap.out).toContain('> hola')
    expect(env.cap.out).toContain('> adiós')
  })

  it('--json y recortado', async () => {
    const env = setup([block(0, 'x')], true)
    expect(await run(env, 'memory', 'recall', SESSION_ID, '0', '--json')).toBe(0)
    const out = MemoryRecallOutput.parse(JSON.parse(env.cap.out))
    expect(out).toMatchObject({ sessionId: SESSION_ID, range: { from: 0, to: 0 }, truncated: true })
    const text = setup([block(0, 'x')], true)
    expect(await run(text, 'memory', 'recall', SESSION_ID, '0')).toBe(0)
    expect(text.cap.out).toContain('recortado')
  })

  it('sin bloques lo dice; sesión inexistente es 2; rango o argumentos malos son 1', async () => {
    const empty = setup([])
    expect(await run(empty, 'memory', 'recall', SESSION_ID, '9')).toBe(0)
    expect(empty.cap.out).toContain('no tiene bloques')
    expect(await run(setup(), 'memory', 'recall', 'nadie', '1')).toBe(2)
    for (const args of [
      [],
      [SESSION_ID],
      [SESSION_ID, '5', 'x'],
      [SESSION_ID, 'a-b'],
      [SESSION_ID, '9-2'],
      [SESSION_ID, '0-200'],
    ]) {
      expect(await run(setup(), 'memory', 'recall', ...args), args.join(' ')).toBe(1)
    }
  })
})

describe('parseBlockRange', () => {
  it('acepta 5, 5-9, 5..9 y 5:9', () => {
    expect(parseBlockRange('5')).toEqual({ from: 5, to: 5 })
    expect(parseBlockRange('5-9')).toEqual({ from: 5, to: 9 })
    expect(parseBlockRange('5..9')).toEqual({ from: 5, to: 9 })
    expect(parseBlockRange(' 5:9 ')).toEqual({ from: 5, to: 9 })
    expect(parseBlockRange('0-199')).toEqual({ from: 0, to: 199 })
  })

  it('rechaza lo demás', () => {
    for (const bad of ['', '-1', '1-', 'a', '1-2-3', '1.5', '9-2', '0-200', '99999', '123456']) {
      expect(() => parseBlockRange(bad), bad).toThrow()
    }
  })
})

describe('nexo memory: subcomando', () => {
  it('sin subcomando o con uno desconocido es un error de uso; hay ayuda', async () => {
    const env = makeEnv()
    expect(await run(env, 'memory')).toBe(1)
    expect(await run(env, 'memory', 'borrar')).toBe(1)
    const help = makeEnv()
    expect(await run(help, 'memory', '--help')).toBe(0)
    expect(help.cap.out).toContain('nexo memory <subcomando>')
    expect(help.cap.out).toContain('recall <sesión>')
    const general = makeEnv()
    expect(await run(general, '--help')).toBe(0)
    expect(general.cap.out).toContain('memory <sub>')
  })
})
