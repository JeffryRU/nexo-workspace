import { type Block, type ProviderEvent, utf8ByteLength } from '@nexo/contracts'
import { AgentMirror, arbBody, bootAgentHarness, type FakeStep } from '@nexo/testkit'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

type Harness = Awaited<ReturnType<typeof bootAgentHarness>>

const emit = (event: ProviderEvent, delayMs = 0): FakeStep => ({ type: 'emit', event, delayMs })

/** El documento completo, página a página (puede haber menos bloques por página que `limit`). */
function document(
  t: Harness,
  sessionId: Parameters<Harness['service']['snapshot']>[0]['sessionId'],
) {
  const blocks: Block[] = []
  for (let from: number | null = 0; from !== null; ) {
    const page = t.service.snapshot({ sessionId, fromIndex: from, limit: 7 })
    blocks.push(...page.blocks)
    from = page.nextIndex
  }
  return blocks
}

/** Parte `text` en `cuts` trozos sin dividir caracteres. */
function partition(text: string, cuts: readonly number[]): string[] {
  const chars = Array.from(text)
  const points = [...new Set(cuts.map((c) => c % (chars.length + 1)))].sort((a, b) => a - b)
  const out: string[] = []
  let last = 0
  for (const p of [...points, chars.length]) {
    const piece = chars.slice(last, p).join('')
    if (piece.length > 0) out.push(piece)
    last = p
  }
  return out
}

async function runText(parts: readonly string[], batchMs: number, gaps: readonly number[]) {
  const t = await bootAgentHarness({ config: { batchMs } })
  t.provider.script = () => [
    emit({ type: 'block-start', ref: 't', block: { type: 'text', text: '', complete: false } }),
    ...parts.map((text, i) =>
      emit(
        { type: 'block-delta', ref: 't', field: 'text', text },
        gaps[i % Math.max(1, gaps.length)] ?? 0,
      ),
    ),
    emit({ type: 'block-end', ref: 't' }),
  ]
  const { session } = await t.create()
  const mirror = new AgentMirror(t.bus, session.id)
  await t.service.send({ sessionId: session.id, text: 'x' })
  t.settle(10_000)
  const blocks = document(t, session.id)
  return { blocks, mirror: mirror.blocks(), resyncs: mirror.resyncs, t }
}

describe('AgentService (propiedades): deltas', () => {
  it('el documento final es el mismo con cualquier partición de los deltas', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbBody(1),
        fc.array(fc.nat(500), { maxLength: 12 }),
        fc.array(fc.nat(500), { maxLength: 12 }),
        fc.constantFrom(1, 8, 50, 400),
        fc.array(fc.nat(30), { maxLength: 6 }),
        async (text, cutsA, cutsB, batchMs, gaps) => {
          const a = await runText(partition(text, cutsA), batchMs, gaps)
          const b = await runText(partition(text, cutsB), 1, [])
          const final = (blocks: Block[]) => {
            const block = blocks.find((x) => x.type === 'text')
            return block?.type === 'text' ? block.text : undefined
          }
          expect(final(a.blocks)).toBe(text)
          expect(final(b.blocks)).toBe(text)
          expect(a.blocks.map((x) => x.type)).toEqual(b.blocks.map((x) => x.type))
          expect(a.mirror).toEqual(a.blocks)
          expect(a.resyncs).toBe(0)
        },
      ),
      { numRuns: 60 },
    )
  })

  it('con deltas que superan el tope de bloque, cualquier partición da el mismo recorte', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat(2000), { maxLength: 10 }),
        fc.constantFrom(4, 64),
        async (cuts, batchMs) => {
          const text = 'añ😀'.repeat(60_000)
          // Un delta del proveedor no pasa de 32 KiB: se trocea cada pieza en bloques de 3000 caracteres.
          const parts = partition(
            text,
            cuts.map((c) => c * 100),
          ).flatMap((piece) => {
            const chars = Array.from(piece)
            const out: string[] = []
            for (let i = 0; i < chars.length; i += 3000) out.push(chars.slice(i, i + 3000).join(''))
            return out
          })
          const a = await runText(parts.length === 0 ? [text] : parts, batchMs, [])
          const block = a.blocks.find((x) => x.type === 'text')
          expect(block).toMatchObject({ truncated: true })
          const body = block?.type === 'text' ? block.text : ''
          expect(text.startsWith(body)).toBe(true)
          expect(utf8ByteLength(body)).toBeLessThanOrEqual(128 * 1024)
          expect(utf8ByteLength(body)).toBeGreaterThan(128 * 1024 - 4)
          expect(a.mirror).toEqual(a.blocks)
        },
      ),
      { numRuns: 15 },
    )
  })
})

// Operaciones de un turno arbitrario: válidas, inválidas y de todo tipo.
type Op =
  | { k: 'start'; ref: number; kind: 'text' | 'reasoning' | 'action' }
  | { k: 'delta'; ref: number; field: 'text' | 'output'; text: string }
  | { k: 'update'; ref: number; text: string }
  | { k: 'end'; ref: number }
  | { k: 'permission'; id: number }
  | { k: 'question'; id: number }
  | { k: 'cancel'; id: number }
  | { k: 'error' }
  | { k: 'usage' }
  | { k: 'junk' }

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('start' as const),
      ref: fc.nat(4),
      kind: fc.constantFrom('text', 'reasoning', 'action' as const),
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      k: fc.constant('delta' as const),
      ref: fc.nat(4),
      field: fc.constantFrom('text', 'output' as const),
      text: arbBody(1),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant('update' as const), ref: fc.nat(4), text: arbBody() }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('end' as const), ref: fc.nat(4) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('permission' as const), id: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('question' as const), id: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('cancel' as const), id: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.constant({ k: 'error' as const }) },
  { weight: 1, arbitrary: fc.constant({ k: 'usage' as const }) },
  { weight: 1, arbitrary: fc.constant({ k: 'junk' as const }) },
)

function toStep(op: Op): FakeStep {
  switch (op.k) {
    case 'start':
      return emit({
        type: 'block-start',
        ref: `r${op.ref}`,
        block:
          op.kind === 'action'
            ? { type: 'action', kind: 'exec', status: 'running', tool: 'Bash', title: 'x' }
            : { type: op.kind, text: '', complete: false },
      })
    case 'delta':
      return emit({ type: 'block-delta', ref: `r${op.ref}`, field: op.field, text: op.text })
    case 'update':
      return emit({
        type: 'block-update',
        ref: `r${op.ref}`,
        block: { type: 'text', text: op.text, complete: false },
      })
    case 'end':
      return emit({ type: 'block-end', ref: `r${op.ref}` })
    case 'permission':
      return {
        type: 'raw',
        value: {
          type: 'permission-request',
          requestId: `p${op.id}`,
          tool: 'x',
          title: 't',
          options: [{ id: 'a', label: 'a', kind: 'allow-once' }],
        } satisfies ProviderEvent,
      }
    case 'question':
      return {
        type: 'raw',
        value: {
          type: 'question-request',
          requestId: `q${op.id}`,
          questions: [{ id: 'x', question: '?', options: [], multiSelect: false, allowText: true }],
        } satisfies ProviderEvent,
      }
    case 'cancel':
      return emit({ type: 'request-cancelled', requestId: `p${op.id}` })
    case 'error':
      return emit({
        type: 'error',
        error: { code: 'E', message: 'm', fatal: false },
      })
    case 'usage':
      return emit({ type: 'usage', usage: { inputTokens: 1 } })
    case 'junk':
      return { type: 'raw', value: { basura: true } }
  }
}

describe('AgentService (propiedades): documento de turnos arbitrarios', () => {
  it('index sin huecos ni repetidos, ids únicos, y el cliente reproduce el snapshot', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(arbOp, { maxLength: 25 }), { minLength: 1, maxLength: 3 }),
        fc.constantFrom(1, 16, 200),
        fc.array(fc.nat(40), { maxLength: 8 }),
        async (turns, batchMs, advances) => {
          const t = await bootAgentHarness({
            config: { batchMs, maxConsecutiveInvalid: 10_000, maxMessageBytes: 16 * 1024 },
          })
          let n = 0
          t.provider.script = () => (turns[n++ % turns.length] ?? []).map(toStep)
          const { session } = await t.create()
          const mirror = new AgentMirror(t.bus, session.id)
          for (let i = 0; i < turns.length; i++) {
            await t.service.send({ sessionId: session.id, text: `turno ${i}` })
            for (const ms of advances) {
              t.clock.advance(ms)
              if (ms % 3 === 0) t.service.snapshot({ sessionId: session.id, limit: 3 })
            }
            t.settle(10_000)
            expect(t.service.list().sessions[0]?.status).not.toBe('working')
            if (t.service.list().sessions[0]?.status === 'needs-input') {
              await t.service.interrupt({ sessionId: session.id })
            }
          }
          const blocks = document(t, session.id)
          expect(blocks.map((b) => b.index)).toEqual(blocks.map((_, i) => i))
          expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length)
          for (let i = 1; i < blocks.length; i++) {
            expect((blocks[i] as Block).turn).toBeGreaterThanOrEqual((blocks[i - 1] as Block).turn)
          }
          expect(mirror.blocks()).toEqual(blocks)
          expect(mirror.resyncs).toBe(0)
          expect(t.service.list().sessions[0]?.blockCount).toBe(blocks.length)
        },
      ),
      { numRuns: 80 },
    )
  })
})
