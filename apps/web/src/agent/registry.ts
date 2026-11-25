import type { AgentPaneModel } from './pane-model.ts'

/** Un `AgentPaneModel` por panel de agente: se crea al verlo por primera vez y se libera al cerrarse el panel. */
export class AgentRegistry {
  readonly #models = new Map<string, AgentPaneModel>()
  readonly #factory: (paneId: string) => AgentPaneModel

  constructor(factory: (paneId: string) => AgentPaneModel) {
    this.#factory = factory
  }

  ensure(paneId: string): AgentPaneModel {
    let m = this.#models.get(paneId)
    if (m === undefined) {
      m = this.#factory(paneId)
      this.#models.set(paneId, m)
    }
    return m
  }

  get(paneId: string): AgentPaneModel | undefined {
    return this.#models.get(paneId)
  }

  /** Libera los modelos de paneles que ya no existen. */
  prune(live: ReadonlySet<string>): void {
    for (const [id, m] of this.#models) {
      if (!live.has(id)) {
        m.dispose()
        this.#models.delete(id)
      }
    }
  }

  disposeAll(): void {
    for (const m of this.#models.values()) m.dispose()
    this.#models.clear()
  }
}
