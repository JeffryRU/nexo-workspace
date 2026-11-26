import { LIMITS, type ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { actionDraft, MAX_CALLS_PER_TURN, stopReasonOf } from '../src/translator.ts'
import {
  deltaText,
  message,
  newTranslator,
  plan,
  run,
  SESSION,
  thought,
  toolCall,
  toolUpdate,
  types,
  upd,
} from './fixtures.ts'

const actions = (events: ProviderEvent[]) =>
  events.flatMap((e) =>
    (e.type === 'block-start' || e.type === 'block-update' || e.type === 'block-end') &&
    e.block?.type === 'action'
      ? [e.block]
      : [],
  )

describe('AcpTranslator: mensajes y pensamientos', () => {
  it('agent_message_chunk → bloque text con deltas; agent_thought_chunk → reasoning', () => {
    const events = run([thought('pienso'), message('Hola '), message('mundo')])
    expect(types(events)).toEqual([
      'block-start',
      'block-delta',
      'block-end',
      'block-start',
      'block-delta',
      'block-delta',
    ])
    expect(events[0]).toMatchObject({ block: { type: 'reasoning', complete: false } })
    expect(events[3]).toMatchObject({ block: { type: 'text' } })
    expect(deltaText(events)).toBe('piensoHola mundo')
  })

  it('cambiar de messageId abre un bloque nuevo; el mismo no', () => {
    const chunk = (text: string, messageId: string) =>
      upd({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
    const events = run([chunk('a', 'm1'), chunk('b', 'm1'), chunk('c', 'm2')])
    expect(events.filter((e) => e.type === 'block-start')).toHaveLength(2)
  })

  it('un texto abierto se cierra al llegar una acción y se abre otro después', () => {
    const events = run([message('antes'), toolCall({}), message('después')])
    expect(types(events)).toEqual([
      'block-start', // texto
      'block-delta',
      'block-end',
      'block-start', // acción
      'block-start', // texto nuevo
      'block-delta',
    ])
  })

  it('contenido que no es texto: enlaces a recursos como Markdown, imagen y audio como marca; lo demás se ignora', () => {
    const chunk = (content: Record<string, unknown>) =>
      upd({ sessionUpdate: 'agent_message_chunk', content })
    const events = run([
      chunk({ type: 'resource_link', name: 'doc', uri: 'file:///a.md' }),
      chunk({ type: 'image', data: 'xx', mimeType: 'image/png' }),
      chunk({ type: 'audio' }),
      chunk({ type: 'resource' }),
    ])
    expect(deltaText(events)).toBe('[doc](file:///a.md)*[imagen]**[audio]*')
  })

  it('user_message_chunk, available_commands_update y demás sin bloque propio se ignoran y se cuentan', () => {
    const t = newTranslator()
    t.beginTurn()
    const events = [
      upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hola' } }),
      upd({ sessionUpdate: 'available_commands_update', availableCommands: [] }),
      upd({ sessionUpdate: 'usage_update', used: 1, size: 2 }),
      upd({ sessionUpdate: 'notice', message: 'x' }),
      upd({ sessionUpdate: 'config_option_update', configOptions: [] }),
    ].flatMap((n) => t.notification(n))
    expect(events).toEqual([])
    expect(t.ignored).toBe(5)
  })

  it('fuera de turno solo pasan los cambios de modo y de título', () => {
    const t = newTranslator((id) => (id === 'plan' ? 'plan' : undefined))
    expect(t.notification(message('suelto'))).toEqual([])
    expect(
      t.notification(upd({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })),
    ).toEqual([{ type: 'session-info', permissionMode: 'plan' }])
    expect(
      t.notification(upd({ sessionUpdate: 'current_mode_update', currentModeId: 'otro' })),
    ).toEqual([])
    expect(
      t.notification(upd({ sessionUpdate: 'session_info_update', title: ' Mi\ntítulo ' })),
    ).toEqual([{ type: 'session-info', title: 'Mi título' }])
    expect(t.notification(upd({ sessionUpdate: 'session_info_update', title: null }))).toEqual([])
  })
})

describe('AcpTranslator: llamadas a herramienta', () => {
  it('tool_call + tool_call_update: alta, actualización y cierre con kind, estado y contenido', () => {
    const events = run([
      toolCall({ kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }),
      toolUpdate({ status: 'in_progress' }),
      toolUpdate({
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }],
        rawOutput: { exitCode: 0 },
      }),
    ])
    expect(types(events)).toEqual(['block-start', 'block-update', 'block-end'])
    const [start, update, end] = actions(events)
    expect(start).toMatchObject({ kind: 'exec', status: 'pending', tool: 'execute', callId: 't1' })
    expect(start?.input).toContain('"command": "ls"')
    expect(update).toMatchObject({ status: 'running' })
    expect(end).toMatchObject({ status: 'ok', output: 'a.txt', exitCode: 0 })
  })

  it('el estado failed → error; un exit code distinto de 0 convierte un completed en error', () => {
    const failed = actions(run([toolCall({ kind: 'read' }), toolUpdate({ status: 'failed' })]))
    expect(failed.at(-1)).toMatchObject({ status: 'error' })
    const bad = actions(
      run([
        toolCall({ kind: 'execute' }),
        toolUpdate({ status: 'completed', rawOutput: { exit_code: 2 } }),
      ]),
    )
    expect(bad.at(-1)).toMatchObject({ status: 'error', exitCode: 2 })
  })

  it('los kinds del protocolo se agrupan; un diff fuerza «edit» y el exitCode solo va en exec', () => {
    const kind = (k: string | undefined) =>
      actionDraft({ toolCallId: 'x', title: 't', ...(k === undefined ? {} : { kind: k }) }).kind
    expect(
      [
        'read',
        'edit',
        'delete',
        'move',
        'search',
        'fetch',
        'execute',
        'think',
        'switch_mode',
        'other',
      ].map(kind),
    ).toEqual([
      'read',
      'edit',
      'edit',
      'edit',
      'search',
      'search',
      'exec',
      'other',
      'other',
      'other',
    ])
    expect(kind(undefined)).toBe('other')
    const withDiff = actionDraft({
      toolCallId: 'x',
      title: 't',
      kind: 'other',
      content: [{ type: 'diff', path: '/a', oldText: 'a\n', newText: 'b\n' }],
    })
    expect(withDiff.kind).toBe('edit')
    expect(withDiff.diff?.path).toBe('/a')
    expect(
      actionDraft({ toolCallId: 'x', title: 't', kind: 'read', rawOutput: { exitCode: 0 } }),
    ).not.toHaveProperty('exitCode')
  })

  it('varios diffs en una llamada se combinan; sin cambios no hay diff', () => {
    const d = actionDraft({
      toolCallId: 'x',
      title: 't',
      content: [
        { type: 'diff', path: '/a', oldText: 'a\n', newText: 'b\n' },
        { type: 'diff', path: '/b', oldText: null, newText: 'nuevo\n' },
        { type: 'diff', path: '/c', oldText: 'igual\n', newText: 'igual\n' },
      ],
    })
    expect(d.path).toBe('/a')
    expect(d.diff?.patch).toContain('+++ b/a')
    expect(d.diff?.patch).toContain('--- /dev/null')
    expect(d.diff?.patch).not.toContain('/c')
    const none = actionDraft({
      toolCallId: 'x',
      title: 't',
      content: [{ type: 'diff', path: '/c', oldText: 'igual\n', newText: 'igual\n' }],
    })
    expect(none.diff).toBeUndefined()
  })

  it('la ruta sale de locations; el título cae al nombre; rawOutput sin contenido sirve de salida', () => {
    const d = actionDraft({
      toolCallId: 'x',
      title: '',
      name: 'grep',
      kind: 'search',
      locations: [{ path: '/proyecto/a.ts', line: 3 }],
      rawOutput: 'resultado',
    })
    expect(d).toMatchObject({
      path: '/proyecto/a.ts',
      title: 'grep',
      tool: 'grep',
      output: 'resultado',
    })
  })

  it('un tool_call_update sin tool_call crea la acción; uno tardío tras cerrarla no la reabre', () => {
    const events = run([
      toolUpdate({ toolCallId: 'z', title: 'Sin alta', status: 'completed', kind: 'read' }),
      toolUpdate({ toolCallId: 'z', status: 'in_progress' }),
    ])
    expect(types(events)).toEqual(['block-start', 'block-end'])
  })

  it('una actualización sin cambios no emite eventos', () => {
    const events = run([toolCall({ status: 'in_progress' }), toolUpdate({ status: 'in_progress' })])
    expect(types(events)).toEqual(['block-start'])
  })

  it('una salida enorme se recorta y se marca truncada', () => {
    const big = 'x'.repeat(LIMITS.maxBlockTextBytes + 10)
    const events = run([
      toolCall({ kind: 'execute' }),
      toolUpdate({
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: big } }],
      }),
    ])
    const end = actions(events).at(-1)
    expect(end?.truncated).toBe(true)
    expect(new TextEncoder().encode(end?.output ?? '').length).toBeLessThanOrEqual(
      LIMITS.maxBlockTextBytes,
    )
  })

  it('un turno sin cerrar sus acciones las deja en error y cierra los bloques abiertos', () => {
    const t = newTranslator()
    t.beginTurn()
    const events = [
      ...t.notification(message('texto')),
      ...t.notification(toolCall({ kind: 'execute', status: 'in_progress' })),
      ...t.notification(plan([{ content: 'uno', status: 'pending' }])),
      ...t.end('interrupted'),
    ]
    const ends = events.filter((e) => e.type === 'block-end')
    expect(ends).toHaveLength(3)
    expect(actions(events).at(-1)).toMatchObject({ status: 'error' })
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'interrupted' })
    expect(t.finished).toBe(true)
  })

  it('no sigue más de MAX_CALLS_PER_TURN llamadas distintas', () => {
    const t = newTranslator()
    t.beginTurn()
    let started = 0
    for (let i = 0; i < MAX_CALLS_PER_TURN + 5; i++) {
      started += t.notification(toolCall({ toolCallId: `c${i}` })).length
    }
    expect(started).toBe(MAX_CALLS_PER_TURN)
    expect(t.ignored).toBe(5)
  })
})

describe('AcpTranslator: plan', () => {
  it('plan → bloque plan (alta y reemplazos), con los estados normalizados', () => {
    const events = run([
      plan([
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'completed' },
        { content: 'd', status: 'rara' },
      ]),
      plan([{ content: 'a', status: 'completed' }]),
    ])
    expect(types(events)).toEqual(['block-start', 'block-update'])
    expect(events[0]).toMatchObject({
      block: {
        type: 'plan',
        entries: [
          { text: 'a', status: 'pending' },
          { text: 'b', status: 'in-progress' },
          { text: 'c', status: 'completed' },
          { text: 'd', status: 'pending' },
        ],
      },
    })
  })

  it('un plan idéntico no repite el evento y las entradas inválidas se saltan', () => {
    const same = plan([{ content: 'a', status: 'pending' }])
    const events = run([
      same,
      same,
      upd({
        sessionUpdate: 'plan',
        entries: [{ nada: 1 }, 5, { content: '  ', status: 'pending' }],
      }),
    ])
    expect(types(events)).toEqual(['block-start', 'block-update'])
    expect(events[1]).toMatchObject({ block: { entries: [] } })
  })

  it('plan_update con items y con markdown, por planId', () => {
    const events = run([
      upd({
        sessionUpdate: 'plan_update',
        plan: {
          type: 'items',
          planId: 'p1',
          entries: [{ content: 'x', priority: 'low', status: 'pending' }],
        },
      }),
      upd({
        sessionUpdate: 'plan_update',
        plan: { type: 'markdown', planId: 'p2', content: '# Plan\n- uno' },
      }),
    ])
    expect(types(events)).toEqual(['block-start', 'block-start'])
    expect(events[1]).toMatchObject({
      block: { type: 'plan', entries: [], markdown: '# Plan\n- uno' },
    })
  })

  it('limita las entradas del plan', () => {
    const entries = Array.from({ length: LIMITS.maxPlanEntries + 20 }, (_, i) => ({
      content: `e${i}`,
      status: 'pending',
    }))
    const events = run([plan(entries)])
    expect(events[0]).toMatchObject({ block: { type: 'plan' } })
    expect((events[0] as { block: { entries: unknown[] } }).block.entries).toHaveLength(
      LIMITS.maxPlanEntries,
    )
  })
})

describe('AcpTranslator: fin de turno', () => {
  it('los stopReason de ACP se traducen', () => {
    expect(
      [
        'end_turn',
        'max_tokens',
        'max_turn_requests',
        'refusal',
        'cancelled',
        'inventado',
        undefined,
      ].map(stopReasonOf),
    ).toEqual(['end-turn', 'max-tokens', 'max-turns', 'refusal', 'interrupted', 'other', 'other'])
  })

  it('un solo turn-end por turno; el uso y el error van en él; interrumpido gana salvo error', () => {
    const t = newTranslator()
    t.beginTurn()
    const events = t.end('end-turn', {
      usage: { inputTokens: 1 },
      problem: { code: 'X', message: 'mal' },
    })
    expect(types(events)).toEqual(['error', 'turn-end'])
    expect(events[1]).toMatchObject({ stopReason: 'end-turn', usage: { inputTokens: 1 } })
    expect(t.end('end-turn')).toEqual([])
    t.beginTurn()
    t.markInterrupted()
    expect(t.end('end-turn').at(-1)).toMatchObject({ stopReason: 'interrupted' })
    t.beginTurn()
    t.markInterrupted()
    expect(t.end('error').at(-1)).toMatchObject({ stopReason: 'error' })
  })

  it('mensajes de otro formato (params no objeto, sin update) se cuentan y no lanzan', () => {
    const t = newTranslator()
    t.beginTurn()
    for (const bad of [
      null,
      5,
      'x',
      {},
      { sessionId: SESSION },
      { sessionId: SESSION, update: 3 },
    ]) {
      expect(t.notification(bad)).toEqual([])
    }
    expect(t.ignored).toBe(6)
  })
})
