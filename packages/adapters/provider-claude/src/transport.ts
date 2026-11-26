/**
 * Costura entre el adaptador y el SDK de Claude. El adaptador solo conoce esta interfaz pequeña; la
 * implementación real (`sdk-transport.ts`) envuelve `@anthropic-ai/claude-agent-sdk` y las pruebas usan un
 * transporte falso. Los mensajes del SDK cruzan como `unknown`: la traducción los valida.
 */

/** Modo de permisos tal como lo entiende Claude Code. */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export type PermissionAsk = {
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  title?: string
  displayName?: string
  description?: string
  blockedPath?: string
  /** Reglas sugeridas para «permitir siempre»; se devuelven tal cual en `updatedPermissions`. */
  suggestions?: readonly unknown[]
  signal: AbortSignal
}

export type PermissionDecision =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: readonly unknown[]
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

export type TransportStartOptions = {
  cwd: string
  model?: string
  effort?: string
  permissionMode: ClaudePermissionMode
  /** Reanuda esa sesión del SDK. */
  resume?: string
  /** Bloque de memoria ya preparado: va en el prompt de sistema y se reinyecta al compactar. */
  memory?: string
  canUseTool: (ask: PermissionAsk) => Promise<PermissionDecision>
  /** Salida de error del proceso; quien la reciba debe redactarla. */
  onStderr?: (data: string) => void
}

export interface ClaudeTransportSession {
  /** Id de sesión del SDK (el de `resume` o uno nuevo fijado al arrancar). */
  readonly sessionId: string
  /** Mensajes del SDK en orden. Termina (o lanza) si el proceso muere. */
  readonly messages: AsyncIterable<unknown>
  /** Añade un mensaje de usuario a la entrada en streaming. */
  send(text: string): void
  /** Pide al SDK que interrumpa el turno en curso. */
  interrupt(): Promise<void>
  /** Cierra la entrada y termina el proceso. Idempotente. */
  close(): void
}

export type TransportModel = { id: string; label?: string; efforts?: string[] }

export type TransportErrorCode =
  /** El SDK o su ejecutable no están disponibles. */
  | 'UNAVAILABLE'
  /** `resume` apunta a una sesión que no existe. */
  | 'UNKNOWN_SESSION'

export class TransportError extends Error {
  readonly code: TransportErrorCode
  constructor(code: TransportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TransportError'
    this.code = code
  }
}

export interface ClaudeTransport {
  /** SDK y ejecutable presentes, sin llamadas de red. */
  isAvailable(): Promise<boolean>
  start(options: TransportStartOptions): Promise<ClaudeTransportSession>
  /** Opcional: arranca un proceso en `cwd` para que el siguiente `start` lo reutilice. */
  warmUp?(options: { cwd: string }): Promise<void>
  /** Opcional: modelos que expone el SDK (puede arrancar un proceso). */
  listModels?(options: { cwd: string }): Promise<TransportModel[]>
}
