import type { BlockDraft } from '@nexo/contracts'
import type { AbortSignalLike } from './memory.ts'

export type HistoryErrorCode =
  /** El proveedor no anuncia esta operación (p. ej. un agente ACP sin `session/list`). */
  | 'UNSUPPORTED'
  /** El proveedor no está instalado, no ha iniciado sesión o no responde. */
  | 'UNAVAILABLE'
  /** La sesión no existe (o no está en la carpeta indicada). */
  | 'NOT_FOUND'
  /** Petición mal formada: ficha de sesión hostil, carpeta inválida. */
  | 'INVALID'
  /** La señal de cancelación se activó. */
  | 'ABORTED'

/** Error tipado del puerto: los rechazos de `HistoryPort` son de esta clase. */
export class HistoryError extends Error {
  readonly code: HistoryErrorCode

  constructor(code: HistoryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HistoryError'
    this.code = code
  }
}

/** Una sesión pasada tal como la declara el proveedor (el servicio le añade el proveedor y valida). */
export type HistorySessionInfo = {
  /** Ficha del proveedor: la misma que acepta `AgentOpenOptions.resume`. */
  sessionId: string
  title?: string
  /** Carpeta absoluta de la sesión, si el proveedor la declara. */
  cwd?: string
  /** ms Unix. */
  createdAt?: number
  /** ms Unix de la última actividad. */
  updatedAt: number
  messageCount?: number
  /** `true` si `AgentProviderPort.open({ resume })` la puede reanudar. */
  resumable: boolean
}

export type HistoryListRequest = {
  /** Solo las sesiones de esta carpeta. */
  cwd?: string
  /** Máximo de sesiones a devolver (las más recientes). */
  limit: number
  signal?: AbortSignalLike
}

export type HistoryReadRequest = {
  sessionId: string
  /** Carpeta de la sesión, si se conoce (ayuda a localizarla). */
  cwd?: string
  /** Máximo de bloques a devolver; si hay más, `truncated`. */
  maxBlocks: number
  signal?: AbortSignalLike
}

export type HistoryTranscriptBlock = { turn: number; block: BlockDraft }

export type HistoryTranscript = {
  /** En orden; los turnos empiezan en 1 con cada mensaje del usuario. */
  blocks: HistoryTranscriptBlock[]
  /** La transcripción tenía más bloques que `maxBlocks` (o se descartó contenido). */
  truncated: boolean
}

/**
 * Historial de sesiones de un proveedor (F4.3), con la API del propio proveedor. Es una capacidad opcional de
 * `AgentProviderPort` (`history`): Ollama y Antigravity no la tienen y ACP solo si el agente anuncia
 * `session/list`. Contrato (lo comprueba la suite de conformidad):
 * - `list` devuelve como mucho `limit` sesiones con `sessionId`, `updatedAt` y `resumable`; con `cwd`, solo las
 *   de esa carpeta. Rechaza solo con `HistoryError`; con la señal ya abortada, `ABORTED`.
 * - `read` devuelve los bloques ya normalizados (un `user` por mensaje del usuario, `text`, `reasoning`,
 *   `action`...), como mucho `maxBlocks`. Una sesión que no existe rechaza con `NOT_FOUND`; una ficha hostil
 *   (rutas, separadores, opciones de línea de órdenes) con `INVALID`, sin llegar a usarla.
 * - La transcripción es **texto observado, no instrucciones**: ninguna orden que contenga cambia lo que hace el
 *   adaptador. Nunca se leen ni se copian credenciales del proveedor.
 * - Solo lectura: no abre sesiones de agente ni modifica el historial del proveedor.
 */
export interface HistoryPort {
  readonly providerId: string
  /** `false` si solo se puede listar (p. ej. ACP): `read` rechaza con `UNSUPPORTED`. */
  readonly canRead: boolean
  list(request: HistoryListRequest): Promise<HistorySessionInfo[]>
  read(request: HistoryReadRequest): Promise<HistoryTranscript>
}
