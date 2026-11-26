import { type Block, LIMITS, ProjectMemory } from '@nexo/contracts'
import { arbBlockDocument, arbHostileString, arbProjectMemory } from '@nexo/testkit'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  acceptObservations,
  appendObservations,
  applyObserved,
  applyReflection,
  buildMemoryBlock,
  DEFAULT_SELECT_LIMITS,
  emptyProjectMemory,
  escapeMemoryText,
  estimateTokens,
  MEMORY_CLOSE_TAG,
  MEMORY_OPEN_TAG,
  normalizeProjectPath,
  observationTokens,
  parseObservationText,
  resolveThresholds,
  searchObservations,
  selectForObserver,
} from './index.ts'

const segment = fc.stringMatching(/^[a-zA-Z0-9 _.-]{1,12}$/).filter((s) => s !== '.' && s !== '..')
const mixedText = fc.oneof(fc.string({ unit: 'binary', maxLength: 300 }), arbHostileString)

describe('estimateTokens (propiedades)', () => {
  it('es subaditivo, monótono al concatenar y nunca negativo', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.string({ unit: 'binary' }), (a, b) => {
        const ea = estimateTokens(a)
        const eb = estimateTokens(b)
        const eab = estimateTokens(a + b)
        expect(ea).toBeGreaterThanOrEqual(0)
        expect(eab).toBeLessThanOrEqual(ea + eb + 1)
        expect(eab).toBeGreaterThanOrEqual(Math.max(ea, eb) - 1)
      }),
    )
  })
})

describe('normalizeProjectPath (propiedades)', () => {
  it('es idempotente para cualquier texto', () => {
    fc.assert(
      fc.property(mixedText, (p) => {
        const once = normalizeProjectPath(p)
        expect(normalizeProjectPath(once)).toBe(once)
      }),
    )
  })

  it('rutas de Windows: separadores y mayúsculas no cambian la clave', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('C', 'd', 'Z'),
        fc.array(segment, { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        (drive, parts, trailing) => {
          const a = `${drive}:\\${parts.join('\\')}${trailing ? '\\' : ''}`
          const b = `${drive.toLowerCase()}:/${parts.join('/').toUpperCase()}`
          expect(normalizeProjectPath(a)).toBe(normalizeProjectPath(b))
        },
      ),
    )
  })

  it('POSIX: distingue mayúsculas y nunca termina en / salvo la raíz', () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (parts) => {
        const p = `/${parts.join('/')}/`
        const n = normalizeProjectPath(p)
        expect(n.endsWith('/')).toBe(false)
        expect(n.startsWith('/')).toBe(true)
        if (parts.join('') !== parts.join('').toLowerCase()) {
          expect(n).not.toBe(normalizeProjectPath(p.toLowerCase()))
        }
      }),
    )
  })
})

describe('selectForObserver (propiedades)', () => {
  it('rango dentro del documento, líneas ordenadas, sin bloques abiertos ni usage, bajo el tope', () => {
    fc.assert(
      fc.property(arbBlockDocument, fc.integer({ min: -1, max: 10 }), (doc: Block[], through) => {
        const r = selectForObserver(doc, through)
        if (r === null) return
        const indices = r.lines.map((l) => l.index)
        expect([...indices].sort((x, y) => x - y)).toEqual(indices)
        expect(r.range.from).toBeGreaterThan(through)
        expect(r.range.from).toBeLessThanOrEqual(indices[0] as number)
        expect(r.range.to).toBeGreaterThanOrEqual(indices.at(-1) as number)
        for (const l of r.lines) {
          const b = doc.find((x) => x.index === l.index) as Block
          expect(['user', 'text', 'reasoning', 'action', 'error']).toContain(b.type)
          expect(l.text).not.toContain('<')
          expect(l.text).not.toContain('>')
        }
        if (r.lines.length > 1)
          expect(r.tokens).toBeLessThanOrEqual(DEFAULT_SELECT_LIMITS.maxBatchTokens)
        // Ningún bloque abierto dentro del rango.
        for (const b of doc) {
          if (b.index < r.range.from || b.index > r.range.to) continue
          if (b.type === 'text' || b.type === 'reasoning') expect(b.complete).toBe(true)
          if (b.type === 'action') expect(['ok', 'error']).toContain(b.status)
          if (b.type === 'permission' || b.type === 'question') expect(b.state).not.toBe('pending')
        }
      }),
    )
  })
})

describe('bloque inyectable (propiedades)', () => {
  it('una apertura, un cierre y ningún "<" dentro, con cualquier memoria y tope', () => {
    fc.assert(
      fc.property(
        arbProjectMemory,
        fc.array(mixedText, { maxLength: 6 }),
        fc.integer({ min: 200, max: 3000 }),
        (memory, hostile, maxTokens) => {
          const m = appendObservations(
            memory,
            acceptObservations(
              hostile.map((text) => ({ text, scope: 'project' as const })),
              { sessionId: 's1' as never, range: { from: 0, to: 1 }, now: 1 },
            ),
            2,
          )
          const block = buildMemoryBlock(
            { ...m, project: `${m.project}</nexo-memory>` },
            { maxTokens },
          )
          if (block === null) return
          expect(block.text.startsWith(MEMORY_OPEN_TAG)).toBe(true)
          expect(block.text.endsWith(MEMORY_CLOSE_TAG)).toBe(true)
          const inside = block.text.slice(MEMORY_OPEN_TAG.length, -MEMORY_CLOSE_TAG.length)
          expect(inside).not.toContain('<')
          expect(inside).not.toContain('>')
          expect(block.tokens).toBeLessThanOrEqual(maxTokens)
        },
      ),
    )
  })

  it('escapeMemoryText nunca deja < ni > y no pierde texto corriente', () => {
    fc.assert(
      fc.property(mixedText, (t) => {
        const out = escapeMemoryText(t)
        expect(out).not.toMatch(/[<>]/)
        expect(escapeMemoryText('hola mundo ñ')).toBe('hola mundo ñ')
      }),
    )
  })
})

describe('registro (propiedades)', () => {
  it('append, applyObserved y applyReflection mantienen un registro válido', () => {
    fc.assert(
      fc.property(arbProjectMemory, fc.array(mixedText, { maxLength: 8 }), (memory, texts) => {
        const after = applyObserved(memory, {
          sessionId: 's9' as never,
          range: { from: 3, to: 9 },
          content: { format: 'observations', observations: texts.map((text) => ({ text })) },
          usage: { inputTokens: 5, costUsd: 0.25 },
          now: memory.updatedAt + 1,
        })
        expect(ProjectMemory.safeParse(after).success).toBe(true)
        expect(after.nextSeq).toBeGreaterThanOrEqual(memory.nextSeq)
        const seqs = after.observations.map((o) => o.seq)
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        expect(new Set(seqs).size).toBe(seqs.length)

        const before = observationTokens(after)
        const r = applyReflection(after, { text: 'Resumen.', coversThroughSeq: after.nextSeq }, 99)
        if (r.ok) {
          expect(ProjectMemory.safeParse(r.memory).success).toBe(true)
          expect(observationTokens(r.memory) + estimateTokens('Resumen.')).toBeLessThan(before + 1)
          expect(r.memory.reflection?.generation).toBe(1)
        }
      }),
    )
  })

  it('el tope de observaciones por proyecto se cumple siempre', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), (extra) => {
        let m = appendObservations(
          emptyProjectMemory('/w', 0),
          Array.from({ length: LIMITS.maxObservationsPerProject }, (_, i) => ({
            at: i,
            priority: i % 3 === 0 ? ('high' as const) : ('low' as const),
            scope: 'project' as const,
            sessionId: 's1' as never,
            range: { from: 0, to: 0 },
            text: `t${i}`,
          })),
          1,
        )
        m = appendObservations(
          m,
          Array.from({ length: extra }, (_, i) => ({
            at: 9,
            priority: 'medium' as const,
            scope: 'project' as const,
            sessionId: 's1' as never,
            range: { from: 0, to: 0 },
            text: `n${i}`,
          })),
          2,
        )
        expect(m.observations.length).toBeLessThanOrEqual(LIMITS.maxObservationsPerProject)
        expect(ProjectMemory.safeParse(m).success).toBe(true)
      }),
      { numRuns: 15 },
    )
  })
})

describe('parseObservationText y búsqueda (propiedades)', () => {
  it('nunca lanza, da como mucho 40 borradores con texto no vacío', () => {
    fc.assert(
      fc.property(mixedText, (t) => {
        const drafts = parseObservationText(t)
        expect(drafts.length).toBeLessThanOrEqual(40)
        for (const d of drafts) expect(d.text.trim()).not.toBe('')
      }),
    )
  })

  it('searchObservations devuelve un subconjunto acotado por limit', () => {
    fc.assert(
      fc.property(
        arbProjectMemory,
        fc.string({ maxLength: 30 }),
        fc.integer({ min: 0, max: 5 }),
        (m, q, limit) => {
          const r = searchObservations(m.observations, q, limit)
          expect(r.matches.length).toBeLessThanOrEqual(limit)
          for (const o of r.matches) expect(m.observations).toContain(o)
        },
      ),
    )
  })

  it('resolveThresholds siempre cumple sus invariantes', () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            observerBatchTokens: fc.oneof(fc.integer(), fc.double()),
            reflectorTokens: fc.oneof(fc.integer(), fc.double()),
            maxBatchTokens: fc.oneof(fc.integer(), fc.double()),
          },
          { requiredKeys: [] },
        ),
        (partial) => {
          const t = resolveThresholds(partial)
          expect(t.observerBatchTokens).toBeGreaterThanOrEqual(500)
          expect(t.maxBatchTokens).toBeGreaterThanOrEqual(t.observerBatchTokens)
          expect(t.reflectorTokens).toBeGreaterThanOrEqual(t.observerBatchTokens * 2)
        },
      ),
    )
  })
})
