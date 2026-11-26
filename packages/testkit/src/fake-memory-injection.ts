import { assertMemoryBlock, type MemoryDelivery, type MemoryInjectionPort } from '@nexo/core'

/** Inyección de memoria falsa: valida el bloque y lo devuelve tal cual (entrega configurable). */
export class FakeMemoryInjection implements MemoryInjectionPort {
  readonly providerId: string
  readonly delivery: MemoryDelivery
  readonly onCompact: 'reinject' | 'reseed'
  /** Bloques que se prepararon, en orden. */
  readonly prepared: string[] = []

  constructor(
    providerId = 'fake',
    delivery: MemoryDelivery = 'system-prompt',
    onCompact: 'reinject' | 'reseed' = 'reseed',
  ) {
    this.providerId = providerId
    this.delivery = delivery
    this.onCompact = onCompact
  }

  prepare(block: string): string {
    assertMemoryBlock(block)
    this.prepared.push(block)
    return block
  }
}
