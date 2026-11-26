/** Cómo recibe un proveedor el bloque de memoria al abrir una sesión (ADR 0007, punto 4). */
export type MemoryDelivery =
  /** Claude Code: `systemPrompt.append` (y el hook `SessionStart` de origen `compact`). */
  | 'system-prompt'
  /** Codex: instrucciones del hilo (`developerInstructions` de `thread/start`). */
  | 'thread-instructions'
  /** ACP/Gemini: primer bloque de contenido del primer `session/prompt`. */
  | 'context-block'
  /** Antigravity: prefijo del primer mensaje. */
  | 'first-message-prefix'
  /** Ollama: mensaje de sistema al comienzo de la conversación. */
  | 'system-message'

export type MemoryInjectionErrorCode =
  /** El texto no es un bloque `<nexo-memory>` bien formado (una apertura, un cierre, sin etiquetas dentro). */
  | 'INVALID_BLOCK'
  /** El bloque pasa del tope de tamaño. */
  | 'TOO_LARGE'

export class MemoryInjectionError extends Error {
  readonly code: MemoryInjectionErrorCode

  constructor(code: MemoryInjectionErrorCode, message: string) {
    super(message)
    this.name = 'MemoryInjectionError'
    this.code = code
  }
}

/**
 * Cómo un proveedor recibe la memoria. El daemon arma el bloque (`buildMemoryBlock`); el puerto lo valida y lo
 * deja listo para el mecanismo nativo del proveedor, y el adaptador lo entrega en `AgentOpenOptions.memory`.
 * Contrato (lo comprueba la suite de conformidad):
 * - `prepare` acepta solo un bloque bien formado y rechaza con `MemoryInjectionError` (`INVALID_BLOCK`,
 *   `TOO_LARGE`); nunca lanza otro tipo de error.
 * - El resultado contiene el bloque tal cual (sin tocar su interior) y nada más que un envoltorio fijo fuera
 *   de las etiquetas: ningún texto observado puede salir del bloque.
 * - Es puro y determinista: no muta la entrada ni depende del estado.
 */
export interface MemoryInjectionPort {
  readonly providerId: string
  readonly delivery: MemoryDelivery
  /** Qué hace el proveedor cuando su CLI compacta el contexto por su cuenta. */
  readonly onCompact: 'reinject' | 'reseed'
  prepare(block: string): string
}
