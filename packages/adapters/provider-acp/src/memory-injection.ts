import { assertMemoryBlock, type MemoryDelivery, type MemoryInjectionPort } from '@nexo/core'

/**
 * ACP (Gemini y los agentes declarados): `session/new` no admite instrucciones, así que el bloque va como
 * primer bloque de contenido del primer `session/prompt`, antes del mensaje del usuario (ADR 0007). Si el agente
 * compacta, el servicio abre una sesión nueva sembrada.
 */
export class AcpMemoryInjection implements MemoryInjectionPort {
  readonly providerId: string
  readonly delivery: MemoryDelivery = 'context-block'
  readonly onCompact = 'reseed' as const

  constructor(providerId: string) {
    this.providerId = providerId
  }

  prepare(block: string): string {
    assertMemoryBlock(block)
    return block
  }
}
