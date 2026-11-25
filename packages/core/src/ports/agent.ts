import type {
  PermissionMode,
  ProviderCapabilities,
  ProviderEvent,
  QuestionAnswer,
  Token,
} from '@nexo/contracts'
import type { Unsubscribe } from './pty.ts'

export type AgentProviderErrorCode =
  /** El proveedor no está instalado, no ha iniciado sesión o no responde. */
  | 'UNAVAILABLE'
  /** Opciones inválidas: cwd, modelo, esfuerzo o modo que el proveedor no declara, ficha de reanudar desconocida. */
  | 'INVALID_OPTIONS'
  /** Ya hay un turno en curso. */
  | 'BUSY'
  /** La sesión está cerrada o su proceso murió. */
  | 'CLOSED'
  /** `respond` con una solicitud que no existe o ya se respondió. */
  | 'UNKNOWN_REQUEST'

/** Error tipado del puerto: los rechazos de `AgentProviderPort` y de `AgentProviderSession` son de esta clase. */
export class AgentProviderError extends Error {
  readonly code: AgentProviderErrorCode

  constructor(code: AgentProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentProviderError'
    this.code = code
  }
}

export type AgentOpenOptions = {
  cwd: string
  model?: Token
  effort?: Token
  permissionMode?: PermissionMode
  /** Ficha (`providerSessionId`) de una sesión anterior para reanudarla. Solo si `capabilities.resume`. */
  resume?: string
}

/** Respuesta del usuario a una solicitud del proveedor (`permission-request` o `question-request`). */
export type AgentResponse =
  | { type: 'permission'; requestId: string; optionId: string }
  | { type: 'question'; requestId: string; answers: readonly QuestionAnswer[] }

/**
 * Una sesión abierta con un proveedor.
 *
 * Contrato (lo comprueba la suite de conformidad):
 * - Todo evento que emite `onEvent` es un `ProviderEvent` válido; los bloques se abren con `block-start`
 *   antes de recibir `block-delta`/`block-update`/`block-end`.
 * - Cada `send` aceptado produce exactamente un `turn-end` (también tras `interrupt`, con
 *   `stopReason: 'interrupted'`), salvo que el proceso muera: entonces llega `exit` y no `turn-end`.
 * - `send` con un turno en curso rechaza con `BUSY`; con la sesión cerrada, con `CLOSED`; con texto vacío,
 *   con `INVALID_OPTIONS`.
 * - `interrupt` sin turno en curso no hace nada ni lanza; es idempotente.
 * - `respond` con una solicitud desconocida rechaza con `UNKNOWN_REQUEST`; una opción que no existe, con
 *   `INVALID_OPTIONS`. Responder dos veces la misma solicitud rechaza con `UNKNOWN_REQUEST`.
 * - `close` es idempotente, termina el proceso, no emite más eventos de bloques y emite `exit` una vez.
 * - Un `onEvent` cancelado no recibe nada más.
 */
export interface AgentProviderSession {
  /** Ficha para reanudar con `AgentOpenOptions.resume`; estable durante la vida de la sesión. */
  readonly providerSessionId: string
  /** Empieza un turno. Resuelve cuando el proveedor lo aceptó; el progreso llega por eventos. */
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  respond(response: AgentResponse): Promise<void>
  close(): Promise<void>
  onEvent(listener: (event: ProviderEvent) => void): Unsubscribe
}

/**
 * Proveedor de agente (Claude Code, Codex, Gemini/ACP, Antigravity, Ollama). El modelo normalizado no
 * depende de ninguno: cada adaptador traduce su protocolo a `ProviderEvent`.
 */
export interface AgentProviderPort {
  readonly id: string
  readonly displayName: string
  isAvailable(): Promise<boolean>
  /** Modelos, esfuerzos y modos que acepta (la interfaz arma los chips con esto). Puede consultar al proveedor. */
  capabilities(): Promise<ProviderCapabilities>
  /** Abre una sesión nueva o, con `resume`, reanuda una. Rechaza siempre con `AgentProviderError`. */
  open(options: AgentOpenOptions): Promise<AgentProviderSession>
  /** Opcional (`capabilities.warmup`): arranca el proceso antes del primer mensaje; es idempotente. */
  warmUp?(options: Pick<AgentOpenOptions, 'cwd'>): Promise<void>
}
