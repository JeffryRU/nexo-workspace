import { ProviderEvent, sanitizeBodyText } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { unifiedDiff } from '../src/diff.ts'
import { message, newTranslator, run, thought, toolCall, toolUpdate, upd } from './fixtures.ts'

/** Parte `text` en trozos según `cuts`, sin perder nada. */
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

describe('AcpTranslator: propiedades', () => {
  it('el texto del mensaje no depende de cómo lleguen los fragmentos y queda saneado', () => {
    fc.assert(
      fc.property(anyText, fc.array(fc.nat(), { maxLength: 12 }), (text, cuts) => {
        const events = run(partition(text, cuts).map((p) => message(p)))
        for (const e of events) expect(ProviderEvent.safeParse(e).success).toBe(true)
        const joined = events.flatMap((e) => (e.type === 'block-delta' ? [e.text] : [])).join('')
        // Un sustituto alto final puede quedar retenido hasta cerrar el bloque.
        expect(sanitizeBodyText(text).startsWith(joined.replace(/�+$/, ''))).toBe(true)
        expect(events.filter((e) => e.type === 'block-start').length).toBeLessThanOrEqual(1)
      }),
    )
  })

  it('cerrar el turno completa el texto: ningún bloque queda abierto y hay un solo turn-end', () => {
    fc.assert(
      fc.property(anyText, fc.array(fc.nat(), { maxLength: 12 }), (text, cuts) => {
        const t = newTranslator()
        t.beginTurn()
        const events = [
          ...partition(text, cuts).flatMap((p) => t.notification(message(p))),
          ...t.end('end-turn'),
        ]
        const open = new Set<string>()
        for (const e of events) {
          expect(ProviderEvent.safeParse(e).success).toBe(true)
          if (e.type === 'block-start') open.add(e.ref)
          if (e.type === 'block-end') open.delete(e.ref)
        }
        expect(open.size).toBe(0)
        expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1)
        expect(events.flatMap((e) => (e.type === 'block-delta' ? [e.text] : [])).join('')).toBe(
          sanitizeBodyText(text),
        )
      }),
    )
  })

  const randomUpdate = fc.record({
    sessionUpdate: fc.constantFrom(
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'plan',
      'plan_update',
      'user_message_chunk',
      'current_mode_update',
      'session_info_update',
      'basura',
    ),
    toolCallId: fc.oneof(fc.constantFrom('a', 'b', 'c'), fc.integer(), fc.constant(undefined)),
    title: fc.oneof(anyText, fc.constant(null), fc.integer()),
    kind: fc.constantFrom('read', 'edit', 'execute', 'raro', undefined, null),
    status: fc.constantFrom('pending', 'in_progress', 'completed', 'failed', 'otro', undefined),
    content: fc.oneof(
      fc.record({ type: fc.constantFrom('text', 'image', 'resource_link'), text: anyText }),
      fc.array(
        fc.oneof(
          fc.record({
            type: fc.constant('diff'),
            path: anyText,
            oldText: anyText,
            newText: anyText,
          }),
          fc.record({
            type: fc.constant('content'),
            content: fc.record({ type: fc.constant('text'), text: anyText }),
          }),
          fc.constant(7),
        ),
        { maxLength: 3 },
      ),
      fc.string(),
    ),
    entries: fc.oneof(
      fc.array(
        fc.record({ content: anyText, status: fc.constantFrom('pending', 'completed', 'x') }),
      ),
      fc.constant('x'),
    ),
    plan: fc.oneof(
      fc.record({
        type: fc.constantFrom('items', 'markdown'),
        planId: fc.constantFrom('p1', 'p2'),
        content: anyText,
      }),
      fc.constant(null),
    ),
    currentModeId: fc.oneof(fc.string(), fc.integer()),
    rawInput: fc.jsonValue(),
    rawOutput: fc.jsonValue(),
  })

  it('actualizaciones arbitrarias nunca lanzan, siempre emiten eventos válidos y el cierre no deja bloques abiertos', () => {
    fc.assert(
      fc.property(fc.array(randomUpdate, { maxLength: 40 }), (updates) => {
        const t = newTranslator()
        t.beginTurn()
        const events = [...updates.flatMap((u) => t.notification(upd(u))), ...t.end('error')]
        const open = new Set<string>()
        for (const e of events) {
          expect(ProviderEvent.safeParse(e).success, JSON.stringify(e).slice(0, 200)).toBe(true)
          if (e.type === 'block-start') {
            expect(open.has(e.ref)).toBe(false)
            open.add(e.ref)
          } else if (e.type === 'block-delta' || e.type === 'block-update') {
            expect(open.has(e.ref)).toBe(true)
          } else if (e.type === 'block-end') {
            expect(open.has(e.ref)).toBe(true)
            open.delete(e.ref)
          }
        }
        expect(open.size).toBe(0)
        expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1)
      }),
      { numRuns: 300 },
    )
  })

  it('cada acción tiene un solo block-start y un solo block-end, sea cual sea el orden de las actualizaciones', () => {
    const step = fc.constantFrom(
      toolCall({ toolCallId: 'a' }),
      toolUpdate({ toolCallId: 'a', status: 'in_progress' }),
      toolUpdate({ toolCallId: 'a', status: 'completed' }),
      toolUpdate({ toolCallId: 'a', status: 'failed' }),
      toolCall({ toolCallId: 'a', status: 'completed' }),
      message('x'),
      thought('y'),
    )
    fc.assert(
      fc.property(fc.array(step, { maxLength: 20 }), (steps) => {
        const events = run(steps)
        const ends = events.filter((e) => e.type === 'block-end' && e.ref.startsWith('r'))
        const starts = events.filter((e) => e.type === 'block-start')
        const refs = starts.map((e) => (e.type === 'block-start' ? e.ref : ''))
        expect(new Set(refs).size).toBe(refs.length)
        expect(ends.length).toBeLessThanOrEqual(starts.length)
      }),
    )
  })
})

// ---- diff ----

/** Aplica un parche unificado (el que produce `unifiedDiff`) a `oldText`. */
function applyPatch(oldText: string, patch: string): string {
  const old = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n')
  const out: string[] = []
  let pos = 0
  const lines = patch.split('\n').slice(2)
  for (const l of lines) {
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+),(\d+) /.exec(l)
      const start = Number(m?.[1] ?? 1)
      const count = Number(m?.[2] ?? 0)
      const target = count === 0 ? start : start - 1
      while (pos < target) out.push(old[pos++] ?? '')
    } else if (l.startsWith('+')) out.push(l.slice(1))
    else if (l.startsWith('-')) pos++
    else {
      out.push(old[pos++] ?? '')
    }
  }
  while (pos < old.length) out.push(old[pos++] ?? '')
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

const lineArb = fc.array(fc.constantFrom('a', 'b', 'c', 'd', '', 'x y'), { maxLength: 25 })

describe('unifiedDiff: propiedades', () => {
  it('aplicar el parche al texto viejo da el nuevo; sin cambios no hay parche', () => {
    fc.assert(
      fc.property(lineArb, lineArb, (a, b) => {
        const oldText = a.length === 0 ? '' : `${a.join('\n')}\n`
        const newText = b.length === 0 ? '' : `${b.join('\n')}\n`
        const patch = unifiedDiff('f.txt', oldText, newText)
        if (oldText === newText) {
          expect(patch).toBe('')
        } else {
          expect(applyPatch(oldText, patch)).toBe(newText)
        }
      }),
      { numRuns: 300 },
    )
  })
})
