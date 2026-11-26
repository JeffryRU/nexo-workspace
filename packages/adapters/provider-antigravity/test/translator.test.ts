import type { ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import {
  AgyTranslator,
  classifyError,
  errorMessage,
  permissionModeOf,
  usageOf,
} from '../src/translator.ts'
import { CONV, init, result, step, tool, usage } from './fixtures.ts'

function make(cwd = '/w') {
  let n = 0
  const t = new AgyTranslator({ nextRef: () => `r${++n}`, cwd })
  t.beginTurn()
  return t
}
const run = (t: AgyTranslator, items: unknown[]): ProviderEvent[] => items.flatMap((i) => t.feed(i))
const textOf = (events: ProviderEvent[]) =>
  events.flatMap((e) => (e.type === 'block-delta' && e.field === 'text' ? [e.text] : [])).join('')
const types = (events: ProviderEvent[]) => events.map((e) => e.type)

describe('AgyTranslator: texto y turno', () => {
  it('init anuncia la conversación, el modelo y el modo', () => {
    const t = make()
    const events = run(t, [init({ model: 'gemini-x' })])
    expect(events).toEqual([
      { type: 'session-info', providerSessionId: CONV, model: 'gemini-x', permissionMode: 'ask' },
    ])
    expect(t.conversationId).toBe(CONV)
  })

  it('traduce el modo de permisos; uno desconocido no se anuncia', () => {
    expect(permissionModeOf('always-proceed')).toBe('bypass')
    expect(permissionModeOf('request-review')).toBe('ask')
    expect(permissionModeOf('accept-edits')).toBe('accept-edits')
    expect(permissionModeOf('plan')).toBe('plan')
    expect(permissionModeOf('raro')).toBeUndefined()
    expect(permissionModeOf(undefined)).toBeUndefined()
  })

  it('los text_delta de pasos ACTIVE son deltas y DONE cierra el bloque', () => {
    const t = make()
    const events = run(t, [
      init(),
      step(0, 'DONE', 'user_input'),
      step(1, 'ACTIVE', 'agent_response', { text_delta: 'Hola ' }),
      step(1, 'ACTIVE', 'agent_response', { text_delta: 'mundo' }),
      step(1, 'DONE', 'agent_response', { usage }),
      result('SUCCESS', 'Hola mundo'),
    ])
    expect(textOf(events)).toBe('Hola mundo')
    expect(types(events).filter((x) => x === 'block-start')).toHaveLength(1)
    expect(types(events).filter((x) => x === 'block-end')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: 'turn-end',
      stopReason: 'end-turn',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 60,
        reasoningTokens: 5,
        durationMs: 1500,
        numTurns: 1,
      },
    })
    expect(t.finished).toBe(true)
  })

  it('un DONE que repite el texto acumulado no lo duplica; uno acumulativo añade solo el resto', () => {
    const a = make()
    const long = 'Respuesta larga y completa.'
    expect(
      textOf(
        run(a, [
          step(1, 'ACTIVE', 'agent_response', { text_delta: 'Respuesta larga ' }),
          step(1, 'ACTIVE', 'agent_response', { text_delta: 'y completa.' }),
          step(1, 'DONE', 'agent_response', { text_delta: long }),
        ]),
      ),
    ).toBe(long)
    const b = make()
    expect(
      textOf(
        run(b, [
          step(1, 'ACTIVE', 'agent_response', { text_delta: 'Respuesta ' }),
          step(1, 'DONE', 'agent_response', { text_delta: 'Respuesta larga' }),
        ]),
      ),
    ).toBe('Respuesta larga')
    // un trozo final corto que no repite nada es un trozo más
    const c = make()
    expect(
      textOf(
        run(c, [
          step(1, 'ACTIVE', 'agent_response', { text_delta: 'ab' }),
          step(1, 'DONE', 'agent_response', { text_delta: 'ab' }),
        ]),
      ),
    ).toBe('abab')
  })

  it('un paso DONE sin ACTIVE previo trae el texto completo', () => {
    const t = make()
    const events = run(t, [
      step(3, 'DONE', 'agent_response', { text_delta: 'Todo junto' }),
      result('SUCCESS', 'Todo junto'),
    ])
    expect(textOf(events)).toBe('Todo junto')
  })

  it('sin texto en el flujo, la respuesta del resultado se muestra', () => {
    const t = make()
    const events = run(t, [result('SUCCESS', 'Solo en el resultado.')])
    expect(textOf(events)).toBe('Solo en el resultado.')
    expect(types(events)).toEqual([
      'session-info',
      'block-start',
      'block-delta',
      'block-end',
      'turn-end',
    ])
  })

  it('con texto en el flujo, la respuesta del resultado no se repite', () => {
    const t = make()
    const events = run(t, [
      step(1, 'DONE', 'agent_response', { text_delta: 'X' }),
      result('SUCCESS', 'X'),
    ])
    expect(textOf(events)).toBe('X')
  })

  it('pasos checkpoint y user_input no producen bloques; los desconocidos se cuentan', () => {
    const t = make()
    const events = run(t, [
      step(0, 'DONE', 'user_input'),
      step(1, 'DONE', 'checkpoint', { usage }),
      step(2, 'DONE', 'futuro'),
      { event: 'step_update', step_update: { state: 'DONE' } },
      { event: 'otro' },
      { event: 'result' },
      42,
      null,
    ])
    expect(events.filter((e) => e.type !== 'session-info')).toEqual([])
    expect(t.ignored).toBe(6)
  })

  it('después del turn-end no procesa nada más', () => {
    const t = make()
    run(t, [result('SUCCESS', 'a')])
    expect(t.feed(step(1, 'DONE', 'agent_response', { text_delta: 'tarde' }))).toEqual([])
  })
})

describe('AgyTranslator: acciones', () => {
  it('run_command: bloque en curso y cierre con la salida', () => {
    const t = make()
    const events = run(t, [
      tool(1, 'ACTIVE', 'run_command', { CommandLine: 'echo hola' }),
      tool(1, 'DONE', 'run_command', { CommandLine: 'echo hola' }, { output: 'hola\r\n' }),
    ])
    const start = events.find((e) => e.type === 'block-start')
    expect(start).toMatchObject({
      block: {
        type: 'action',
        kind: 'exec',
        status: 'running',
        title: 'echo hola',
        tool: 'run_command',
      },
    })
    expect(events.find((e) => e.type === 'block-end')).toMatchObject({
      block: { status: 'ok', output: 'hola\r\n' },
    })
  })

  it('un paso de herramienta solo DONE abre y cierra en el mismo evento', () => {
    const t = make()
    const events = run(t, [tool(1, 'DONE', 'view_file', { AbsolutePath: '/w/a.ts' })])
    expect(types(events)).toEqual(['session-info', 'block-start', 'block-end'])
    expect(events[2]).toMatchObject({ block: { kind: 'read', path: 'a.ts', status: 'ok' } })
  })

  it('un ACTIVE repetido actualiza el bloque', () => {
    const t = make()
    const events = run(t, [
      tool(1, 'ACTIVE', 'run_command', {}),
      tool(1, 'ACTIVE', 'run_command', { CommandLine: 'ls' }),
    ])
    expect(types(events).filter((x) => x !== 'session-info')).toEqual([
      'block-start',
      'block-update',
    ])
  })

  it('write_to_file lleva diff con la ruta relativa a la carpeta de la sesión', () => {
    const t = make('/w')
    const events = run(t, [
      tool(
        1,
        'DONE',
        'write_to_file',
        { TargetFile: '/w/src/a.ts', CodeContent: 'x\n' },
        { output: 'ok' },
      ),
    ])
    const end = events.find((e) => e.type === 'block-end')
    expect(end).toMatchObject({
      block: { kind: 'edit', path: 'src/a.ts', diff: { path: 'src/a.ts' } },
    })
    if (end?.type === 'block-end' && end.block?.type === 'action') {
      expect(end.block.diff?.patch).toContain('+++ b/src/a.ts')
      expect(end.block.diff?.patch).toContain('+x')
      // El salto de línea final no es una línea añadida más.
      expect(end.block.diff?.patch.endsWith('+x')).toBe(true)
      // La entrada que se muestra tampoco lleva la carpeta de la sesión.
      expect(end.block.input).toContain('"TargetFile":"src/a.ts"')
    }
  })

  it('replace_file_content y multi_replace arman el diff de cada reemplazo', () => {
    const t = make('C:\\w')
    const events = run(t, [
      tool(1, 'DONE', 'replace_file_content', {
        TargetFile: 'C:\\w\\a.ts',
        TargetContent: 'a',
        ReplacementContent: 'b',
      }),
      tool(2, 'DONE', 'multi_replace_file_content', {
        TargetFile: 'C:\\w\\b.ts',
        ReplacementChunks: [{ TargetContent: 'x', ReplacementContent: 'y' }, 5],
      }),
    ])
    const ends = events.flatMap((e) => (e.type === 'block-end' ? [e] : []))
    expect(ends[0]).toMatchObject({ block: { path: 'a.ts', diff: { path: 'a.ts' } } })
    expect(ends[0]).toMatchObject({
      block: { input: expect.stringContaining('"TargetFile":"a.ts"') },
    })
    expect(ends[1]).toMatchObject({ block: { path: 'b.ts' } })
  })

  it('una ruta fuera de la carpeta se deja como está', () => {
    const t = make('/w')
    const events = run(t, [tool(1, 'DONE', 'view_file', { AbsolutePath: '/otra/b.ts' })])
    expect(events.find((e) => e.type === 'block-end')).toMatchObject({
      block: { path: '/otra/b.ts' },
    })
  })

  it('un error de la herramienta deja la acción en error con su mensaje', () => {
    const t = make()
    const events = run(t, [
      tool(
        1,
        'DONE',
        'run_command',
        { CommandLine: 'x' },
        { error: { type: 'PERMISSION_DENIED', message: 'denegado' } },
      ),
    ])
    expect(events.find((e) => e.type === 'block-end')).toMatchObject({
      block: { status: 'error', output: 'PERMISSION_DENIED: denegado' },
    })
  })

  it('una salida que no es texto se serializa; una herramienta desconocida es other', () => {
    const t = make()
    const events = run(t, [tool(1, 'DONE', 'mi_herramienta', { a: 1 }, { output: { ok: true } })])
    expect(events.find((e) => e.type === 'block-end')).toMatchObject({
      block: { kind: 'other', title: 'mi_herramienta', output: '{"ok":true}' },
    })
  })

  it('clasifica las herramientas por nombre', () => {
    const kinds = [
      'grep_search',
      'find_by_name',
      'list_dir',
      'read_url_content',
      'command_status',
    ].map((name) => {
      const t = make()
      const events = run(t, [tool(1, 'DONE', name, { Query: 'q', DirectoryPath: '/w/d' })])
      const end = events.find((e) => e.type === 'block-end')
      return end?.type === 'block-end' && end.block?.type === 'action' ? end.block.kind : undefined
    })
    expect(kinds).toEqual(['search', 'search', 'read', 'other', 'exec'])
  })

  it('los subagentes salen como una acción other', () => {
    const t = make()
    const events = run(t, [
      step(1, 'DONE', 'tool', {
        subagent_info: {
          subagents: [{ type_name: 'general', role: 'busca', conversation_id: 'c' }],
        },
      }),
    ])
    expect(events.find((e) => e.type === 'block-end')).toMatchObject({
      block: { kind: 'other', title: 'Subagente general busca' },
    })
  })

  it('al cortar el turno, las acciones abiertas quedan en error y el texto se cierra', () => {
    const t = make()
    run(t, [
      step(1, 'ACTIVE', 'agent_response', { text_delta: 'a' }),
      tool(2, 'ACTIVE', 'run_command', { CommandLine: 'sleep 9' }),
    ])
    const end = t.end('interrupted')
    expect(types(end)).toEqual(['block-end', 'block-end', 'turn-end'])
    expect(end[1]).toMatchObject({ block: { status: 'error' } })
    expect(t.end('error')).toEqual([])
  })
})

describe('AgyTranslator: resultado y errores', () => {
  const stop = (status: string, extra: Record<string, unknown> = {}) => {
    const t = make()
    const events = run(t, [result(status, '', extra)])
    return { events, last: events.at(-1) }
  }

  it('estados del resultado → stopReason', () => {
    expect(stop('SUCCESS').last).toMatchObject({ stopReason: 'end-turn' })
    expect(stop('CANCELED').last).toMatchObject({ stopReason: 'interrupted' })
    expect(stop('INTERRUPTED').last).toMatchObject({ stopReason: 'interrupted' })
    expect(stop('SUCCESS', { finished_reason: 'interrupted' }).last).toMatchObject({
      stopReason: 'interrupted',
    })
    expect(stop('WAITING').last).toMatchObject({ stopReason: 'other' })
    expect(stop('raro').last).toMatchObject({ stopReason: 'other' })
  })

  it('print_timeout: respuesta parcial con aviso', () => {
    const { events, last } = stop('SUCCESS', { finished_reason: 'print_timeout' })
    expect(last).toMatchObject({ stopReason: 'other' })
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: 'PRINT_TIMEOUT', fatal: false },
    })
  })

  it('ERROR trae un bloque de error clasificado y turn-end error', () => {
    const { events, last } = stop('ERROR', { error: { type: 'MODEL', message: 'se rompió' } })
    expect(last).toMatchObject({ stopReason: 'error' })
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: 'AGY_ERROR', fatal: false },
    })
  })

  it('classifyError reconoce sesión, cuota y capacidad', () => {
    expect(classifyError('UNAUTHENTICATED 401')).toMatchObject({
      code: 'AUTH_REQUIRED',
      fatal: true,
    })
    expect(classifyError('You have exhausted your quota')).toMatchObject({ code: 'USAGE_LIMIT' })
    expect(classifyError('service unavailable')).toMatchObject({
      code: 'AGY_UNAVAILABLE',
      retryable: true,
    })
    expect(classifyError(undefined)).toMatchObject({ code: 'AGY_ERROR' })
  })

  it('errorMessage acepta cadena, objeto con tipo y mensaje, y rechaza lo demás', () => {
    expect(errorMessage('x')).toBe('x')
    expect(errorMessage('')).toBeUndefined()
    expect(errorMessage({ type: 'T', message: 'm' })).toBe('T: m')
    expect(errorMessage({ message: 'm' })).toBe('m')
    expect(errorMessage({ type: 'T' })).toBe('T')
    expect(errorMessage(5)).toBeUndefined()
    expect(errorMessage(null)).toBeUndefined()
  })

  it('usageOf descarta lo inválido', () => {
    expect(usageOf(undefined)).toEqual({})
    expect(
      usageOf({ input_tokens: -1, output_tokens: Number.NaN, cache_read_tokens: 3.4 }),
    ).toEqual({
      cacheReadTokens: 3,
    })
  })

  it('el id de conversación se anuncia una vez; uno inválido no se acepta', () => {
    const t = make()
    const events = run(t, [step(0, 'DONE', 'user_input'), result('SUCCESS', 'x')])
    expect(events.filter((e) => e.type === 'session-info')).toHaveLength(1)
    expect(t.conversationId).toBe(CONV)
    const u = make()
    expect(run(u, [init({}, 'no es válido!!')])).toEqual([
      { type: 'session-info', permissionMode: 'ask' },
    ])
    expect(u.conversationId).toBeUndefined()
  })
})
