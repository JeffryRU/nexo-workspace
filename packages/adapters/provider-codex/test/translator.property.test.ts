import { ProviderEvent, sanitizeBodyText } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CodexTranslator } from '../src/translator.ts'
import {
  agentMessage,
  command,
  completed,
  fileChange,
  messageDelta,
  type Note,
  note,
  outputDelta,
  started,
  THREAD,
  TURN,
  turnCompleted,
  turnStarted,
} from './fixtures.ts'

function run(notes: Note[]): ProviderEvent[] {
  let n = 0
  const t = new CodexTranslator({ nextRef: () => `r${++n}` })
  t.beginTurn()
  return notes.flatMap((x) => t.notification(x.method, x.params))
}

const deltaText = (events: ProviderEvent[], field: 'text' | 'output') =>
  events.flatMap((e) => (e.type === 'block-delta' && e.field === field ? [e.text] : [])).join('')

/** Parte `pieces` (cadena entera) en trozos según `cuts`, sin perder nada. */
function partition(text: string, cuts: number[]): string[] {
  const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b)
  const out: string[] = []
  let last = 0
  for (const p of points) {
    out.push(text.slice(last, p))
    last = p
  }
  out.push(text.slice(last))
  return out.filter((p) => p !== '')
}

const anyText = fc.string({ unit: 'binary', maxLength: 300 })

describe('CodexTranslator: propiedades', () => {
  it('el texto del mensaje no depende de cómo lleguen los deltas y queda saneado', () => {
    fc.assert(
      fc.property(anyText, fc.array(fc.nat(), { maxLength: 12 }), (text, cuts) => {
        const events = run([
          started(agentMessage('m')),
          ...partition(text, cuts).map((p) => messageDelta('m', p)),
          completed(agentMessage('m', text)),
        ])
        for (const e of events) expect(ProviderEvent.safeParse(e).success).toBe(true)
        expect(deltaText(events, 'text')).toBe(sanitizeBodyText(text))
        const types = events.map((e) => e.type)
        expect(types.filter((t) => t === 'block-start').length).toBe(text === '' ? 0 : 1)
        expect(types.filter((t) => t === 'block-end').length).toBe(text === '' ? 0 : 1)
      }),
    )
  })

  it('la salida de un comando es la misma con cualquier partición', () => {
    fc.assert(
      fc.property(anyText, fc.array(fc.nat(), { maxLength: 12 }), (text, cuts) => {
        const events = run([
          started(command('c')),
          ...partition(text, cuts).map((p) => outputDelta('c', p)),
        ])
        expect(deltaText(events, 'output')).toBe(
          sanitizeBodyText(text.replace(/[\ud800-\udbff]$/, '')),
        )
      }),
    )
  })

  const randomNote = fc.record({
    method: fc.constantFrom(
      'turn/started',
      'turn/completed',
      'item/started',
      'item/completed',
      'item/agentMessage/delta',
      'item/reasoning/summaryTextDelta',
      'item/commandExecution/outputDelta',
      'item/fileChange/patchUpdated',
      'thread/tokenUsage/updated',
      'error',
      'serverRequest/resolved',
      'otra/cosa',
    ),
    params: fc.oneof(
      fc.jsonValue({ maxDepth: 3 }),
      fc.record({
        threadId: fc.constant(THREAD),
        turnId: fc.constantFrom(TURN, 'otro'),
        itemId: fc.constantFrom('a', 'b'),
        delta: anyText,
        summaryIndex: fc.nat(3),
        item: fc.record({
          type: fc.constantFrom(
            'agentMessage',
            'reasoning',
            'commandExecution',
            'fileChange',
            'webSearch',
            'mcpToolCall',
            'plan',
            'x',
          ),
          id: fc.constantFrom('a', 'b'),
          text: anyText,
          command: anyText,
          status: fc.constantFrom('inProgress', 'completed', 'failed', 'declined', 'raro'),
          exitCode: fc.oneof(fc.integer(), fc.constant(null), fc.double()),
          changes: fc.array(fc.record({ path: anyText, diff: anyText }), { maxLength: 3 }),
          summary: fc.array(anyText, { maxLength: 3 }),
        }),
        turn: fc.record({
          id: fc.constantFrom(TURN, 'otro'),
          status: fc.constantFrom('completed', 'failed', 'interrupted', 'x'),
        }),
        tokenUsage: fc.record({
          total: fc.record({
            inputTokens: fc.oneof(fc.nat(), fc.double()),
            outputTokens: fc.nat(),
          }),
          last: fc.record({ inputTokens: fc.nat(), outputTokens: fc.double() }),
        }),
        error: fc.record({ message: anyText }),
      }),
    ),
  })

  it('notificaciones arbitrarias nunca lanzan, solo emiten eventos válidos y como mucho un turn-end', () => {
    fc.assert(
      fc.property(fc.array(randomNote, { maxLength: 25 }), (notes) => {
        let n = 0
        const t = new CodexTranslator({ nextRef: () => `r${++n}` })
        t.beginTurn()
        const events = notes.flatMap((x) => t.notification(x.method, x.params))
        events.push(...t.end('interrupted'))
        for (const e of events)
          expect(ProviderEvent.safeParse(e).success, JSON.stringify(e)).toBe(true)
        expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1)
        // Todo bloque abierto se cierra antes del turn-end.
        const open = new Set<string>()
        for (const e of events) {
          if (e.type === 'block-start') open.add(e.ref)
          if (e.type === 'block-end') open.delete(e.ref)
          if (e.type === 'block-delta' || e.type === 'block-update')
            expect(open.has(e.ref)).toBe(true)
        }
        expect(open.size).toBe(0)
      }),
    )
  })

  it('un turno bien formado con items en cualquier orden acaba con un turn-end y sin bloques abiertos', () => {
    const item = fc.constantFrom(
      [started(agentMessage('a')), messageDelta('a', 'hola'), completed(agentMessage('a', 'hola'))],
      [
        started(command('b')),
        outputDelta('b', 'x'),
        completed(command('b', { status: 'completed', exitCode: 0 })),
      ],
      [started(fileChange('c')), completed(fileChange('c', { status: 'completed' }))],
      [started(command('d'))],
    )
    fc.assert(
      fc.property(fc.array(item, { maxLength: 6 }), (groups) => {
        const events = run([turnStarted(), ...groups.flat(), turnCompleted()])
        expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1)
        expect(events.at(-1)?.type).toBe('turn-end')
        const open = new Set<string>()
        for (const e of events) {
          if (e.type === 'block-start') open.add(e.ref)
          if (e.type === 'block-end') open.delete(e.ref)
        }
        expect(open.size).toBe(0)
      }),
    )
  })

  it('note() conserva el método y los parámetros tal cual', () => {
    expect(note('a', { b: 1 })).toEqual({ method: 'a', params: { b: 1 } })
  })
})
