import { ProviderEvent } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { NdjsonSplitter } from '../src/ndjson.ts'
import { MAX_INVALID_LINES, OllamaTranslator } from '../src/translator.ts'
import { chunk, final } from './fake-ollama.ts'

function translate(lines: readonly string[]) {
  let n = 0
  const t = new OllamaTranslator({ nextRef: () => `b${++n}` })
  const events: ProviderEvent[] = lines.flatMap((l) => t.feed(l))
  return { t, events }
}
const j = (o: unknown) => JSON.stringify(o)
const kinds = (events: readonly { type: string }[]) => events.map((e) => e.type)
const starts = (events: readonly ProviderEvent[]) =>
  events.flatMap((e) => (e.type === 'block-start' ? [e.block.type] : []))

describe('OllamaTranslator', () => {
  it('traduce razonamiento y texto a bloques y cierra con turn-end y uso', () => {
    const { events, t } = translate([
      j(chunk('', { thinking: 'pien' })),
      j(chunk('', { thinking: 'so' })),
      j(chunk('ho')),
      j(chunk('la')),
      j(final()),
    ])
    expect(kinds(events)).toEqual([
      'block-start',
      'block-delta',
      'block-delta',
      'block-end',
      'block-start',
      'block-delta',
      'block-delta',
      'block-end',
      'turn-end',
    ])
    expect(starts(events)).toEqual(['reasoning', 'text'])
    expect(events[8]).toEqual({
      type: 'turn-end',
      stopReason: 'end-turn',
      usage: { inputTokens: 7, outputTokens: 3, durationMs: 3, numTurns: 1 },
    })
    expect(t.content).toBe('hola')
    expect(t.finished).toBe(true)
    for (const e of events) expect(ProviderEvent.safeParse(e).success).toBe(true)
  })

  it('un trozo con razonamiento y texto a la vez emite primero el razonamiento', () => {
    const { events } = translate([j(chunk('x', { thinking: 'y' }))])
    expect(starts(events)).toEqual(['reasoning', 'text'])
  })

  it('done_reason length da max-tokens y uno desconocido other', () => {
    expect(translate([j(final({ done_reason: 'length' }))]).t.stopReason).toBe('max-tokens')
    expect(translate([j(final({ done_reason: 'load' }))]).t.stopReason).toBe('other')
    expect(translate([j({ done: true })]).events).toEqual([
      { type: 'turn-end', stopReason: 'end-turn', usage: { numTurns: 1 } },
    ])
  })

  it('ignora cifras de uso que no son enteros no negativos', () => {
    const { events } = translate([
      j(final({ eval_count: -1, prompt_eval_count: 1.5, total_duration: 'x' })),
    ])
    expect(events[0]).toMatchObject({ usage: { numTurns: 1 } })
    expect(JSON.stringify(events[0])).not.toContain('Tokens')
  })

  it('un error del flujo cierra el turno con bloque error y stopReason error', () => {
    const { events, t } = translate([j(chunk('a')), j({ error: 'an error was encountered' })])
    expect(kinds(events)).toEqual(['block-start', 'block-delta', 'block-end', 'error', 'turn-end'])
    expect(events[3]).toMatchObject({ error: { code: 'OLLAMA_ERROR', fatal: false } })
    expect(t.stopReason).toBe('error')
  })

  it('reconoce modelo inexistente y razonamiento no admitido', () => {
    const a = translate([j({ error: "model 'x' not found" })]).events[0]
    expect(a).toMatchObject({ error: { code: 'MODEL_NOT_FOUND' } })
    const b = translate([j({ error: '"m" does not support thinking' })]).events[0]
    expect(b).toMatchObject({ error: { code: 'THINK_UNSUPPORTED' } })
  })

  it('ignora y cuenta líneas rotas, y se rinde pasado el tope', () => {
    const { events, t } = translate(['{no json', '[]', 'null', '7', j(chunk('ok'))])
    expect(t.invalid).toBe(4)
    expect(kinds(events)).toEqual(['block-start', 'block-delta'])
    const many = translate(Array.from({ length: MAX_INVALID_LINES + 1 }, () => 'basura'))
    expect(many.t.finished).toBe(true)
    expect(many.events.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'error' })
    expect(many.events[0]).toMatchObject({ error: { code: 'INVALID_RESPONSE' } })
  })

  it('después del fin no emite nada más', () => {
    const { t } = translate([j(final())])
    expect(t.feed(j(chunk('tarde')))).toEqual([])
    expect(t.end('interrupted')).toEqual([])
  })

  it('end cierra bloques abiertos y emite un solo turn-end', () => {
    const t = new OllamaTranslator({ nextRef: () => 'r' })
    t.feed(j(chunk('a')))
    const ev = t.end('interrupted')
    expect(kinds(ev)).toEqual(['block-end', 'turn-end'])
    expect(ev[1]).toEqual({ type: 'turn-end', stopReason: 'interrupted' })
  })

  it('sanea NUL y sustitutos sueltos y no parte un par entre dos trozos', () => {
    const { events } = translate([
      j(chunk('a\u0000b\ud83d')),
      j(chunk('\ude00 c')),
      j(chunk('fin\ud83d')),
      j(final()),
    ])
    const text = events.flatMap((e) => (e.type === 'block-delta' ? [e.text] : [])).join('')
    expect(text).toBe('a�b😀 cfin�')
  })

  it('parte los deltas enormes en trozos de a lo sumo 32 KiB', () => {
    const { events } = translate([j(chunk('é'.repeat(100_000)))])
    const deltas = events.filter((e) => e.type === 'block-delta')
    expect(deltas.length).toBeGreaterThan(5)
    for (const d of deltas) expect(ProviderEvent.safeParse(d).success).toBe(true)
  })

  it('acota el texto que se guarda para el historial', () => {
    const t = new OllamaTranslator({ nextRef: () => 'r', maxContentBytes: 10 })
    for (let i = 0; i < 20; i++) t.feed(j(chunk('abcdef')))
    expect(t.content.length).toBeLessThan(30)
  })
})

describe('NdjsonSplitter', () => {
  const enc = new TextEncoder()
  it('junta trozos, quita \\r y salta líneas vacías', () => {
    const s = new NdjsonSplitter(100)
    expect(s.push(enc.encode('{"a":1}\r\n\n{"b"'))).toEqual(['{"a":1}'])
    expect(s.push(enc.encode(':2}\n'))).toEqual(['{"b":2}'])
    expect(s.flush()).toEqual([])
  })
  it('entrega la última línea sin salto al hacer flush', () => {
    const s = new NdjsonSplitter(100)
    expect(s.push(enc.encode('uno\ndos'))).toEqual(['uno'])
    expect(s.flush()).toEqual(['dos'])
  })
  it('decodifica un carácter UTF-8 partido entre dos trozos', () => {
    const bytes = enc.encode('€\n')
    const s = new NdjsonSplitter(100)
    expect(s.push(bytes.slice(0, 1))).toEqual([])
    expect(s.push(bytes.slice(1))).toEqual(['€'])
  })
  it('marca desbordamiento y deja de acumular', () => {
    const s = new NdjsonSplitter(8)
    expect(s.push(enc.encode('123456789'))).toEqual([])
    expect(s.overflowed).toBe(true)
    expect(s.push(enc.encode('x\n'))).toEqual([])
    expect(s.flush()).toEqual([])
  })
})
