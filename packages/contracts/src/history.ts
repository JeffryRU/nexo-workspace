import { z } from 'zod'
import { BlockDraft, ProviderId, ProviderSessionToken } from './agent.ts'
import { LIMITS } from './limits.ts'
import { lineText } from './text.ts'

/**
 * Historial de los proveedores (F4.3): `history.list` (sesiones agrupadas por carpeta) y `history.read`
 * (transcripción en bloques normalizados). Solo lectura; reanudar una sesión es `agent.create { resume }`.
 * Los métodos viven en `historyMethods`; `methods.ts` los suma al registro del protocolo.
 */

const Millis = z.int().nonnegative()
const Cwd = z.string().min(1).max(LIMITS.maxPathLength)
/** Cursor opaco (base64url): lo emite el daemon y solo él lo interpreta. */
export const HistoryCursor = z
  .string()
  .min(1)
  .max(LIMITS.maxHistoryCursorLength)
  .regex(/^[A-Za-z0-9_-]+$/)
export type HistoryCursor = z.infer<typeof HistoryCursor>

export const HistorySession = z.strictObject({
  provider: ProviderId,
  /** Ficha del proveedor: sirve de `resume` en `agent.create` y de `sessionId` en `history.read`. */
  sessionId: ProviderSessionToken,
  title: lineText(LIMITS.maxTitleLength).optional(),
  /** Carpeta de la sesión, si el proveedor la declara. */
  cwd: Cwd.optional(),
  createdAt: Millis.optional(),
  updatedAt: Millis,
  messageCount: z.int().nonnegative().optional(),
  /** `true` si el proveedor puede reanudarla (`agent.create { resume }`). */
  resumable: z.boolean(),
  /** `true` si `history.read` puede leerla. */
  readable: z.boolean(),
})
export type HistorySession = z.infer<typeof HistorySession>

/** Sesiones de una misma carpeta (`cwd` nulo = el proveedor no dice la carpeta). */
export const HistoryProject = z.strictObject({
  cwd: Cwd.nullable(),
  /** Último segmento de la carpeta, para mostrar. */
  name: lineText(LIMITS.maxTitleLength),
  sessions: z.array(HistorySession).min(1).max(LIMITS.maxHistoryPage),
})
export type HistoryProject = z.infer<typeof HistoryProject>

export const HISTORY_PROVIDER_STATUSES = [
  'ok',
  /** El proveedor no tiene historial (Ollama, Antigravity) o no lo anuncia (ACP). */
  'unsupported',
  'unavailable',
  'timeout',
  'error',
] as const
export const HistoryProviderStatus = z.strictObject({
  provider: ProviderId,
  status: z.enum(HISTORY_PROVIDER_STATUSES),
  reason: lineText(512).optional(),
  /** `true` si la lista salió de la caché del daemon. */
  cached: z.boolean().optional(),
})
export type HistoryProviderStatus = z.infer<typeof HistoryProviderStatus>

/** Un bloque de una transcripción: el contenido normalizado más su posición y su turno. */
export const HistoryBlock = z.strictObject({
  /** Posición en la transcripción (0, 1, 2... sin huecos). */
  index: z.int().nonnegative().max(LIMITS.maxHistoryBlocks),
  turn: z.int().nonnegative(),
  block: BlockDraft,
})
export type HistoryBlock = z.infer<typeof HistoryBlock>

export const historyMethods = {
  /**
   * Sesiones de los proveedores con historial, de la carpeta más reciente a la más antigua y, dentro de cada
   * carpeta, de la sesión más reciente a la más antigua. La paginación es por sesiones con cursor: una carpeta
   * puede quedar partida entre dos páginas (el cliente junta por `cwd`). Un proveedor que falla no rompe la
   * respuesta: su estado sale en `providers`.
   */
  'history.list': {
    params: z.strictObject({
      provider: ProviderId.optional(),
      /** Solo esa carpeta (comparación exacta tras normalizar). */
      cwd: Cwd.optional(),
      cursor: HistoryCursor.optional(),
      limit: z.int().min(1).max(LIMITS.maxHistoryPage).optional(),
    }),
    result: z.strictObject({
      projects: z.array(HistoryProject).max(LIMITS.maxHistoryPage),
      nextCursor: HistoryCursor.nullable(),
      providers: z.array(HistoryProviderStatus).max(32),
    }),
  },
  /** Transcripción de una sesión como bloques normalizados, por páginas (tope de bloques y de bytes). */
  'history.read': {
    params: z.strictObject({
      provider: ProviderId,
      sessionId: ProviderSessionToken,
      /** Carpeta de la sesión (ayuda a algunos proveedores a localizarla). */
      cwd: Cwd.optional(),
      cursor: HistoryCursor.optional(),
      limit: z.int().min(1).max(LIMITS.maxHistoryBlocksPage).optional(),
    }),
    result: z.strictObject({
      provider: ProviderId,
      sessionId: ProviderSessionToken,
      blocks: z.array(HistoryBlock).max(LIMITS.maxHistoryBlocksPage),
      nextCursor: HistoryCursor.nullable(),
      /** Bloques de la transcripción (ya acotada a `maxHistoryBlocks`). */
      total: z.int().nonnegative().max(LIMITS.maxHistoryBlocks),
      /** `true` si la transcripción tenía más bloques que el tope y se cortó, o se omitió o recortó alguno. */
      truncated: z.boolean(),
    }),
  },
} as const

export type HistoryMethodName = keyof typeof historyMethods
export const HISTORY_METHOD_NAMES = Object.keys(historyMethods) as HistoryMethodName[]
