import {
  type AgentSessionId,
  applyBlockDelta,
  type Block,
  type BlockId,
  type EventData,
} from '@nexo/contracts'
import type { BusEvent, EventBusPort, Unsubscribe } from '@nexo/core'

/**
 * Cliente simulado: reconstruye el documento de una sesión solo con los eventos `agent.block` (upsert por
 * `id`) y `agent.delta` (`applyBlockDelta`), como lo hará la interfaz. Sirve para comprobar que lo que se
 * emite reproduce el `agent.snapshot` del servidor.
 */
export class AgentMirror {
  readonly #byId = new Map<BlockId, Block>()
  readonly #off: Unsubscribe
  /** Deltas que habrían obligado a pedir `agent.snapshot` (hueco, bloque desconocido o inválido). */
  resyncs = 0
  deltas = 0

  constructor(bus: EventBusPort, sessionId: AgentSessionId) {
    this.#off = bus.subscribe((event) => this.#apply(event, sessionId))
  }

  #apply(event: BusEvent, sessionId: AgentSessionId): void {
    if (event.event === 'agent.block') {
      const data: EventData<'agent.block'> = event.data
      if (data.sessionId === sessionId) this.#byId.set(data.block.id, data.block)
    } else if (event.event === 'agent.delta') {
      const data: EventData<'agent.delta'> = event.data
      if (data.sessionId !== sessionId) return
      this.deltas++
      const block = this.#byId.get(data.blockId)
      if (block === undefined) {
        this.resyncs++
        return
      }
      const outcome = applyBlockDelta(block, data)
      if (outcome.status === 'applied') this.#byId.set(block.id, outcome.block)
      else if (outcome.status !== 'duplicate') this.resyncs++
    }
  }

  /** Documento reconstruido, ordenado por `index`. */
  blocks(): Block[] {
    return [...this.#byId.values()].sort((a, b) => a.index - b.index)
  }

  dispose(): void {
    this.#off()
  }
}
