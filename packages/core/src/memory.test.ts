import { type AgentSessionId, LIMITS, type Observation, type ProjectMemory } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import {
  acceptObservations,
  addUsage,
  appendObservations,
  applyObserved,
  applyReflection,
  DEFAULT_MEMORY_THRESHOLDS,
  draftsFromContent,
  emptyProjectMemory,
  estimateTokens,
  markObserved,
  mergeSources,
  normalizeProjectPath,
  observationTokens,
  observedThrough,
  parseObservationText,
  reflectionTargetTokens,
  reflectionTokens,
  resolveThresholds,
  searchObservations,
  shouldObserve,
  shouldReflect,
} from './index.ts'

const S1 = 's1' as AgentSessionId
const S2 = 's2' as AgentSessionId
const obs = (
  text: string,
  over: Partial<Omit<Observation, 'seq'>> = {},
): Omit<Observation, 'seq'> => ({
  at: 1,
  priority: 'medium',
  scope: 'project',
  sessionId: S1,
  range: { from: 0, to: 1 },
  text,
  ...over,
})
const fill = (n: number, text = 'dato de la carpeta repetido para pesar') => {
  let m = emptyProjectMemory('/w', 0)
  m = appendObservations(
    m,
    Array.from({ length: n }, (_, i) => obs(`${text} ${i}`)),
    1,
  )
  return m
}

describe('estimateTokens', () => {
  it('es determinista, monótono y documenta ~4 caracteres ASCII por token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
    expect(estimateTokens('ñ'.repeat(4))).toBe(2)
    expect(estimateTokens('日'.repeat(4))).toBe(4)
    expect(estimateTokens('😀')).toBe(2)
    expect(estimateTokens('\ud800')).toBe(1)
  })
})

describe('normalizeProjectPath', () => {
  it('unifica separadores, mayúsculas y segmentos en rutas de Windows', () => {
    const same = ['C:\\Work\\App', 'c:/work/app/', 'C:/WORK/App', 'c:\\work\\.\\x\\..\\app\\\\']
    for (const p of same) expect(normalizeProjectPath(p)).toBe('c:/work/app')
    expect(normalizeProjectPath('C:\\')).toBe('c:/')
    expect(normalizeProjectPath('C:')).toBe('c:/')
    expect(normalizeProjectPath('c:\\..\\..')).toBe('c:/')
    expect(normalizeProjectPath('\\\\Srv\\Share\\Dir\\')).toBe('//srv/share/dir')
    expect(normalizeProjectPath('\\\\?\\C:\\Work')).toBe('c:/work')
  })

  it('en POSIX conserva mayúsculas y la barra invertida', () => {
    expect(normalizeProjectPath('/Work//App/./x/..')).toBe('/Work/App')
    expect(normalizeProjectPath('/')).toBe('/')
    expect(normalizeProjectPath('/../..')).toBe('/')
    expect(normalizeProjectPath('/a\\b')).toBe('/a\\b')
    expect(normalizeProjectPath('rel/../../x')).toBe('../x')
    expect(normalizeProjectPath('')).toBe('')
    expect(normalizeProjectPath('/a\0b')).toBe('/ab')
  })
})

describe('umbrales', () => {
  it('valen 6k y 40k por omisión (ADR 0007)', () => {
    expect(DEFAULT_MEMORY_THRESHOLDS.observerBatchTokens).toBe(6000)
    expect(DEFAULT_MEMORY_THRESHOLDS.reflectorTokens).toBe(40000)
    expect(resolveThresholds()).toEqual(DEFAULT_MEMORY_THRESHOLDS)
  })

  it('acota y completa valores raros', () => {
    expect(resolveThresholds({ observerBatchTokens: 1 }).observerBatchTokens).toBe(500)
    expect(resolveThresholds({ observerBatchTokens: Number.NaN }).observerBatchTokens).toBe(6000)
    const t = resolveThresholds({ observerBatchTokens: 30_000, reflectorTokens: 1000 })
    expect(t.reflectorTokens).toBe(60_000)
    expect(t.maxBatchTokens).toBeGreaterThanOrEqual(t.observerBatchTokens)
    expect(resolveThresholds({ reflectorTokens: 9e12 }).reflectorTokens).toBe(2_000_000)
  })

  it('shouldObserve y shouldReflect respetan los umbrales', () => {
    const t = resolveThresholds()
    expect(shouldObserve(5999, t)).toBe(false)
    expect(shouldObserve(6000, t)).toBe(true)
    const small = fill(3)
    expect(shouldReflect(small, t)).toBe(false)
    expect(
      shouldReflect(small, resolveThresholds({ observerBatchTokens: 500, reflectorTokens: 1000 })),
    ).toBe(false)
    const big = fill(200, 'x'.repeat(300))
    expect(observationTokens(big)).toBeGreaterThan(5000)
    expect(
      shouldReflect(big, resolveThresholds({ observerBatchTokens: 500, reflectorTokens: 1000 })),
    ).toBe(true)
    expect(reflectionTargetTokens(t)).toBe(20_000)
    expect(reflectionTokens(small)).toBe(0)
  })
})

describe('parseObservationText', () => {
  it('lee etiquetas en español, inglés y cualquier orden', () => {
    const out = parseObservationText(
      [
        'Aquí van las notas:',
        '- [alta] [proyecto] Usa pnpm',
        '* [project] [low] Rama feat/x',
        '- sin etiquetas',
        '- [rara] texto con etiqueta desconocida',
        '- [media]',
      ].join('\n'),
    )
    expect(out).toEqual([
      { text: 'Usa pnpm', priority: 'high', scope: 'project' },
      { text: 'Rama feat/x', priority: 'low', scope: 'project' },
      { text: 'sin etiquetas' },
      { text: '[rara] texto con etiqueta desconocida' },
    ])
  })

  it('sin viñetas, cada línea no vacía es una observación', () => {
    expect(parseObservationText('uno\n\r\n dos ').map((d) => d.text)).toEqual(['uno', 'dos'])
    expect(parseObservationText('')).toEqual([])
  })
})

describe('acceptObservations', () => {
  const batch = { sessionId: S1, range: { from: 10, to: 20 }, now: 99 }

  it('sanea, quita vacíos y repetidos y acota el rango al lote', () => {
    const out = acceptObservations(
      [
        { text: '  hola\u0000 ' },
        { text: 'hola\ufffd' },
        { text: '   ' },
        { text: 'otra', range: { from: 0, to: 100 }, priority: 'high', scope: 'project' },
        { text: 'fuera', range: { from: 50, to: 60 } },
      ],
      batch,
    )
    expect(out.map((o) => o.text)).toEqual(['hola\ufffd', 'otra', 'fuera'])
    expect(out[1]?.range).toEqual({ from: 10, to: 20 })
    expect(out[2]?.range).toEqual({ from: 20, to: 20 })
    expect(out[0]).toMatchObject({ priority: 'medium', scope: 'session', at: 99, sessionId: S1 })
  })

  it('recorta el texto al tope y limita el lote a 40', () => {
    const [one] = acceptObservations([{ text: 'a'.repeat(5000) }], batch)
    expect(one?.text.length).toBe(LIMITS.maxObservationBytes)
    const many = acceptObservations(
      Array.from({ length: 100 }, (_, i) => ({ text: `n${i}` })),
      batch,
    )
    expect(many).toHaveLength(40)
  })
})

describe('appendObservations', () => {
  it('asigna seq crecientes sin reutilizar', () => {
    let m = fill(3)
    expect(m.observations.map((o) => o.seq)).toEqual([1, 2, 3])
    m = appendObservations(m, [obs('x')], 5)
    expect(m.nextSeq).toBe(5)
    expect(m.observations.at(-1)?.seq).toBe(4)
  })

  it('al pasar el tope descarta primero lo de menor prioridad y más antiguo', () => {
    let m = emptyProjectMemory('/w', 0)
    m = appendObservations(
      m,
      [
        obs('vieja alta', { priority: 'high' }),
        ...Array.from({ length: LIMITS.maxObservationsPerProject - 1 }, (_, i) =>
          obs(`l${i}`, { priority: 'low' }),
        ),
      ],
      1,
    )
    m = appendObservations(m, [obs('nueva')], 2)
    expect(m.observations).toHaveLength(LIMITS.maxObservationsPerProject)
    const texts = m.observations.map((o) => o.text)
    expect(texts).toContain('vieja alta')
    expect(texts).toContain('nueva')
    expect(texts).not.toContain('l0')
  })
})

describe('progreso y uso', () => {
  it('markObserved no retrocede y addUsage suma', () => {
    let m = emptyProjectMemory('/w', 0)
    m = markObserved(m, S1, 7, 1)
    m = markObserved(m, S1, 3, 2)
    expect(observedThrough(m, S1)).toBe(7)
    expect(observedThrough(m, S2)).toBe(-1)
    m = addUsage(m, { inputTokens: 10, outputTokens: 5, costUsd: 0.5 }, 3)
    m = addUsage(m, {}, 4)
    expect(m.usage).toEqual({ calls: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.5 })
  })

  it('conserva solo las sesiones más recientes', () => {
    let m = emptyProjectMemory('/w', 0)
    for (let i = 0; i < LIMITS.maxMemorySessions + 5; i++) {
      m = markObserved(m, `s${i}` as AgentSessionId, i, i)
    }
    expect(m.sessions).toHaveLength(LIMITS.maxMemorySessions)
    expect(observedThrough(m, 's0' as AgentSessionId)).toBe(-1)
  })

  it('applyObserved cierra el lote: observaciones, progreso y uso', () => {
    const m = applyObserved(emptyProjectMemory('/w', 0), {
      sessionId: S1,
      range: { from: 0, to: 4 },
      content: { format: 'text', text: '- [alta] [proyecto] Usa vitest' },
      usage: { inputTokens: 3 },
      now: 9,
    })
    expect(m.observations).toHaveLength(1)
    expect(observedThrough(m, S1)).toBe(4)
    expect(m.usage.calls).toBe(1)
    const empty = applyObserved(m, {
      sessionId: S1,
      range: { from: 5, to: 6 },
      content: { format: 'observations', observations: [] },
      usage: {},
      now: 10,
    })
    expect(observedThrough(empty, S1)).toBe(6)
    expect(
      draftsFromContent({ format: 'observations', observations: [{ text: 'a' }] }),
    ).toHaveLength(1)
  })
})

describe('applyReflection', () => {
  const big = () =>
    fill(30, 'observación larga con muchos detalles que se pueden condensar bastante')

  it('absorbe lo cubierto, conserva lo posterior y sube la generación', () => {
    const m = big()
    const r = applyReflection(m, { text: 'Resumen corto.', coversThroughSeq: 20 }, 50)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.memory.reflection).toMatchObject({
      generation: 1,
      coversThroughSeq: 20,
      createdAt: 50,
    })
    expect(r.memory.observations.map((o) => o.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => 21 + i),
    )
    expect(r.memory.reflection?.sources).toEqual([{ sessionId: S1, from: 0, to: 1 }])
    const again = applyReflection(r.memory, { text: 'Aún más corto.', coversThroughSeq: 99 }, 60)
    expect(again.ok && again.memory.reflection?.generation).toBe(2)
    expect(again.ok && again.memory.observations).toEqual([])
  })

  it('rechaza vacío, nada que absorber y texto que no ahorra', () => {
    const m = big()
    const reason = (text: string, through: number, mem = m) => {
      const r = applyReflection(mem, { text, coversThroughSeq: through }, 1)
      return r.ok ? 'ok' : r.reason
    }
    expect(reason('  \n ', 30)).toBe('EMPTY')
    expect(reason('x', 0)).toBe('NOTHING_TO_REFLECT')
    expect(reason('x', 30, emptyProjectMemory('/w', 0))).toBe('NOTHING_TO_REFLECT')
    expect(reason('y'.repeat(100_000), 30)).toBe('NOT_SMALLER')
    expect(reason('y'.repeat(2000), 3)).toBe('NOT_SMALLER')
  })

  it('mergeSources une rangos contiguos de una sesión y respeta el tope', () => {
    expect(
      mergeSources([
        { sessionId: S1, from: 5, to: 8 },
        { sessionId: S1, from: 0, to: 4 },
        { sessionId: S2, from: 0, to: 1 },
        { sessionId: S1, from: 20, to: 22 },
      ]),
    ).toEqual([
      { sessionId: S1, from: 0, to: 8 },
      { sessionId: S1, from: 20, to: 22 },
      { sessionId: S2, from: 0, to: 1 },
    ])
    const many = Array.from({ length: 200 }, (_, i) => ({ sessionId: S1, from: i * 3, to: i * 3 }))
    expect(mergeSources(many)).toHaveLength(LIMITS.maxReflectionSources)
  })
})

describe('searchObservations', () => {
  const m: ProjectMemory = appendObservations(
    emptyProjectMemory('/w', 0),
    [
      obs('El proyecto usa pnpm y vitest', { priority: 'low' }),
      obs('Se despliega con Dokploy', { priority: 'high' }),
      obs('Prueba de pnpm con Windows'),
    ],
    1,
  )

  it('puntúa por términos y desempata por prioridad y recencia', () => {
    const r = searchObservations(m.observations, 'PNPM windows', 10)
    expect(r.matches.map((o) => o.seq)).toEqual([3, 1])
    expect(r.truncated).toBe(false)
  })

  it('respeta el límite, ignora consultas vacías y símbolos', () => {
    expect(searchObservations(m.observations, 'pnpm', 1)).toMatchObject({ truncated: true })
    expect(searchObservations(m.observations, '  ¿? ', 5).matches).toEqual([])
    expect(searchObservations(m.observations, 'pnpm', 0).matches).toEqual([])
    expect(searchObservations(m.observations, 'dokploy', 5).matches[0]?.seq).toBe(2)
  })
})
