import { assertMemoryBlock, type MemoryDelivery, type MemoryInjectionPort } from '@nexo/core'

/**
 * Ollama (`/api/chat`): el bloque es el mensaje de sistema (`role: "system"`) al comienzo de cada petición; vive
 * fuera del historial, así que el tope de historial nunca lo descarta. Ollama no compacta por su cuenta: cuando el
 * contexto crece, la renovación de sesión abre una conversación nueva sembrada (ADR 0007).
 */
export class OllamaMemoryInjection implements MemoryInjectionPort {
  readonly providerId = 'ollama'
  readonly delivery: MemoryDelivery = 'system-message'
  readonly onCompact = 'reseed' as const

  prepare(block: string): string {
    assertMemoryBlock(block)
    return block
  }
}
