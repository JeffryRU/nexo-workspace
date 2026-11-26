import {
  type AgentSessionId,
  type Block,
  type Observation,
  ProjectMemory,
  type SummarizerUsage,
  utf8ByteLength,
} from '@nexo/contracts'
import {
  type AbortSignalLike,
  emptyProjectMemory,
  estimateTokens,
  MemoryStoreError,
  type MemoryStorePort,
  normalizeProjectPath,
  type ObserveRequest,
  type ProjectMemorySummary,
  type ReflectRequest,
  type SummarizeRequest,
  type SummarizeResponse,
  SummarizerError,
  type SummarizerPort,
} from '@nexo/core'
import * as fc from 'fast-check'
import { arbAgentSessionId, arbBlock } from './arbitraries-agent.ts'

// ---- Falso de SummarizerPort ----

export type FakeSummarizerOptions = {
  /** Respuesta propia; sin ella, el falso resume de forma determinista. */
  handler?: (request: SummarizeRequest) => SummarizeResponse | Promise<SummarizeResponse>
  /** Si es true, devuelve observaciones estructuradas en lugar de texto. */
  structured?: boolean
}

/**
 * Resumidor falso, determinista: observa una observación por cada línea de la transcripción (hasta 3) y
 * reflexiona recortando cada observación. Registra las peticiones. `failNext` encola errores.
 */
export class FakeSummarizer implements SummarizerPort {
  readonly id: string
  readonly requests: SummarizeRequest[] = []
  available = true
  readonly #failures: SummarizerError[] = []
  readonly #options: FakeSummarizerOptions

  constructor(id = 'fake', options: FakeSummarizerOptions = {}) {
    this.id = id
    this.#options = options
  }

  failNext(error: SummarizerError): void {
    this.#failures.push(error)
  }

  async isAvailable(): Promise<boolean> {
    return this.available
  }

  async summarize(
    request: SummarizeRequest,
    options?: { signal?: AbortSignalLike },
  ): Promise<SummarizeResponse> {
    if (options?.signal?.aborted) throw new SummarizerError('ABORTED', 'cancelado')
    this.requests.push(request)
    const failure = this.#failures.shift()
    if (failure !== undefined) throw failure
    if (!this.available) throw new SummarizerError('UNAVAILABLE', 'el modelo no está disponible')
    if (this.#options.handler !== undefined) return this.#options.handler(request)
    return request.kind === 'observe' ? this.#observe(request) : this.#reflect(request)
  }

  #observe(request: ObserveRequest): SummarizeResponse {
    const lines = request.transcript.split('\n').filter((l) => l.trim() !== '')
    const picked = lines.slice(0, 3).map((l) => `Observado: ${l.slice(0, 120)}`)
    const usage: SummarizerUsage = {
      model: 'fake',
      inputTokens: estimateTokens(request.transcript),
      outputTokens: estimateTokens(picked.join('\n')),
      costUsd: 0,
    }
    if (this.#options.structured === true) {
      return {
        kind: 'observe',
        content: {
          format: 'observations',
          observations: picked.map((text) => ({ text, priority: 'medium', scope: 'project' })),
        },
        usage,
      }
    }
    return {
      kind: 'observe',
      content: { format: 'text', text: picked.map((t) => `- [media] [proyecto] ${t}`).join('\n') },
      usage,
    }
  }

  #reflect(request: ReflectRequest): SummarizeResponse {
    const parts = [
      ...(request.reflection === null ? [] : [request.reflection.text.slice(0, 200)]),
      ...request.observations.map((o) => o.text.slice(0, 40)),
    ]
    const text = parts.join('; ').slice(0, 2000) || 'Sin novedades.'
    return {
      kind: 'reflect',
      text,
      usage: { model: 'fake', inputTokens: 100, outputTokens: estimateTokens(text), costUsd: 0 },
    }
  }
}

// ---- Falso de MemoryStorePort ----

/** Almacén en memoria con la misma semántica que el de disco (clave normalizada, serie por proyecto, tope). */
export class FakeMemoryStore implements MemoryStorePort {
  readonly #records = new Map<string, string>()
  readonly #chains = new Map<string, Promise<unknown>>()
  readonly #now: () => number
  readonly #maxBytes: number

  constructor(options: { now?: () => number; maxBytes?: number } = {}) {
    this.#now = options.now ?? (() => 0)
    this.#maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  }

  async load(project: string): Promise<ProjectMemory> {
    const key = normalizeProjectPath(project)
    const raw = this.#records.get(key)
    return raw === undefined
      ? emptyProjectMemory(key, this.#now())
      : (JSON.parse(raw) as ProjectMemory)
  }

  update(
    project: string,
    change: (current: ProjectMemory) => ProjectMemory | Promise<ProjectMemory>,
  ): Promise<ProjectMemory> {
    const key = normalizeProjectPath(project)
    const run = async () => {
      const next = await change(await this.load(key))
      const parsed = ProjectMemory.safeParse(next)
      if (!parsed.success || parsed.data.project !== key) {
        throw new MemoryStoreError('INVALID', 'el registro no es válido o cambia de proyecto')
      }
      const raw = JSON.stringify(parsed.data)
      if (utf8ByteLength(raw) > this.#maxBytes) {
        throw new MemoryStoreError('TOO_LARGE', 'el registro pasa del tope de tamaño')
      }
      this.#records.set(key, raw)
      return JSON.parse(raw) as ProjectMemory
    }
    const result = (this.#chains.get(key) ?? Promise.resolve()).then(run, run)
    this.#chains.set(
      key,
      result.catch(() => {}),
    )
    return result
  }

  async remove(project: string): Promise<void> {
    this.#records.delete(normalizeProjectPath(project))
  }

  async list(): Promise<ProjectMemorySummary[]> {
    return [...this.#records].map(([project, raw]) => {
      const m = JSON.parse(raw) as ProjectMemory
      return {
        project,
        updatedAt: m.updatedAt,
        observations: m.observations.length,
        bytes: utf8ByteLength(raw),
      }
    })
  }
}

// ---- Ejemplos y generadores ----

export const SAMPLE_SESSION = 's1' as AgentSessionId

export function sampleObserveRequest(over: Partial<ObserveRequest> = {}): ObserveRequest {
  return {
    kind: 'observe',
    project: '/work/app',
    sessionId: SAMPLE_SESSION,
    range: { from: 0, to: 2 },
    transcript:
      '[#0] usuario: añade pruebas al módulo de pagos\n[#1] agente: Listo, usé vitest.\n[#2] acción Bash (exec, ok): npm test; código 0',
    known: { reflection: null, recent: [] },
    now: 1_700_000_000_000,
    maxObservations: 20,
    ...over,
  }
}

export function sampleReflectRequest(over: Partial<ReflectRequest> = {}): ReflectRequest {
  const observations: Observation[] = [1, 2, 3].map((seq) => ({
    seq,
    at: 1_700_000_000_000 + seq,
    priority: 'medium',
    scope: 'project',
    sessionId: SAMPLE_SESSION,
    range: { from: seq, to: seq + 1 },
    text: `El proyecto usa vitest y pnpm, dato número ${seq}, con bastante texto para que resumir ahorre.`,
  }))
  return {
    kind: 'reflect',
    project: '/work/app',
    reflection: null,
    observations,
    targetTokens: 50,
    coversThroughSeq: 3,
    now: 1_700_000_100_000,
    ...over,
  }
}

const arbLineText = fc
  .stringMatching(/^[A-Za-z0-9áéíóúñ ,.:;_-]{1,120}$/)
  .filter((s) => s.trim() !== '')

export const arbObservation: fc.Arbitrary<Observation> = fc
  .record({
    at: fc.integer({ min: 0, max: 2 ** 40 }),
    priority: fc.constantFrom('high', 'medium', 'low' as const),
    scope: fc.constantFrom('session', 'project' as const),
    sessionId: arbAgentSessionId,
    from: fc.integer({ min: 0, max: 500 }),
    len: fc.integer({ min: 0, max: 30 }),
    text: arbLineText,
  })
  .map(({ from, len, text, ...o }) => ({ ...o, seq: 1, range: { from, to: from + len }, text }))

/** Registro de proyecto válido: `seq` creciente, `nextSeq` adelantado y sesiones únicas. */
export const arbProjectMemory: fc.Arbitrary<ProjectMemory> = fc
  .record({
    project: fc.constantFrom('/work/app', 'c:/work/app', '/home/u/proyecto'),
    observations: fc.array(arbObservation, { maxLength: 25 }),
    gaps: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 25, maxLength: 25 }),
    updatedAt: fc.integer({ min: 0, max: 2 ** 40 }),
  })
  .map(({ project, observations, gaps, updatedAt }) => {
    let seq = 0
    const list = observations.map((o, i) => {
      seq += gaps[i] ?? 1
      return { ...o, seq }
    })
    return {
      version: 1 as const,
      project,
      updatedAt,
      nextSeq: seq + 1,
      observations: list,
      reflection: null,
      sessions: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }
  })

/** Documento de bloques con `index` 0, 1, 2... sin huecos (como lo produce el daemon). */
export const arbBlockDocument: fc.Arbitrary<Block[]> = fc
  .array(arbBlock, { maxLength: 30 })
  .map((blocks) => blocks.map((b, index) => ({ ...b, index }) as Block))
