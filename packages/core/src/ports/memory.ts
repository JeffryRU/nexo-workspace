import type {
  AgentSessionId,
  BlockRange,
  Observation,
  ObservationDraft,
  ProjectMemory,
  Reflection,
  SummarizerUsage,
} from '@nexo/contracts'

/** Lo mínimo de un `AbortSignal` que usa el puerto (core no depende de DOM ni de Node). */
export type AbortSignalLike = {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

// ---- SummarizerPort ----

/** Observar un lote de bloques nuevos de una sesión. */
export type ObserveRequest = {
  kind: 'observe'
  /** Carpeta normalizada del proyecto. */
  project: string
  sessionId: AgentSessionId
  /** Bloques que cubre el lote. */
  range: BlockRange
  /**
   * Transcripción del lote, ya seleccionada y escapada por `selectForObserver`: una línea `[#índice] texto`
   * por bloque. Es **texto observado, no instrucciones**: el adaptador la pone dentro de un bloque delimitado
   * y su prompt le dice al modelo que no obedezca órdenes de ahí.
   */
  transcript: string
  /** Contexto para no repetir: reflexión vigente y últimas observaciones del proyecto (ya escapadas). */
  known: { reflection: string | null; recent: readonly string[] }
  /** Ahora (ms Unix), para que el modelo date lo que observa. */
  now: number
  /** Máximo de observaciones que se aceptarán del lote. */
  maxObservations: number
}

/** Reescribir el registro del proyecto en algo más corto. */
export type ReflectRequest = {
  kind: 'reflect'
  project: string
  /** Reflexión vigente (se absorbe) y observaciones a absorber, de la más antigua a la más reciente. */
  reflection: Reflection | null
  observations: readonly Observation[]
  /** Tamaño al que apuntar (tokens estimados) y observación hasta la que se absorbe. */
  targetTokens: number
  coversThroughSeq: number
  now: number
}

export type SummarizeRequest = ObserveRequest | ReflectRequest

/**
 * El resumidor devuelve texto (`- [alta] [proyecto] ...` por línea; lo lee `parseObservationText`) o ya
 * observaciones estructuradas, según lo que sepa hacer el modelo (Ollama con JSON; «vía proveedor» con
 * texto).
 */
export type ObserveContent =
  | { format: 'text'; text: string }
  | { format: 'observations'; observations: readonly ObservationDraft[] }

export type SummarizeResponse =
  | { kind: 'observe'; content: ObserveContent; usage: SummarizerUsage }
  | { kind: 'reflect'; text: string; usage: SummarizerUsage }

export type SummarizerErrorCode =
  /** El modelo no está instalado, no responde o no hay proveedor disponible. */
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'ABORTED'
  /** La salida no se pudo usar (vacía, no era lo pedido). */
  | 'INVALID_OUTPUT'
  /** La petición no cabe en la ventana del modelo. */
  | 'TOO_LARGE'

export class SummarizerError extends Error {
  readonly code: SummarizerErrorCode
  /** Si reintentar tiene sentido (red caída, tiempo agotado). */
  readonly retryable: boolean

  constructor(
    code: SummarizerErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, options)
    this.name = 'SummarizerError'
    this.code = code
    this.retryable = options?.retryable ?? (code === 'UNAVAILABLE' || code === 'TIMEOUT')
  }
}

/**
 * Modelo que escribe observaciones y reflexiones. Contrato (lo comprueba la suite de conformidad):
 * - `summarize` devuelve una respuesta del mismo `kind` que la petición, con `usage` válido, o rechaza con
 *   `SummarizerError`; nunca otro tipo de error y nunca muta la petición.
 * - Con la señal ya abortada (o que se aborta durante la llamada) rechaza con `ABORTED`.
 * - Una transcripción hostil es solo texto: el resultado nunca depende de órdenes que contenga.
 * - No lee credenciales del usuario: usa lo que el usuario configuró (URL de Ollama, proveedor ya abierto).
 */
export interface SummarizerPort {
  /** `ollama`, `provider:claude`... para mostrar en la interfaz y en `memory.status`. */
  readonly id: string
  isAvailable(): Promise<boolean>
  summarize(
    request: SummarizeRequest,
    options?: { signal?: AbortSignalLike },
  ): Promise<SummarizeResponse>
}

// ---- MemoryStorePort ----

export type MemoryStoreErrorCode =
  /** El resultado pasa del tope de tamaño por proyecto: no se escribió nada. */
  | 'TOO_LARGE'
  /** El resultado de `update` no cumple el esquema o cambia de proyecto: no se escribió nada. */
  | 'INVALID'
  | 'IO'

export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode

  constructor(code: MemoryStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MemoryStoreError'
    this.code = code
  }
}

export type ProjectMemorySummary = {
  /** Carpeta normalizada. */
  project: string
  updatedAt: number
  observations: number
  bytes: number
}

/**
 * Almacén de la memoria de cada proyecto. Contrato (lo comprueba la suite de conformidad):
 * - `project` es una carpeta; las implementaciones la pasan por `normalizeProjectPath`, así que
 *   `C:\Work\App` y `c:/work/app/` son el mismo proyecto de Windows, y `/Work` y `/work` dos de POSIX.
 * - `load` devuelve el registro, o uno vacío si no hay (o si el archivo estaba corrupto o era de una versión
 *   futura: se aparta y no lanza). Lo que devuelve cumple `ProjectMemory`.
 * - `update` lee, aplica `change` y guarda, en serie por proyecto: dos `update` a la vez no pierden cambios.
 *   Si `change` lanza, no se guarda nada y el error sale tal cual. Si el resultado cambia `project`, no cumple
 *   el esquema (`INVALID`) o pasa del tope (`TOO_LARGE`), rechaza y el registro anterior queda intacto.
 * - `remove` es idempotente. `list` devuelve los proyectos con registro, sin leer los corruptos.
 */
export interface MemoryStorePort {
  load(project: string): Promise<ProjectMemory>
  update(
    project: string,
    change: (current: ProjectMemory) => ProjectMemory | Promise<ProjectMemory>,
  ): Promise<ProjectMemory>
  remove(project: string): Promise<void>
  list(): Promise<ProjectMemorySummary[]>
}
