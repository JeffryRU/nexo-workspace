import type { BusEvent, EventBusPort, Unsubscribe } from '@nexo/core'

/** Bus en memoria. Un suscriptor que lanza no afecta a los demás ni a quien publica. */
export class MemoryEventBus implements EventBusPort {
  readonly #listeners = new Set<(event: BusEvent) => void>()
  readonly #onError: (error: unknown) => void

  constructor(onError: (error: unknown) => void = () => {}) {
    this.#onError = onError
  }

  get size(): number {
    return this.#listeners.size
  }

  publish(event: BusEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#onError(error)
      }
    }
  }

  subscribe(listener: (event: BusEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
