import { type Block, sanitizeBodyText } from '@nexo/contracts'
import * as kit from '@nexo/testkit'
import { AgentMirror } from '@nexo/testkit'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { bootClaude } from './boot.ts'
import {
  messageStart,
  result,
  streamStart,
  streamStop,
  streamText,
  toolResult,
  toolUse,
} from './helpers.ts'

const unit = fc.oneof(
  fc.constantFrom('a', 'é', '\n', '\u0000', '\ud83d', '\ude00', '😀', '\u001b[31m', ' '),
  fc.string({ maxLength: 3 }),
)
const textArb = fc.array(unit, { maxLength: 40 }).map((u) => u.join(''))
const cutsArb = fc.array(fc.nat(200), { maxLength: 12 })

/** Parte por unidades UTF-16, también por la mitad de un par sustituto. */
function partitionUnits(text: string, cuts: readonly number[]): string[] {
  const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b)
  const out: string[] = []
  let last = 0
  for (const p of [...points, text.length]) {
    if (p > last) out.push(text.slice(last, p))
    last = p
  }
  return out
}

async function run(text: string, parts: readonly string[]) {
  const t = await bootClaude(kit.createHarness())
  t.fake.onSend = () => {
    t.fake.emit(messageStart('m1'), streamStart('text', 0))
    for (const p of parts) t.fake.emit(streamText(p, 0))
    t.fake.emit(streamStop(0))
    t.fake.finish()
  }
  const mirror = new AgentMirror(t.bus, t.session.id)
  await t.service.send({ sessionId: t.session.id, text: 'hola' })
  await t.until(t.turnEnded)
  const blocks = t.document()
  const textBlock = blocks.find((b) => b.type === 'text')
  void text
  return { blocks, textBlock, mirror: mirror.blocks(), resyncs: mirror.resyncs, t }
}

describe('adaptador Claude a través de AgentService (propiedades)', () => {
  it('cualquier partición de los deltas produce el mismo documento, igual al texto limpio', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, cutsArb, cutsArb, async (text, cutsA, cutsB) => {
        const expected = sanitizeBodyText(text)
        const a = await run(text, partitionUnits(text, cutsA))
        const b = await run(text, partitionUnits(text, cutsB))
        expect(a.textBlock?.type === 'text' ? a.textBlock.text : undefined).toBe(
          text === '' ? '' : expected,
        )
        const strip = (blocks: Block[]) =>
          blocks.map((x) =>
            x.type === 'text' ? { type: x.type, text: x.text, complete: x.complete } : x.type,
          )
        expect(strip(a.blocks)).toEqual(strip(b.blocks))
        expect(a.textBlock?.type === 'text' && a.textBlock.complete).toBe(true)
        expect(a.resyncs).toBe(0)
      }),
      { numRuns: 60 },
    )
  })

  it('el cliente que aplica agent.block + agent.delta reproduce el documento del servidor', async () => {
    const { blocks, mirror } = await run('hola', ['ho', 'la'])
    expect(mirror).toEqual(blocks)
  })

  it('el documento de un turno con herramientas queda coherente: índices sin huecos, una acción por llamada', async () => {
    const t = await bootClaude(kit.createHarness())
    t.fake.onSend = () => {
      t.fake.emit(
        toolUse('t1', 'Read', { file_path: '/work/a.ts' }),
        toolUse('t2', 'Bash', { command: 'ls' }),
        toolResult('t1', 'contenido'),
        toolResult('t2', 'Exit code 2\nfallo', true),
        toolResult('t-huerfano', 'nada'),
      )
      t.fake.finish()
    }
    await t.service.send({ sessionId: t.session.id, text: 'haz' })
    await t.until(t.turnEnded)
    const blocks = t.document()
    expect(blocks.map((b) => b.index)).toEqual(blocks.map((_, i) => i))
    const actions = blocks.filter((b) => b.type === 'action')
    expect(actions.map((a) => (a.type === 'action' ? [a.kind, a.status] : []))).toEqual([
      ['read', 'ok'],
      ['exec', 'error'],
    ])
    expect(t.service.stats(t.session.id)?.invalidEvents).toBe(0)
    expect(blocks.map((b) => b.type)).toEqual(['user', 'action', 'action', 'usage'])
    void result
  })
})
