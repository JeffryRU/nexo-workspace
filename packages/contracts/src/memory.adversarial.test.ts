import { arbHostileString, hasProtoKey } from '@nexo/testkit'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { LIMITS, memoryMethods, Observation, ProjectMemory } from './index.ts'

const good = {
  seq: 1,
  at: 1,
  priority: 'low',
  scope: 'session',
  sessionId: 's1',
  range: { from: 0, to: 0 },
  text: 'ok',
}

describe('adversarial: memoria', () => {
  it('texto hostil nunca rompe el análisis y NUL o sustitutos sueltos se rechazan', () => {
    fc.assert(
      fc.property(arbHostileString, (text) => {
        const r = Observation.safeParse({ ...good, text })
        if (r.success) expect(r.data.text).toBe(text)
      }),
    )
    expect(Observation.safeParse({ ...good, text: 'a\u0000b' }).success).toBe(false)
    expect(Observation.safeParse({ ...good, text: '\ud800' }).success).toBe(false)
  })

  it('texto de observación pasado de tamaño en bytes (emoji) se rechaza', () => {
    const text = '😀'.repeat(LIMITS.maxObservationBytes / 4 + 1)
    expect(Observation.safeParse({ ...good, text }).success).toBe(false)
  })

  it('__proto__ y claves extra en el archivo se rechazan sin contaminar', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"version":1,"project":"/a","updatedAt":1,"nextSeq":1,"observations":[],"reflection":null,"sessions":[],"usage":{"calls":0,"inputTokens":0,"outputTokens":0,"costUsd":0}}',
    )
    expect(ProjectMemory.safeParse(hostile).success).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(hasProtoKey(hostile)).toBe(true)
  })

  it('listas enormes y números fuera de rango se rechazan', () => {
    const many = Array.from({ length: LIMITS.maxObservationsPerProject + 1 }, (_, i) => ({
      ...good,
      seq: i + 1,
    }))
    const m = {
      version: 1,
      project: '/a',
      updatedAt: 1,
      nextSeq: many.length + 1,
      observations: many,
      reflection: null,
      sessions: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }
    expect(ProjectMemory.safeParse(m).success).toBe(false)
    expect(Observation.safeParse({ ...good, seq: 1.5 }).success).toBe(false)
    expect(Observation.safeParse({ ...good, at: -1 }).success).toBe(false)
    expect(Observation.safeParse({ ...good, range: { from: 0, to: 10 ** 9 } }).success).toBe(false)
  })

  it('consultas con control o demasiado largas se rechazan', () => {
    const p = memoryMethods['memory.search'].params
    expect(p.safeParse({ cwd: '/a', query: 'a\nb' }).success).toBe(false)
    expect(p.safeParse({ cwd: '/a', query: '' }).success).toBe(false)
    expect(p.safeParse({ cwd: '', query: 'x' }).success).toBe(false)
  })
})

describe('memory.configure y agent.renew: entradas hostiles', () => {
  const configure = memoryMethods['memory.configure'].params
  it('rechaza claves de más, tipos cambiados, números raros y prototipos', () => {
    const hostile: unknown[] = [
      null,
      [],
      'on',
      { enabled: 'true' },
      { enabled: true, extra: 1 },
      { renewAtTokens: '50000' },
      { renewAtTokens: 50_000.5 },
      { renewAtTokens: Number.NaN },
      { renewAtTokens: Number.POSITIVE_INFINITY },
      { renewAtTokens: -1 },
      { renewAtTokens: 1e21 },
      { renewAtTokens: [50_000] },
      JSON.parse('{"__proto__":{"enabled":true},"enabled":true}'),
      JSON.parse('{"constructor":{"prototype":{}},"enabled":true}'),
    ]
    for (const h of hostile) expect(configure.safeParse(h).success, JSON.stringify(h)).toBe(false)
  })
  it('agent.renew exige un id de sesión válido y nada más', async () => {
    const { methods } = await import('./methods.ts')
    const p = methods['agent.renew'].params
    expect(p.safeParse({ sessionId: 'agent-session-00000001' }).success).toBe(true)
    for (const h of [
      {},
      { sessionId: '' },
      { sessionId: 'x'.repeat(500) },
      { sessionId: 1 },
      { sessionId: 'agent-session-00000001', a: 1 },
    ])
      expect(p.safeParse(h).success, JSON.stringify(h)).toBe(false)
  })
})
