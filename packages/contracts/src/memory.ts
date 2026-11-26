import { z } from 'zod'
import { Block, Token } from './agent.ts'
import { AgentSessionId } from './domain.ts'
import { LIMITS } from './limits.ts'
import { bodyText, lineText } from './text.ts'

/**
 * Memoria observacional (F3.5.1, ADR 0007). Modelo, formato en disco y métodos `memory.*`.
 * Los métodos viven en `memoryMethods`; `methods.ts` los suma al registro del protocolo (F3.5.2) y el
 * daemon los atiende con `MemoryService` (ver `docs/ARCHITECTURE.md`, «Memoria observacional (F3.5)»).
 */

const Millis = z.int().nonnegative()
const Path = z.string().min(1).max(LIMITS.maxPathLength)
const Count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const MemoryPriority = z.enum(['high', 'medium', 'low'])
export type MemoryPriority = z.infer<typeof MemoryPriority>

/** `session`: relevante solo para la sesión de origen; `project`: dato duradero de la carpeta. */
export const MemoryScope = z.enum(['session', 'project'])
export type MemoryScope = z.infer<typeof MemoryScope>

/** Rango inclusivo de `index` de bloques de una sesión. */
export const BlockRange = z
  .strictObject({
    from: z
      .int()
      .nonnegative()
      .max(LIMITS.maxBlocksPerSession - 1),
    to: z
      .int()
      .nonnegative()
      .max(LIMITS.maxBlocksPerSession - 1),
  })
  .refine((r) => r.from <= r.to, { message: 'from no puede pasar de to' })
export type BlockRange = z.infer<typeof BlockRange>

/** Rango de origen de una observación o reflexión: de qué bloques de qué sesión sale. */
export const SourceRange = z
  .strictObject({
    sessionId: AgentSessionId,
    from: BlockRange.shape.from,
    to: BlockRange.shape.to,
  })
  .refine((r) => r.from <= r.to, { message: 'from no puede pasar de to' })
export type SourceRange = z.infer<typeof SourceRange>

export const Observation = z.strictObject({
  /** Número dentro del proyecto, creciente y nunca reutilizado. */
  seq: z.int().positive(),
  /** Cuándo se observó (ms Unix). */
  at: Millis,
  priority: MemoryPriority,
  scope: MemoryScope,
  sessionId: AgentSessionId,
  range: BlockRange,
  text: bodyText(LIMITS.maxObservationBytes, 1),
})
export type Observation = z.infer<typeof Observation>

export const Reflection = z.strictObject({
  /** 1, 2, 3... Cada reflexión reemplaza a la anterior (la absorbe). */
  generation: z.int().positive(),
  createdAt: Millis,
  /** Absorbe las observaciones con `seq` menor o igual. */
  coversThroughSeq: z.int().nonnegative(),
  text: bodyText(LIMITS.maxReflectionBytes, 1),
  sources: z.array(SourceRange).max(LIMITS.maxReflectionSources),
})
export type Reflection = z.infer<typeof Reflection>

/** Hasta qué bloque de una sesión ya se observó. */
export const SessionProgress = z.strictObject({
  sessionId: AgentSessionId,
  /** `index` del último bloque observado; -1 = ninguno. */
  observedThrough: z
    .int()
    .min(-1)
    .max(LIMITS.maxBlocksPerSession - 1),
  updatedAt: Millis,
})
export type SessionProgress = z.infer<typeof SessionProgress>

/** Uso acumulado del Observador y del Reflector en un proyecto. */
export const MemoryUsageTotals = z.strictObject({
  calls: Count,
  inputTokens: Count,
  outputTokens: Count,
  costUsd: z.number().nonnegative().max(1e9),
})
export type MemoryUsageTotals = z.infer<typeof MemoryUsageTotals>

/** Uso de una llamada al resumidor; todo opcional porque cada adaptador informa lo suyo. */
export const SummarizerUsage = z.strictObject({
  model: Token.optional(),
  inputTokens: z.int().nonnegative().optional(),
  outputTokens: z.int().nonnegative().optional(),
  costUsd: z.number().nonnegative().max(1e9).optional(),
  durationMs: z.int().nonnegative().optional(),
})
export type SummarizerUsage = z.infer<typeof SummarizerUsage>

/** Observación propuesta por el resumidor: el dominio la sanea y le pone `seq`, fecha y sesión. */
export const ObservationDraft = z.strictObject({
  priority: MemoryPriority.optional(),
  scope: MemoryScope.optional(),
  text: z.string().max(64 * 1024),
  range: BlockRange.optional(),
})
export type ObservationDraft = z.infer<typeof ObservationDraft>

/**
 * Archivo de memoria de un proyecto (formato en disco, versión 1). Una versión mayor no se lee: el
 * almacén aparta el archivo. `project` es la carpeta normalizada (ver `normalizeProjectPath` en core).
 */
export const ProjectMemory = z
  .strictObject({
    version: z.literal(1),
    project: Path,
    updatedAt: Millis,
    /** `seq` de la próxima observación. */
    nextSeq: z.int().positive(),
    observations: z.array(Observation).max(LIMITS.maxObservationsPerProject),
    reflection: Reflection.nullable(),
    sessions: z.array(SessionProgress).max(LIMITS.maxMemorySessions),
    usage: MemoryUsageTotals,
  })
  .superRefine((m, ctx) => {
    let previous = 0
    for (const o of m.observations) {
      if (o.seq <= previous) ctx.addIssue({ code: 'custom', message: 'seq no creciente' })
      previous = o.seq
    }
    if (m.nextSeq <= previous) ctx.addIssue({ code: 'custom', message: 'nextSeq atrasado' })
    if (new Set(m.sessions.map((s) => s.sessionId)).size !== m.sessions.length) {
      ctx.addIssue({ code: 'custom', message: 'sesión repetida' })
    }
  })
export type ProjectMemory = z.infer<typeof ProjectMemory>

// ---- Métodos `memory.*` ----

const Cwd = Path
const MinPriority = MemoryPriority
const ProjectStats = z.strictObject({
  cwd: Cwd,
  observations: z.int().nonnegative(),
  observationTokens: z.int().nonnegative(),
  reflectionTokens: z.int().nonnegative(),
  generation: z.int().nonnegative(),
  sessions: z.int().nonnegative(),
  updatedAt: Millis,
})

export const memoryMethods = {
  /** Estado de la memoria; con `cwd`, también el del proyecto. */
  'memory.status': {
    params: z.strictObject({ cwd: Cwd.optional() }),
    result: z.strictObject({
      enabled: z.boolean(),
      /** Resumidor configurado (`ollama:llama3.2:3b`...), si lo hay. */
      summarizer: lineText(256).optional(),
      thresholds: z.strictObject({
        observerBatchTokens: z.int().positive(),
        reflectorTokens: z.int().positive(),
      }),
      /** Por qué la memoria está en pausa estando activada (resumidor ausente o caído); ausente si trabaja. */
      pausedReason: lineText(256).optional(),
      project: ProjectStats.optional(),
      /** Uso acumulado (Observador + Reflector) desde que arrancó el daemon. */
      usage: MemoryUsageTotals,
      /** El mismo uso desglosado por papel. */
      roles: z
        .strictObject({ observer: MemoryUsageTotals, reflector: MemoryUsageTotals })
        .optional(),
      /** Uso acumulado guardado en el proyecto (todas las ejecuciones del daemon). */
      projectUsage: MemoryUsageTotals.optional(),
    }),
  },
  /** Reflexión (solo en la primera página) y observaciones del proyecto con `seq >= fromSeq`. */
  'memory.list': {
    params: z.strictObject({
      cwd: Cwd,
      fromSeq: z.int().positive().optional(),
      limit: z.int().min(1).max(LIMITS.maxMemoryPage).optional(),
      scope: MemoryScope.optional(),
      minPriority: MinPriority.optional(),
    }),
    result: z.strictObject({
      reflection: Reflection.nullable(),
      observations: z.array(Observation).max(LIMITS.maxMemoryPage),
      /** `fromSeq` de la página siguiente, o `null` al llegar al final. */
      nextSeq: z.int().positive().nullable(),
    }),
  },
  /** Búsqueda por términos en las observaciones del proyecto, de más a menos relevante. */
  'memory.search': {
    params: z.strictObject({
      cwd: Cwd,
      query: lineText(LIMITS.maxMemoryQueryChars),
      limit: z.int().min(1).max(LIMITS.maxMemoryPage).optional(),
    }),
    result: z.strictObject({
      observations: z.array(Observation).max(LIMITS.maxMemoryPage),
      /** `true` si había más coincidencias que `limit`. */
      truncated: z.boolean(),
    }),
  },
  /** Texto original (bloques) detrás de un rango citado por una observación. */
  'memory.recall': {
    params: z
      .strictObject({ sessionId: AgentSessionId, range: BlockRange })
      .refine((p) => p.range.to - p.range.from < LIMITS.maxRecallBlocks, {
        message: `el rango pasa de ${LIMITS.maxRecallBlocks} bloques`,
      }),
    result: z.strictObject({
      blocks: z.array(Block).max(LIMITS.maxRecallBlocks),
      /** `true` si el daemon devolvió menos bloques del rango (por tamaño). */
      truncated: z.boolean(),
    }),
  },
} as const

export type MemoryMethodName = keyof typeof memoryMethods
export const MEMORY_METHOD_NAMES = Object.keys(memoryMethods) as MemoryMethodName[]
export type MemoryMethodParams<M extends MemoryMethodName> = z.infer<
  (typeof memoryMethods)[M]['params']
>
export type MemoryMethodResult<M extends MemoryMethodName> = z.infer<
  (typeof memoryMethods)[M]['result']
>
