import { assertMemoryBlock, type MemoryDelivery, type MemoryInjectionPort } from '@nexo/core'

/**
 * Codex (`app-server`): el bloque va en `developerInstructions` de `thread/start` (instrucciones de
 * desarrollador del hilo, que se suman a las base sin reemplazarlas; comprobado con el esquema de
 * `codex app-server generate-json-schema`, codex-cli 0.158). Cuando Codex compacta, el hilo conserva sus
 * instrucciones; si hace falta, el servicio abre un hilo nuevo sembrado (renovación).
 */
export class CodexMemoryInjection implements MemoryInjectionPort {
  readonly providerId = 'codex'
  readonly delivery: MemoryDelivery = 'thread-instructions'
  readonly onCompact = 'reseed' as const

  prepare(block: string): string {
    assertMemoryBlock(block)
    return block
  }
}
