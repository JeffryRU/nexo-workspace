import { describe, expect, it } from 'vitest'
import {
  BlockRange,
  LIMITS,
  MEMORY_METHOD_NAMES,
  memoryMethods,
  Observation,
  ProjectMemory,
  Reflection,
} from './index.ts'

const obs = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  at: 1000,
  priority: 'medium',
  scope: 'project',
  sessionId: 's1',
  range: { from: 0, to: 3 },
  text: 'El usuario prefiere pnpm.',
  ...over,
})
const memory = (over: Record<string, unknown> = {}) => ({
  version: 1,
  project: '/work/app',
  updatedAt: 5,
  nextSeq: 3,
  observations: [obs(1), obs(2)],
  reflection: null,
  sessions: [{ sessionId: 's1', observedThrough: 3, updatedAt: 5 }],
  usage: { calls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0 },
  ...over,
})

describe('contratos de memoria', () => {
  it('acepta observaciones, rangos y archivos válidos', () => {
    expect(Observation.safeParse(obs(1)).success).toBe(true)
    expect(BlockRange.safeParse({ from: 2, to: 2 }).success).toBe(true)
    expect(ProjectMemory.safeParse(memory()).success).toBe(true)
  })

  it('rechaza rangos invertidos y campos desconocidos', () => {
    expect(BlockRange.safeParse({ from: 3, to: 2 }).success).toBe(false)
    expect(Observation.safeParse({ ...obs(1), extra: 1 }).success).toBe(false)
    expect(Observation.safeParse(obs(0)).success).toBe(false)
    expect(Observation.safeParse(obs(1, { text: '' })).success).toBe(false)
  })

  it('el archivo exige seq creciente, nextSeq adelantado y sesiones únicas', () => {
    expect(ProjectMemory.safeParse(memory({ observations: [obs(2), obs(1)] })).success).toBe(false)
    expect(ProjectMemory.safeParse(memory({ nextSeq: 2 })).success).toBe(false)
    const s = { sessionId: 's1', observedThrough: -1, updatedAt: 1 }
    expect(ProjectMemory.safeParse(memory({ sessions: [s, s] })).success).toBe(false)
    expect(ProjectMemory.safeParse(memory({ version: 2 })).success).toBe(false)
  })

  it('reflexión: generación positiva y texto acotado', () => {
    const r = { generation: 1, createdAt: 1, coversThroughSeq: 2, text: 'x', sources: [] }
    expect(Reflection.safeParse(r).success).toBe(true)
    expect(Reflection.safeParse({ ...r, generation: 0 }).success).toBe(false)
    const big = 'a'.repeat(LIMITS.maxReflectionBytes + 1)
    expect(Reflection.safeParse({ ...r, text: big }).success).toBe(false)
  })

  it('métodos memory.*: parámetros estrictos y con tope', () => {
    expect(MEMORY_METHOD_NAMES).toEqual([
      'memory.status',
      'memory.list',
      'memory.search',
      'memory.recall',
    ])
    const m = memoryMethods
    expect(m['memory.status'].params.safeParse({}).success).toBe(true)
    expect(m['memory.list'].params.safeParse({ cwd: '/a', limit: 101 }).success).toBe(false)
    expect(m['memory.list'].params.safeParse({ cwd: '/a', limit: 100 }).success).toBe(true)
    expect(m['memory.search'].params.safeParse({ cwd: '/a', query: 'x'.repeat(257) }).success).toBe(
      false,
    )
    expect(m['memory.search'].params.safeParse({ cwd: '/a', query: 'pnpm', x: 1 }).success).toBe(
      false,
    )
    const range = (from: number, to: number) => ({ sessionId: 's1', range: { from, to } })
    expect(m['memory.recall'].params.safeParse(range(0, 199)).success).toBe(true)
    expect(m['memory.recall'].params.safeParse(range(0, 200)).success).toBe(false)
    expect(m['memory.recall'].params.safeParse(range(5, 4)).success).toBe(false)
  })
})
