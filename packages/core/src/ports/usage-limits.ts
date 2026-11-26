import type { AbortSignalLike } from './memory.ts'
import type { Unsubscribe } from './pty.ts'

export type UsageLimitsErrorCode =
  /** El proveedor no está instalado, no ha iniciado sesión, no tiene límites que consultar o no responde. */
  | 'UNAVAILABLE'
  /** La señal de cancelación se activó. */
  | 'ABORTED'

/** Error tipado del puerto: los rechazos de `UsageLimitsPort.query` son de esta clase. */
export class UsageLimitsError extends Error {
  readonly code: UsageLimitsErrorCode

  constructor(code: UsageLimitsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UsageLimitsError'
    this.code = code
  }
}

/** Una ventana de uso tal como la declara el proveedor (el servicio la valida: es salida ajena). */
export type UsageWindowInfo = {
  /** `primary`, `secondary`, `five_hour`... */
  id: string
  bucket?: string
  label?: string
  /** 0-100. */
  usedPercent: number
  windowMinutes?: number
  /** ms Unix. */
  resetsAt?: number
  state?: 'ok' | 'warning' | 'limit'
}

/** Lo que el proveedor sabe de sus límites. Nunca lleva datos de la cuenta (correo, nombre, id, plan). */
export type UsageReading = {
  windows: UsageWindowInfo[]
  /** `true` si el proveedor dice que el límite se alcanzó. */
  reached?: boolean
  /** ms Unix en que el proveedor observó el dato; por omisión, cuando lo recibió el servicio. */
  observedAt?: number
}

/**
 * Límites de uso de un proveedor (F4.4). Capacidad opcional de `AgentProviderPort` (`usageLimits`). Contrato (lo
 * comprueba la suite de conformidad):
 * - `query` (solo si el proveedor se puede consultar: Codex) devuelve las ventanas actuales; rechaza solo con
 *   `UsageLimitsError`; con la señal ya abortada, `ABORTED`. No abre sesiones de agente.
 * - `onUpdate` avisa de cada lectura nueva que el proveedor informa por su cuenta (notificaciones, eventos de una
 *   sesión). Entrega lecturas completas (el adaptador junta las parciales). Un oyente cancelado no recibe más.
 * - Las ventanas llevan `usedPercent` y reinicio; **ningún dato de la cuenta** (correo, nombre, id, plan) sale del
 *   adaptador, y no se leen ni se copian credenciales ni archivos del proveedor.
 */
export interface UsageLimitsPort {
  readonly providerId: string
  query?(request: { signal?: AbortSignalLike }): Promise<UsageReading>
  onUpdate(listener: (reading: UsageReading) => void): Unsubscribe
}
