import { ProviderEvent, sanitizeBodyText } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseModels } from '../src/models.ts'
import { AgyTranslator } from '../src/translator.ts'
import { init, result, step, tool } from './fixtures.ts'

function run(items: unknown[], finish = true): ProviderEvent[] {
  let n = 0
  const t = new AgyTranslator({ nextRef: () => `r${++n}`, cwd: '/w' })
  t.beginTurn()
  const events = items.flatMap((i) => t.feed(i))
  if (finish) events.push(...t.end('other'))
  return events
}

/** Invariantes del contrato: eventos válidos, bloques abiertos antes de usarse, un solo turn-end y al final. */
function check(events: ProviderEvent[]): void {
  const open = new Set<string>()
  const closed = new Set<string>()
  let ends = 0
  for (const e of events) {
    expect(ProviderEvent.safeParse(e).success, JSON.stringify(e).slice(0, 200)).toBe(true)
    if (e.type === 'block-start') {
      expect(open.has(e.ref) || closed.has(e.ref)).toBe(false)
      open.add(e.ref)
    } else if (e.type === 'block-delta' || e.type === 'block-update') {
      expect(open.has(e.ref)).toBe(true)
    } else if (e.type === 'block-end') {
      expect(open.has(e.ref)).toBe(true)
      open.delete(e.ref)
      closed.add(e.ref)
    } else if (e.type === 'turn-end') ends++
  }
  expect(ends).toBe(1)
  expect(events.at(-1)?.type).toBe('turn-end')
  expect(open.size).toBe(0)
}

const text = fc.string({ maxLength: 40 })
const index = fc.integer({ min: 0, max: 4 })
const state = fc.constantFrom<'ACTIVE' | 'DONE'>('ACTIVE', 'DONE')
const stepArb = fc.oneof(
  fc
    .record({ i: index, s: state, t: text })
    .map((x) => step(x.i, x.s, 'agent_response', { text_delta: x.t })),
  fc
    .record({
      i: index,
      s: state,
      name: fc.constantFrom('run_command', 'write_to_file', 'view_file', 'x'),
      out: fc.anything(),
    })
    .map((x) =>
      tool(x.i, x.s, x.name, { CommandLine: 'c', TargetFile: '/w/a' }, { output: x.out }),
    ),
  fc.record({ i: index }).map((x) => step(x.i, 'DONE', 'checkpoint')),
  fc.constant(init()),
)
const junk = fc.oneof(fc.anything(), fc.record({ event: fc.string(), step_update: fc.anything() }))

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = text.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

describe('AgyTranslator (propiedades)', () => {
  it('cualquier secuencia de pasos válidos produce eventos válidos y un solo turn-end', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 25 }), fc.boolean(), (steps, withResult) => {
        const items = withResult ? [...steps, result('SUCCESS', 'fin')] : steps
        check(run(items))
      }),
      { numRuns: 300 },
    )
  })

  it('entradas arbitrarias nunca lanzan ni rompen el contrato', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(junk, stepArb), { maxLength: 25 }), (items) => {
        check(run(items))
      }),
      { numRuns: 300 },
    )
  })

  it('los deltas de pasos ACTIVE se concatenan tal cual (sin pérdidas ni duplicados)', () => {
    fc.assert(
      fc.property(fc.array(text, { minLength: 1, maxLength: 15 }), (chunks) => {
        const events = run([
          ...chunks.map((c) => step(1, 'ACTIVE', 'agent_response', { text_delta: c })),
          step(1, 'DONE', 'agent_response'),
          result('SUCCESS', ''),
        ])
        const got = events.flatMap((e) => (e.type === 'block-delta' ? [e.text] : [])).join('')
        expect(got).toBe(sanitizeBodyText(chunks.join('')))
      }),
      { numRuns: 300 },
    )
  })

  it('un par sustituto partido entre dos trozos no se parte en la salida', () => {
    const events = run([
      step(1, 'ACTIVE', 'agent_response', { text_delta: 'a\ud83d' }),
      step(1, 'ACTIVE', 'agent_response', { text_delta: '\ude00b' }),
      step(1, 'DONE', 'agent_response'),
      result('SUCCESS', ''),
    ])
    for (const e of events) {
      if (e.type === 'block-delta') expect(hasLoneSurrogate(e.text)).toBe(false)
    }
    expect(events.flatMap((e) => (e.type === 'block-delta' ? [e.text] : [])).join('')).toBe(
      'a\u{1f600}b',
    )
  })
})

describe('parseModels (propiedades)', () => {
  it('nunca lanza y todo id devuelto es un Token válido y único', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc.anything().map((v) => JSON.stringify(v) ?? ''),
        ),
        (input) => {
          const { models, defaultModel } = parseModels(input)
          const ids = models.map((m) => m.id)
          expect(new Set(ids).size).toBe(ids.length)
          if (defaultModel !== undefined) expect(ids).toContain(defaultModel)
        },
      ),
      { numRuns: 300 },
    )
  })
})
