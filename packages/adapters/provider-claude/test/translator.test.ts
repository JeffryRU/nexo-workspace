import type { ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { ClaudeTranslator, fromClaudePermissionMode } from '../src/translator.ts'
import { fixture, result, streamStart, streamText, translateAll, types } from './helpers.ts'

const deltaText = (events: ProviderEvent[], ref: string) =>
  events
    .filter((e) => e.type === 'block-delta' && e.ref === ref)
    .map((e) => (e.type === 'block-delta' ? e.text : ''))
    .join('')

describe('traducción de transcripciones grabadas', () => {
  it('texto y razonamiento en streaming: un bloque por contenido, deltas y un solo turn-end', () => {
    const { events } = translateAll(fixture('text-stream'))
    expect(events[0]).toEqual({
      type: 'session-info',
      providerSessionId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      model: 'claude-sonnet-5-5',
      permissionMode: 'ask',
    })
    const starts = events.filter((e) => e.type === 'block-start')
    expect(starts.map((e) => e.block.type)).toEqual(['reasoning', 'text'])
    expect(new Set(starts.map((e) => e.ref)).size).toBe(2)
    const [reasoning, text] = starts
    expect(deltaText(events, reasoning?.ref ?? '')).toBe('El usuario saluda.')
    expect(deltaText(events, text?.ref ?? '')).toBe('Hola, ¿en qué te ayudo? 👋')
    expect(events.filter((e) => e.type === 'block-end')).toHaveLength(2)
    // los mensajes `assistant` completos no duplican el texto ya enviado por deltas
    expect(events.filter((e) => e.type === 'block-start')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1)
    expect(events[events.length - 1]).toEqual({
      type: 'turn-end',
      stopReason: 'end-turn',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        costUsd: 0.0123,
        durationMs: 1200,
        numTurns: 1,
      },
    })
  })

  it('herramientas: kind inferido, pending -> running -> ok/error, diff y exitCode', () => {
    const { events } = translateAll(fixture('tools'))
    const starts = events.filter((e) => e.type === 'block-start')
    expect(
      starts.map((e) =>
        e.block.type === 'action' ? [e.block.tool, e.block.kind, e.block.status] : [],
      ),
    ).toEqual([
      ['Read', 'read', 'pending'],
      ['Edit', 'edit', 'pending'],
      ['Bash', 'exec', 'pending'],
      ['Grep', 'search', 'pending'],
    ])
    const ref = (tool: string) =>
      starts.find((e) => e.block.type === 'action' && e.block.tool === tool)?.ref ?? ''
    const updates = events.filter((e) => e.type === 'block-update')
    const edit = updates.find((e) => e.ref === ref('Edit'))
    expect(edit?.block).toMatchObject({
      status: 'running',
      path: '/work/a.ts',
      title: 'Editar /work/a.ts',
    })
    expect(edit?.block.type === 'action' ? edit.block.diff?.patch : '').toContain('-dos')
    expect(edit?.block.type === 'action' ? edit.block.diff?.patch : '').toContain('+tres')
    expect(updates.find((e) => e.ref === ref('Bash'))?.block).toMatchObject({
      title: 'Ejecutar las pruebas',
    })

    const ends = events.filter((e) => e.type === 'block-end')
    const endOf = (tool: string) => ends.find((e) => e.ref === ref(tool))?.block
    expect(endOf('Read')).toMatchObject({ status: 'ok', output: '1\tconst a = 1' })
    expect(endOf('Edit')).toMatchObject({ status: 'ok', output: 'El archivo se editó.' })
    expect(endOf('Bash')).toMatchObject({ status: 'error', exitCode: 1 })
    expect(endOf('Grep')).toMatchObject({ status: 'ok', output: 'a.ts:3' })
    expect(types(events).filter((t) => t === 'turn-end')).toHaveLength(1)
  })

  it('sin parciales: texto completo, TodoWrite como plan único por turno, resultados huérfanos ignorados', () => {
    const { events, translator } = translateAll(fixture('todo-nonstreamed'))
    const starts = events.filter((e) => e.type === 'block-start')
    expect(starts.map((e) => e.block.type)).toEqual(['reasoning', 'text', 'plan', 'action'])
    const plan = starts.find((e) => e.block.type === 'plan')
    expect(plan?.block).toEqual({
      type: 'plan',
      entries: [
        { text: 'Leer', status: 'in-progress' },
        { text: 'Escribir', status: 'pending' },
      ],
    })
    const planUpdate = events.find((e) => e.type === 'block-update' && e.ref === plan?.ref)
    expect(
      planUpdate?.type === 'block-update' &&
        planUpdate.block.type === 'plan' &&
        planUpdate.block.entries[0],
    ).toEqual({
      text: 'Leer',
      status: 'completed',
    })
    // AskUserQuestion no abre bloque; la herramienta MCP es `other`
    expect(starts.find((e) => e.block.type === 'action')?.block).toMatchObject({
      kind: 'other',
      tool: 'mcp__x__y',
    })
    expect(translator.stats.orphanResults).toBe(1)
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', stopReason: 'max-tokens' })
  })

  it('error de autenticación: un bloque error claro con las dos opciones, fatal, y turn-end', () => {
    const { events } = translateAll(fixture('auth-error'))
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    const err = errors[0]
    expect(err?.type === 'error' && err.error).toMatchObject({ code: 'AUTH_REQUIRED', fatal: true })
    expect(err?.type === 'error' && err.error.message).toContain('ANTHROPIC_API_KEY')
    expect(err?.type === 'error' && err.error.message).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(err?.type === 'error' && err.error.message).toContain('claude setup-token')
    // el texto sintético "Invalid API key" no se muestra como mensaje del agente
    expect(events.some((e) => e.type === 'block-start')).toBe(false)
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', stopReason: 'error' })
  })

  it('interrupción: cierra lo abierto, termina con interrupted y no añade error', () => {
    const translator = new ClaudeTranslator()
    translator.beginTurn()
    const messages = fixture('interrupted')
    const events: ProviderEvent[] = []
    for (const m of messages.slice(0, -1)) events.push(...translator.translate(m))
    translator.markInterrupted()
    events.push(...translator.translate(messages[messages.length - 1]))
    const t = types(events)
    expect(t.filter((x) => x === 'turn-end')).toHaveLength(1)
    expect(t).not.toContain('error')
    expect(t[t.length - 1]).toBe('turn-end')
    expect(events[events.length - 1]).toMatchObject({ stopReason: 'interrupted' })
    // el bloque de texto y la acción abierta se cerraron antes del fin de turno
    const ends = events.filter((e) => e.type === 'block-end')
    expect(ends).toHaveLength(2)
    expect(ends.some((e) => e.block?.type === 'action' && e.block.status === 'error')).toBe(true)
  })
})

describe('casos concretos del traductor', () => {
  it('el costo por turno es la diferencia del acumulado', () => {
    const t = new ClaudeTranslator()
    const turn = (total: number) => {
      t.beginTurn()
      const e = t.translate(result({ total_cost_usd: total }))
      const end = e.find((x) => x.type === 'turn-end')
      return end?.type === 'turn-end' ? end.usage?.costUsd : undefined
    }
    expect(turn(0.25)).toBe(0.25)
    expect(turn(0.75)).toBe(0.5)
    expect(turn(0.1)).toBe(0.1)
  })

  it('un abandono sin result descarta el result tardío y no cierra el turno siguiente', () => {
    const t = new ClaudeTranslator()
    t.beginTurn()
    const abandoned = t.abandonTurn('interrupted')
    expect(abandoned).toEqual([{ type: 'turn-end', stopReason: 'interrupted' }])
    t.beginTurn()
    expect(t.translate(result())).toEqual([])
    expect(t.turnActive).toBe(true)
    expect(t.translate(result())[0]).toMatchObject({ type: 'turn-end' })
    expect(t.abandonTurn('interrupted')).toEqual([])
  })

  it('mensajes fuera de turno no producen eventos', () => {
    const t = new ClaudeTranslator()
    expect(t.translate(streamStart())).toEqual([])
    expect(t.translate(result())).toEqual([])
    expect(t.stats.invalid).toBeGreaterThan(0)
  })

  it('traduce los modos de permisos', () => {
    expect(fromClaudePermissionMode('default')).toBe('ask')
    expect(fromClaudePermissionMode('acceptEdits')).toBe('accept-edits')
    expect(fromClaudePermissionMode('plan')).toBe('plan')
    expect(fromClaudePermissionMode('bypassPermissions')).toBe('bypass')
    expect(fromClaudePermissionMode('auto')).toBeUndefined()
    expect(fromClaudePermissionMode('__proto__')).toBeUndefined()
  })

  it('sin parciales, el texto del asistente se entrega por deltas y se cierra', () => {
    const { events } = translateAll([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'm', content: [{ type: 'text', text: 'hola' }] },
      },
      result(),
    ])
    expect(types(events)).toEqual(['block-start', 'block-delta', 'block-end', 'turn-end'])
  })

  it('un par sustituto partido entre dos deltas se junta; uno suelto se reemplaza', () => {
    const [hi, lo] = ['\ud83d', '\ude00']
    const { events } = translateAll([
      streamStart(),
      streamText(`a${hi}`),
      streamText(`${lo}b${hi}`),
      result(),
    ])
    const ref = events.find((e) => e.type === 'block-start')?.ref ?? ''
    expect(deltaText(events, ref)).toBe('a😀b�')
  })

  it('PowerShell cuenta como exec y una herramienta con nombre raro como other', () => {
    const { events } = translateAll([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm',
          content: [
            { type: 'tool_use', id: 'x1', name: 'PowerShell', input: { command: 'Get-Date' } },
            { type: 'tool_use', id: 'x2', name: 'constructor', input: null },
          ],
        },
      },
      result(),
    ])
    const kinds = events
      .filter((e) => e.type === 'block-start')
      .map((e) => (e.block.type === 'action' ? e.block.kind : ''))
    expect(kinds).toEqual(['exec', 'other'])
  })
})
