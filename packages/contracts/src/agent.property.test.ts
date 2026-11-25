import {
  arbAgentDelta,
  arbAgentEvent,
  arbAgentRequest,
  arbAgentSession,
  arbBlock,
  arbBlockDraft,
  arbProviderCapabilities,
  arbProviderEvent,
} from '@nexo/testkit'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  AgentDelta,
  AgentSession,
  applyBlockDelta,
  Block,
  BlockDraft,
  LIMITS,
  ProviderCapabilities,
  ProviderEvent,
  parseRequest,
  parseServerMessage,
  utf8ByteLength,
} from './index.ts'

const roundTrip = <T>(value: T): unknown => JSON.parse(JSON.stringify(value))

describe('propiedades del modelo de agente', () => {
  it('todo bloque generado pasa el esquema y sobrevive a JSON', () => {
    fc.assert(
      fc.property(arbBlock, (block) => {
        const r = Block.safeParse(block)
        expect(r.success, JSON.stringify(r.error?.issues)).toBe(true)
        expect(Block.parse(roundTrip(block))).toEqual(block)
      }),
      { numRuns: 300 },
    )
  })

  it('todo borrador, evento de proveedor, sesión, delta y capacidades válidos sobreviven a JSON', () => {
    const cases: [fc.Arbitrary<unknown>, { parse: (v: unknown) => unknown }][] = [
      [arbBlockDraft, BlockDraft],
      [arbProviderEvent, ProviderEvent],
      [arbAgentSession, AgentSession],
      [arbAgentDelta, AgentDelta],
      [arbProviderCapabilities, ProviderCapabilities],
    ]
    for (const [arb, schema] of cases) {
      fc.assert(
        fc.property(arb, (value) => {
          expect(schema.parse(roundTrip(value))).toEqual(value)
        }),
        { numRuns: 200 },
      )
    }
  })

  it('toda petición y todo evento agent.* generado pasa por el parser del protocolo', () => {
    fc.assert(
      fc.property(arbAgentRequest, (request) => {
        const r = parseRequest(JSON.stringify(request))
        expect(r.ok, JSON.stringify(r)).toBe(true)
        if (r.ok) expect(r.value).toEqual(request)
      }),
    )
    fc.assert(
      fc.property(arbAgentEvent, (event) => {
        const r = parseServerMessage(JSON.stringify(event))
        expect(r.ok, JSON.stringify(r)).toBe(true)
        if (r.ok) expect(r.value).toEqual(event)
      }),
    )
  })

  it('aplicar deltas en orden equivale a concatenar, y nunca pasa del tope', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }), { maxLength: 30 }),
        (parts) => {
          let block = Block.parse({
            id: 'b',
            index: 0,
            turn: 1,
            seq: 0,
            createdAt: 0,
            type: 'text',
            text: '',
            complete: false,
          })
          const clean = parts.filter((p) => !p.includes('\u0000'))
          clean.forEach((text, i) => {
            const r = applyBlockDelta(block, {
              sessionId: 's' as never,
              blockId: 'b' as never,
              field: 'text',
              seq: i + 1,
              text,
            })
            expect(r.status).toBe('applied')
            if (r.status === 'applied') block = r.block
          })
          if (block.type !== 'text') throw new Error('tipo')
          expect(block.text).toBe(clean.join(''))
          expect(block.seq).toBe(clean.length)
          expect(utf8ByteLength(block.text)).toBeLessThanOrEqual(LIMITS.maxBlockTextBytes)
        },
      ),
    )
  })

  it('un delta repetido o fuera de orden nunca cambia el bloque', () => {
    fc.assert(
      fc.property(arbBlock, fc.integer({ min: 0, max: 5000 }), (block, seq) => {
        fc.pre(seq !== block.seq + 1)
        const r = applyBlockDelta(block, {
          sessionId: 's' as never,
          blockId: block.id,
          field: 'text',
          seq: Math.max(1, seq),
          text: 'x',
        })
        expect(['duplicate', 'gap', 'invalid']).toContain(r.status)
      }),
    )
  })
})
