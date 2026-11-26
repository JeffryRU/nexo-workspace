import { ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { planApproval } from '../src/approvals.ts'
import { CodexTranslator, classifyError } from '../src/translator.ts'
import {
  agentMessage,
  command,
  completed,
  fileChange,
  messageDelta,
  type Note,
  note,
  outputDelta,
  reasoning,
  started,
  summaryDelta,
  THREAD,
  TURN,
  tokenUsage,
  turnCompleted,
  turnStarted,
} from './fixtures.ts'

function run(notes: Note[]): ProviderEvent[] {
  let n = 0
  const t = new CodexTranslator({ nextRef: () => `r${++n}` })
  t.beginTurn()
  const events: ProviderEvent[] = []
  for (const x of notes) events.push(...t.notification(x.method, x.params))
  for (const e of events) expect(ProviderEvent.safeParse(e).success, JSON.stringify(e)).toBe(true)
  return events
}

const types = (events: ProviderEvent[]) => events.map((e) => e.type)
const text = (events: ProviderEvent[]) =>
  events.flatMap((e) => (e.type === 'block-delta' && e.field === 'text' ? [e.text] : [])).join('')

describe('CodexTranslator: mensajes y razonamiento', () => {
  it('un mensaje del agente con deltas → text', () => {
    const events = run([
      turnStarted(),
      started(agentMessage('m1')),
      messageDelta('m1', 'Hola '),
      messageDelta('m1', 'mundo'),
      completed(agentMessage('m1', 'Hola mundo')),
      turnCompleted('completed', { durationMs: 321 }),
    ])
    expect(types(events)).toEqual([
      'block-start',
      'block-delta',
      'block-delta',
      'block-end',
      'turn-end',
    ])
    expect(events[0]).toMatchObject({ block: { type: 'text', text: '', complete: false } })
    expect(text(events)).toBe('Hola mundo')
    expect(events.at(-1)).toEqual({
      type: 'turn-end',
      stopReason: 'end-turn',
      usage: { durationMs: 321 },
    })
  })

  it('sin deltas, el texto final del item se entrega completo', () => {
    const events = run([started(agentMessage('m1')), completed(agentMessage('m1', 'de golpe'))])
    expect(types(events)).toEqual(['block-start', 'block-delta', 'block-end'])
    expect(text(events)).toBe('de golpe')
  })

  it('un item que llega ya completado (sin started) también produce el bloque', () => {
    const events = run([completed(agentMessage('m1', 'solo final'))])
    expect(text(events)).toBe('solo final')
    expect(types(events)).toEqual(['block-start', 'block-delta', 'block-end'])
  })

  it('si el final trae más que los deltas, añade el resto; si no coincide, no duplica', () => {
    const more = run([
      started(agentMessage('m1')),
      messageDelta('m1', 'Hola'),
      completed(agentMessage('m1', 'Hola mundo')),
    ])
    expect(text(more)).toBe('Hola mundo')
    const other = run([
      started(agentMessage('m1')),
      messageDelta('m1', 'Hola'),
      completed(agentMessage('m1', 'Otra cosa')),
    ])
    expect(text(other)).toBe('Hola')
  })

  it('un mensaje vacío no deja bloque', () => {
    expect(run([started(agentMessage('m1')), completed(agentMessage('m1', ''))])).toEqual([])
  })

  it('razonamiento: partes del resumen separadas por párrafo', () => {
    const events = run([
      started(reasoning('r1')),
      summaryDelta('r1', 'Primero ', 0),
      summaryDelta('r1', 'miro.', 0),
      summaryDelta('r1', 'Luego edito.', 1),
      completed(reasoning('r1', ['Primero miro.', 'Luego edito.'])),
    ])
    expect(events[0]).toMatchObject({ block: { type: 'reasoning' } })
    expect(text(events)).toBe('Primero miro.\n\nLuego edito.')
  })

  it('razonamiento sin deltas usa el resumen (o el contenido) del item final', () => {
    expect(text(run([completed(reasoning('r1', ['a', 'b']))]))).toBe('a\n\nb')
    expect(text(run([completed(reasoning('r1', [], ['crudo']))]))).toBe('crudo')
    expect(run([started(reasoning('r1')), completed(reasoning('r1'))])).toEqual([])
  })

  it('los deltas se sanean y un par sustituto partido no se rompe', () => {
    const events = run([
      started(agentMessage('m1')),
      messageDelta('m1', 'a\u0000\ud83d'),
      messageDelta('m1', '\ude00b'),
      completed(agentMessage('m1', 'a�😀b')),
    ])
    expect(text(events)).toBe('a�😀b')
  })

  it('un delta enorme se parte en trozos de a lo sumo 32 KiB', () => {
    const big = 'é'.repeat(100_000)
    const events = run([started(agentMessage('m1')), messageDelta('m1', big)])
    const parts = events.filter((e) => e.type === 'block-delta')
    expect(parts.length).toBeGreaterThan(3)
    expect(text(events)).toBe(big)
  })
})

describe('CodexTranslator: acciones', () => {
  it('comando → action exec con salida por deltas, código y duración', () => {
    const events = run([
      started(command('c1')),
      outputDelta('c1', 'a\n'),
      outputDelta('c1', 'b\n'),
      completed(
        command('c1', {
          status: 'completed',
          aggregatedOutput: 'a\nb\n',
          exitCode: 0,
          durationMs: 40,
        }),
      ),
    ])
    expect(events[0]).toMatchObject({
      type: 'block-start',
      block: { type: 'action', kind: 'exec', status: 'running', tool: 'shell', input: 'ls -la' },
    })
    expect(events.filter((e) => e.type === 'block-delta')).toEqual([
      { type: 'block-delta', ref: 'r1', field: 'output', text: 'a\n' },
      { type: 'block-delta', ref: 'r1', field: 'output', text: 'b\n' },
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'block-end',
      block: { status: 'ok', output: 'a\nb\n', exitCode: 0, durationMs: 40 },
    })
  })

  it('un código de salida distinto de cero deja la acción en error', () => {
    const events = run([
      started(command('c1')),
      completed(command('c1', { status: 'completed', aggregatedOutput: 'fallo', exitCode: 2 })),
    ])
    expect(events.at(-1)).toMatchObject({ block: { status: 'error', exitCode: 2 } })
  })

  it('un comando rechazado queda en error y sin código', () => {
    const events = run([started(command('c1')), completed(command('c1', { status: 'declined' }))])
    const end = events.at(-1)
    expect(end).toMatchObject({ block: { status: 'error' } })
    expect(end?.type === 'block-end' && end.block && 'exitCode' in end.block).toBe(false)
  })

  it('si el item final no trae salida se usa la recibida por deltas', () => {
    const events = run([
      started(command('c1')),
      outputDelta('c1', 'x'),
      completed(command('c1', { status: 'completed', exitCode: 0 })),
    ])
    expect(events.at(-1)).toMatchObject({ block: { output: 'x' } })
  })

  it('cambio de archivo → action edit con diff y ruta', () => {
    const events = run([
      started(fileChange('f1')),
      completed(fileChange('f1', { status: 'completed' })),
    ])
    expect(events[0]).toMatchObject({
      block: {
        kind: 'edit',
        status: 'running',
        tool: 'apply_patch',
        title: 'Editar src/a.ts',
        path: 'src/a.ts',
        diff: { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      },
    })
    expect(events.at(-1)).toMatchObject({ block: { status: 'ok' } })
  })

  it('varios archivos: un diff combinado; crear y eliminar tienen su verbo', () => {
    const many = run([
      started(
        fileChange('f1', {
          changes: [
            { path: 'a.ts', kind: { type: 'add' }, diff: 'uno' },
            { path: 'b.ts', kind: { type: 'delete' }, diff: 'dos' },
          ],
        }),
      ),
    ])
    expect(many[0]).toMatchObject({
      block: { title: 'Editar 2 archivos', diff: { patch: '--- a.ts\nuno\n--- b.ts\ndos' } },
    })
    const add = run([
      started(fileChange('f2', { changes: [{ path: 'n.ts', kind: { type: 'add' }, diff: 'x' }] })),
    ])
    expect(add[0]).toMatchObject({ block: { title: 'Crear n.ts' } })
  })

  it('patchUpdated actualiza el diff del bloque abierto', () => {
    const events = run([
      started(fileChange('f1', { changes: [] })),
      note('item/fileChange/patchUpdated', {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'f1',
        changes: [{ path: 'z.ts', kind: { type: 'add' }, diff: '+z' }],
      }),
    ])
    expect(events[1]).toMatchObject({
      type: 'block-update',
      block: { path: 'z.ts', title: 'Crear z.ts' },
    })
  })

  it('búsqueda web → action search', () => {
    const item = {
      type: 'webSearch',
      id: 'w1',
      query: 'nexo',
      action: { type: 'search', query: 'nexo', queries: null },
      results: null,
    }
    const events = run([started(item), completed(item)])
    expect(events[0]).toMatchObject({
      block: { kind: 'search', tool: 'web_search', title: 'Buscar: nexo', input: 'nexo' },
    })
    expect(events.at(-1)).toMatchObject({ block: { status: 'ok' } })
    const page = run([
      completed({
        type: 'webSearch',
        id: 'w2',
        query: '',
        action: { type: 'openPage', url: 'https://x.dev' },
      }),
    ])
    expect(page[0]).toMatchObject({ block: { title: 'Abrir https://x.dev' } })
  })

  it('llamada MCP → action other con argumentos y resultado de texto', () => {
    const mcp = {
      type: 'mcpToolCall',
      id: 'k1',
      server: 'git',
      tool: 'status',
      arguments: { repo: '.' },
      error: null,
    }
    const events = run([
      started({ ...mcp, status: 'inProgress', result: null }),
      completed({
        ...mcp,
        status: 'completed',
        result: { content: [{ type: 'text', text: 'limpio' }, { type: 'image' }] },
        durationMs: 5,
      }),
    ])
    expect(events[0]).toMatchObject({
      block: {
        kind: 'other',
        tool: 'mcp__git__status',
        title: 'git: status',
        input: '{"repo":"."}',
      },
    })
    expect(events.at(-1)).toMatchObject({
      block: { status: 'ok', output: 'limpio\n{"type":"image"}', durationMs: 5 },
    })
    const failed = run([
      completed({ ...mcp, status: 'failed', result: null, error: { message: 'no hay repo' } }),
    ])
    expect(failed.at(-1)).toMatchObject({ block: { status: 'error', output: 'no hay repo' } })
  })

  it('herramienta dinámica, subagente e imagen también son acciones', () => {
    const events = run([
      completed({
        type: 'dynamicToolCall',
        id: 'd1',
        namespace: 'ns',
        tool: 't',
        arguments: { a: 1 },
        status: 'completed',
        success: false,
      }),
      completed({
        type: 'collabAgentToolCall',
        id: 'k2',
        tool: 'spawnAgent',
        status: 'completed',
        prompt: 'haz algo',
      }),
      completed({ type: 'imageView', id: 'i1', path: '/w/a.png' }),
    ])
    const blocks = events.flatMap((e) => (e.type === 'block-end' && e.block ? [e.block] : []))
    expect(blocks[0]).toMatchObject({ kind: 'other', tool: 'ns__t', status: 'error' })
    expect(blocks[1]).toMatchObject({ kind: 'other', tool: 'collab_spawnAgent', input: 'haz algo' })
    expect(blocks[2]).toMatchObject({ kind: 'read', path: '/w/a.png' })
  })

  it('items internos o desconocidos se ignoran y se cuentan', () => {
    const t = new CodexTranslator({ nextRef: () => 'r' })
    t.beginTurn()
    for (const item of [
      { type: 'contextCompaction', id: 'x' },
      { type: 'tipoNuevo', id: 'y' },
      { type: 'commandExecution', id: 'z', command: 5 },
    ]) {
      expect(t.notification('item/completed', { threadId: THREAD, turnId: TURN, item })).toEqual([])
    }
    expect(t.ignored).toBe(3)
    expect(t.notification('item/agentMessage/delta', { nada: 1 })).toEqual([])
    expect(t.notification('metodo/desconocido', {})).toEqual([])
  })

  it('al terminar el turno las acciones abiertas se cierran en error y los textos se cierran', () => {
    const events = run([
      started(command('c1')),
      started(agentMessage('m1')),
      messageDelta('m1', 'a'),
      turnCompleted('interrupted'),
    ])
    expect(types(events)).toEqual([
      'block-start',
      'block-start',
      'block-delta',
      'block-end',
      'block-end',
      'turn-end',
    ])
    expect(events[3]).toMatchObject({ block: { status: 'error' } })
    expect(events.at(-1)).toMatchObject({ stopReason: 'interrupted' })
  })
})

describe('CodexTranslator: turno, uso y errores', () => {
  it('estados del turno → motivo de parada', () => {
    const stop = (status: Parameters<typeof turnCompleted>[0]) =>
      run([turnStarted(), turnCompleted(status)]).at(-1)
    expect(stop('completed')).toMatchObject({ stopReason: 'end-turn' })
    expect(stop('interrupted')).toMatchObject({ stopReason: 'interrupted' })
    expect(stop('failed')).toMatchObject({ stopReason: 'error' })
    expect(stop('inProgress')).toMatchObject({ stopReason: 'other' })
  })

  it('markInterrupted fuerza interrupted aunque Codex diga completed, pero no oculta un fallo', () => {
    const t = new CodexTranslator({ nextRef: () => 'r' })
    t.beginTurn()
    t.markInterrupted()
    expect(
      t.notification('turn/completed', turnCompleted('completed').params).at(-1),
    ).toMatchObject({
      stopReason: 'interrupted',
    })
    t.beginTurn()
    t.markInterrupted()
    expect(t.notification('turn/completed', turnCompleted('failed').params).at(-1)).toMatchObject({
      stopReason: 'error',
    })
  })

  it('uso: acumulado del turno = total − referencia, y se repite en turn-end', () => {
    const events = run([
      turnStarted(),
      tokenUsage([100, 50], [100, 50]),
      tokenUsage([130, 70], [30, 20]),
      turnCompleted('completed', { durationMs: 9 }),
    ])
    const usages = events.filter((e) => e.type === 'usage')
    expect(usages).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 130,
          outputTokens: 70,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'turn-end',
      usage: { inputTokens: 130, outputTokens: 70, durationMs: 9 },
    })
  })

  it('el segundo turno parte del total del anterior; en un hilo reanudado, de total − last', () => {
    let n = 0
    const t = new CodexTranslator({ nextRef: () => `r${++n}` })
    t.beginTurn()
    t.notification('thread/tokenUsage/updated', tokenUsage([100, 50], [100, 50]).params)
    t.notification('turn/completed', turnCompleted().params)
    t.beginTurn()
    const second = t.notification(
      'thread/tokenUsage/updated',
      tokenUsage([160, 80], [60, 30]).params,
    )
    expect(second[0]).toMatchObject({ usage: { inputTokens: 60, outputTokens: 30 } })
    const fresh = new CodexTranslator({ nextRef: () => 'r' })
    fresh.beginTurn()
    const resumed = fresh.notification(
      'thread/tokenUsage/updated',
      tokenUsage([5000, 900], [40, 10]).params,
    )
    expect(resumed[0]).toMatchObject({ usage: { inputTokens: 40, outputTokens: 10 } })
  })

  it('notificaciones de otro turno se ignoran; tras finished no se acepta nada', () => {
    const events = run([
      turnStarted(),
      note('item/completed', {
        threadId: THREAD,
        turnId: 'otro',
        item: agentMessage('m1', 'ajeno'),
        completedAtMs: 1,
      }),
      turnCompleted('completed', { id: 'otro' }),
      turnCompleted(),
      completed(agentMessage('m2', 'tarde')),
    ])
    expect(types(events)).toEqual(['turn-end'])
  })

  it('error con reintento se calla; sin reintento es un bloque error y turn/completed no lo repite', () => {
    const events = run([
      turnStarted(),
      note('error', {
        threadId: THREAD,
        turnId: TURN,
        willRetry: true,
        error: { message: 'reconectando' },
      }),
      note('error', {
        threadId: THREAD,
        turnId: TURN,
        willRetry: false,
        error: { message: 'límite', codexErrorInfo: 'usageLimitExceeded' },
      }),
      turnCompleted('failed', {
        error: { message: 'límite', codexErrorInfo: 'usageLimitExceeded' },
      }),
    ])
    expect(types(events)).toEqual(['error', 'turn-end'])
    expect(events[0]).toMatchObject({ error: { code: 'USAGE_LIMIT', fatal: false } })
    expect(events[1]).toMatchObject({ stopReason: 'error' })
  })

  it('un turno fallido sin notificación de error muestra el error del turno', () => {
    const events = run([
      turnCompleted('failed', {
        error: { message: 'no autorizado', codexErrorInfo: 'unauthorized' },
      }),
    ])
    expect(events[0]).toMatchObject({ error: { code: 'AUTH_REQUIRED', fatal: true } })
  })

  it('classifyError reconoce cadenas y objetos de una clave', () => {
    expect(classifyError('x', 'contextWindowExceeded').code).toBe('CONTEXT_WINDOW')
    expect(classifyError('x', { httpConnectionFailed: { httpStatusCode: 502 } })).toMatchObject({
      code: 'CODEX_UNAVAILABLE',
      retryable: true,
    })
    expect(classifyError('x', 'rateLimitExceeded')).toMatchObject({
      code: 'RATE_LIMIT',
      retryable: true,
    })
    expect(classifyError('x', null).code).toBe('CODEX_ERROR')
  })

  it('end() cierra el turno una sola vez, con el problema indicado', () => {
    const t = new CodexTranslator({ nextRef: () => 'r' })
    t.beginTurn()
    t.notification('item/started', started(command('c1')).params)
    const events = t.end('error', { code: 'TIMEOUT', message: 'tarda', retryable: true })
    expect(types(events)).toEqual(['block-end', 'error', 'turn-end'])
    expect(t.end('interrupted')).toEqual([])
    expect(t.finished).toBe(true)
    expect(t.stopReason).toBe('error')
  })

  it('serverRequest/resolved se interpreta aparte', () => {
    expect(CodexTranslator.resolvedRequest({ threadId: 't', requestId: 7 })).toBe(7)
    expect(CodexTranslator.resolvedRequest({ requestId: {} })).toBeUndefined()
  })
})

describe('planApproval', () => {
  it('comando: opciones y respuestas exactas del protocolo', () => {
    const plan = planApproval('item/commandExecution/requestApproval', {
      kind: 'command',
      command: 'npm test',
      cwd: '/w',
      reason: 'necesita red',
    })
    expect(plan).toMatchObject({ tool: 'shell', title: 'Ejecutar: npm test' })
    expect(plan?.detail).toBe('npm test\nCarpeta: /w\nMotivo: necesita red')
    expect(plan?.options.map((o) => o.kind)).toEqual(['allow-once', 'allow-always', 'reject-once'])
    expect(plan?.responses).toEqual({
      allow: { decision: 'accept' },
      'allow-session': { decision: 'acceptForSession' },
      reject: { decision: 'decline' },
    })
    expect(plan?.cancel).toEqual({ decision: 'cancel' })
  })

  it('entrada a un proceso y comando sin texto', () => {
    expect(
      planApproval('item/commandExecution/requestApproval', { kind: 'writeStdin' }),
    ).toMatchObject({
      tool: 'shell-stdin',
    })
    expect(planApproval('item/commandExecution/requestApproval', {})?.title).toBe(
      'Ejecutar un comando',
    )
  })

  it('parches y permisos adicionales', () => {
    expect(
      planApproval('item/fileChange/requestApproval', { grantRoot: '/w', reason: null }),
    ).toMatchObject({
      tool: 'apply_patch',
      detail: 'Escritura en: /w',
    })
    const perms = planApproval('item/permissions/requestApproval', {
      cwd: '/w',
      reason: 'red',
      permissions: { network: { enabled: true }, fileSystem: null },
    })
    expect(perms?.responses.allow).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    })
    expect(perms?.responses['allow-session']).toMatchObject({ scope: 'session' })
    expect(perms?.responses.reject).toEqual({ permissions: {}, scope: 'turn' })
  })

  it('métodos desconocidos o parámetros rotos no producen plan', () => {
    expect(planApproval('item/tool/call', {})).toBeUndefined()
    expect(planApproval('item/permissions/requestApproval', { permissions: 5 })).toBeUndefined()
    expect(planApproval('item/commandExecution/requestApproval', 'x')).toBeUndefined()
    expect(planApproval('item/fileChange/requestApproval', null)).toBeUndefined()
  })

  it('el detalle se acota a 16 KiB', () => {
    const plan = planApproval('item/commandExecution/requestApproval', {
      command: 'x'.repeat(100_000),
    })
    expect(new TextEncoder().encode(plan?.detail ?? '').length).toBeLessThanOrEqual(16 * 1024)
  })
})
