import type { LinkEvent } from './link.ts'
import { canonicalUri, invalidationFor } from './views.ts'

export type NotifierOptions = {
  /** Envía `notifications/resources/updated` de una URI. */
  sendUpdated: (uri: string) => Promise<void>
  /** Envía `notifications/resources/list_changed`. */
  sendListChanged: () => Promise<void>
  logger: (message: string) => void
  /** Los cambios se juntan este tiempo antes de avisar: una avalancha de eventos es un solo aviso por URI. */
  flushMs?: number
  /** Tope de suscripciones a la vez. */
  maxSubscriptions?: number
}

const MAX_KNOWN_AGENTS = 1024

/**
 * Traduce eventos del daemon en avisos de cambio de recursos MCP, solo para las URIs suscritas y con los
 * cambios coalescidos. No guarda el contenido: el cliente vuelve a leer el recurso.
 */
export class ChangeNotifier {
  readonly #options: NotifierOptions
  readonly #subscribed = new Set<string>()
  readonly #dirty = new Set<string>()
  readonly #knownAgents = new Set<string>()
  #listChanged = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(options: NotifierOptions) {
    this.#options = options
  }

  get subscriptionCount(): number {
    return this.#subscribed.size
  }

  /** `false` si se pasó el tope o la URI no es válida. */
  subscribe(uri: string): boolean {
    const canonical = canonicalUri(uri)
    if (canonical === undefined) return false
    if (
      !this.#subscribed.has(canonical) &&
      this.#subscribed.size >= (this.#options.maxSubscriptions ?? 64)
    ) {
      return false
    }
    this.#subscribed.add(canonical)
    return true
  }

  unsubscribe(uri: string): void {
    const canonical = canonicalUri(uri)
    if (canonical !== undefined) {
      this.#subscribed.delete(canonical)
      this.#dirty.delete(canonical)
    }
  }

  rememberAgents(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.#knownAgents.size >= MAX_KNOWN_AGENTS) this.#knownAgents.clear()
      this.#knownAgents.add(id)
    }
  }

  /** Cuando se (re)conecta con el daemon todo lo suscrito pudo cambiar mientras tanto. */
  markAllSubscribed(): void {
    for (const uri of this.#subscribed) this.#dirty.add(uri)
    this.#schedule()
  }

  handle(event: LinkEvent): void {
    if (this.#disposed) return
    const inv = invalidationFor(event, this.#knownAgents)
    if (event.name === 'agent.session') {
      if ('removed' in event.data) this.#knownAgents.delete(event.data.sessionId)
      else this.rememberAgents([event.data.session.id])
    }
    if (event.name === 'resync') {
      this.#knownAgents.clear()
      for (const uri of this.#subscribed) this.#dirty.add(uri)
    }
    for (const uri of inv.uris) {
      const canonical = canonicalUri(uri)
      if (canonical !== undefined && this.#subscribed.has(canonical)) this.#dirty.add(canonical)
    }
    if (inv.listChanged) this.#listChanged = true
    if (this.#dirty.size > 0 || this.#listChanged) this.#schedule()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#dirty.clear()
    this.#subscribed.clear()
  }

  #schedule(): void {
    if (this.#timer !== undefined || this.#disposed) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#flush()
    }, this.#options.flushMs ?? 200)
    this.#timer.unref?.()
  }

  async #flush(): Promise<void> {
    const uris = [...this.#dirty]
    this.#dirty.clear()
    const listChanged = this.#listChanged
    this.#listChanged = false
    for (const uri of uris) {
      try {
        await this.#options.sendUpdated(uri)
      } catch (error) {
        this.#options.logger(`no se pudo avisar el cambio de un recurso: ${describe(error)}`)
      }
    }
    if (listChanged) {
      try {
        await this.#options.sendListChanged()
      } catch (error) {
        this.#options.logger(`no se pudo avisar el cambio de la lista: ${describe(error)}`)
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : '?'
}
