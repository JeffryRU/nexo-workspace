import { type ProviderEvent, sanitizeBodyText } from '@nexo/contracts'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { NdjsonSplitter } from '../src/ndjson.ts'
import { OllamaTranslator } from '../src/translator.ts'
import { chunk, final } from './fake-ollama.ts'

const piece = fc.oneof(
  fc.constantFrom('a', 'é', '€', '\n', '\u0000', '😀', '\u001b[31m', ' ', '"', '\\'),
  fc.string({ maxLength: 4 }),
)
const message = fc.record({
  kind: fc.constantFrom('content', 'thinking'),
  text: fc.array(piece, { maxLength: 6 }).map((a) => a.join('')),
})
const stream = fc.array(message, { maxLength: 12 })

const ndjson = (messages: { kind: string; text: string }[], withDone: boolean) => {
  const lines = messages.map((m) =>
    JSON.stringify(m.kind === 'content' ? chunk(m.text) : chunk('', { thinking: m.text })),
  )
  if (withDone) lines.push(JSON.stringify(final()))
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}

function run(bytes: Uint8Array, cuts: number[]) {
  const splitter = new NdjsonSplitter(1 << 20)
  let n = 0
  const t = new OllamaTranslator({ nextRef: () => `r${++n}` })
  const events: ProviderEvent[] = []
  let from = 0
  const points = cuts.map((c) => Math.min(c, bytes.length)).sort((a, b) => a - b)
  for (const cut of [...points, bytes.length]) {
    for (const line of splitter.push(bytes.slice(from, cut))) events.push(...t.feed(line))
    from = cut
  }
  for (const line of splitter.flush()) events.push(...t.feed(line))
  return events
}

describe('traductor: propiedades', () => {
  it('partir el NDJSON en trozos arbitrarios da exactamente los mismos eventos', () => {
    fc.assert(
      fc.property(
        stream,
        fc.array(fc.nat(400), { maxLength: 10 }),
        fc.boolean(),
        (msgs, cuts, done) => {
          const bytes = ndjson(msgs, done)
          expect(run(bytes, cuts)).toEqual(run(bytes, []))
        },
      ),
      { numRuns: 300 },
    )
  })

  it('el texto y el razonamiento reconstruidos son los saneados y hay un solo turn-end al final', () => {
    fc.assert(
      fc.property(stream, fc.array(fc.nat(400), { maxLength: 6 }), (msgs, cuts) => {
        const events = run(ndjson(msgs, true), cuts)
        const ends = events.filter((e) => e.type === 'turn-end')
        expect(ends).toHaveLength(1)
        expect(events.at(-1)).toBe(ends[0])
        const sum = (type: 'text' | 'reasoning') => {
          const refs = new Set(
            events.flatMap((e) =>
              e.type === 'block-start' && e.block.type === type ? [e.ref] : [],
            ),
          )
          return events
            .flatMap((e) => (e.type === 'block-delta' && refs.has(e.ref) ? [e.text] : []))
            .join('')
        }
        const want = (kind: string) =>
          sanitizeBodyText(
            msgs
              .filter((m) => m.kind === kind)
              .map((m) => m.text)
              .join(''),
          )
        // Cambiar de tipo parte los bloques, pero la suma por tipo coincide.
        expect(sum('text')).toBe(want('content'))
        expect(sum('reasoning')).toBe(want('thinking'))
      }),
      { numRuns: 200 },
    )
  })

  it('líneas de basura cualesquiera no rompen el traductor y end siempre cierra', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 40 }), { maxLength: 30 }), (lines) => {
        let n = 0
        const t = new OllamaTranslator({ nextRef: () => `r${++n}` })
        for (const l of lines) t.feed(l)
        t.end('interrupted')
        expect(t.finished).toBe(true)
      }),
    )
  })
})
