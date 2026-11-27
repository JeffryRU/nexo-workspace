import type {
  Attention,
  CompanionId,
  CompanionStateView,
  MethodParams,
  MethodResult,
} from '@nexo/contracts'
import { base64Encode, companionTarget } from './companion-rules.ts'
import { CompanionStateMachine, type CompanionTiming } from './companion-state.ts'
import { DomainError } from './errors.ts'
import {
  CompanionError,
  type CompanionPort,
  type CompanionSelectionStore,
} from './ports/companion.ts'
import type { BusEvent, ClockPort, EventBusPort, LoggerPort } from './ports/misc.ts'
import type { Unsubscribe } from './ports/pty.ts'

export type CompanionServiceDeps = {
  port: CompanionPort
  store: CompanionSelectionStore
  bus: EventBusPort
  clock: ClockPort
  logger?: LoggerPort
  timing?: CompanionTiming
}

function toDomain(error: unknown): DomainError {
  if (error instanceof DomainError) return error
  if (error instanceof CompanionError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return new DomainError('NOT_FOUND', error.message)
      case 'INVALID':
        return new DomainError('INVALID_PARAMS', error.message)
      case 'TOO_LARGE':
        return new DomainError('PAYLOAD_TOO_LARGE', error.message)
      default:
        return new DomainError('INTERNAL', error.message)
    }
  }
  return new DomainError('INTERNAL', 'no se pudo leer el compañero')
}

/**
 * Casos de uso `companion.*` (F5.2). Traduce la atención de los agentes (`agent.status`/`agent.session`) a un estado
 * de mascota con `CompanionStateMachine`, guarda el compañero elegido («sin mascota» por omisión) y sirve los
 * paquetes. Los `select` se serializan: gana el último y lo guardado coincide siempre con lo mostrado.
 */
export class CompanionService {
  readonly #deps: CompanionServiceDeps
  readonly #machine: CompanionStateMachine
  readonly #sessions = new Map<string, Attention>()
  readonly #off: Unsubscribe
  readonly #ready: Promise<void>
  #selected: CompanionId | null = null
  #chain: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(deps: CompanionServiceDeps) {
    this.#deps = deps
    this.#machine = new CompanionStateMachine({
      clock: deps.clock,
      ...(deps.timing === undefined ? {} : { timing: deps.timing }),
      onChange: () => this.#publish(),
    })
    this.#off = deps.bus.subscribe((event) => this.#onEvent(event))
    this.#ready = this.#load()
  }

  readonly handlers = {
    'companion.list': () => this.list(),
    'companion.get': (p: MethodParams<'companion.get'>) => this.get(p),
    'companion.select': (p: MethodParams<'companion.select'>) => this.select(p),
    'companion.asset': (p: MethodParams<'companion.asset'>) => this.asset(p),
    'companion.state': () => this.state(),
  }

  close(): void {
    this.#closed = true
    this.#off()
    this.#machine.dispose()
  }

  async list(): Promise<MethodResult<'companion.list'>> {
    await this.#ready
    try {
      const { companions, invalid } = await this.#deps.port.list()
      return { companions, invalid, selected: this.#selected }
    } catch (error) {
      throw toDomain(error)
    }
  }

  async get(params: MethodParams<'companion.get'>): Promise<MethodResult<'companion.get'>> {
    try {
      return { companion: await this.#deps.port.get(params.id) }
    } catch (error) {
      throw toDomain(error)
    }
  }

  async asset(params: MethodParams<'companion.asset'>): Promise<MethodResult<'companion.asset'>> {
    try {
      const { mime, bytes } = await this.#deps.port.readAsset(params.id, params.path)
      return { mime, bytes: bytes.length, data: base64Encode(bytes) }
    } catch (error) {
      throw toDomain(error)
    }
  }

  async state(): Promise<MethodResult<'companion.state'>> {
    await this.#ready
    return this.#view()
  }

  select(params: MethodParams<'companion.select'>): Promise<MethodResult<'companion.select'>> {
    const run = async (): Promise<MethodResult<'companion.select'>> => {
      await this.#ready
      if (this.#closed) {
        throw new DomainError('PROVIDER_UNAVAILABLE', 'los compañeros están cerrados')
      }
      try {
        // Un paquete que ya no es válido no se puede elegir.
        if (params.id !== null) await this.#deps.port.get(params.id)
        await this.#deps.store.save(params.id)
      } catch (error) {
        throw toDomain(error)
      }
      const changed = this.#selected !== params.id
      this.#selected = params.id
      if (changed) this.#publish()
      return { selected: this.#selected }
    }
    const result = this.#chain.then(run, run)
    this.#chain = result.catch(() => {})
    return result
  }

  // ---- estado ----

  #view(): CompanionStateView {
    return { state: this.#machine.state, since: this.#machine.since, selected: this.#selected }
  }

  #publish(): void {
    if (this.#closed) return
    this.#deps.bus.publish({ event: 'companion.state', data: this.#view() })
  }

  async #load(): Promise<void> {
    try {
      const stored = await this.#deps.store.load()
      if (stored === null) return
      await this.#deps.port.get(stored)
      this.#selected = stored
    } catch (error) {
      // Un compañero guardado que ya no existe o no es válido deja la mascota en «ninguna»; el archivo no se toca.
      this.#deps.logger?.warn('no se pudo cargar el compañero elegido', {
        error: error instanceof Error ? error.message.slice(0, 200) : 'desconocido',
      })
    }
  }

  #onEvent(event: BusEvent): void {
    if (this.#closed) return
    let fresh = false
    if (event.event === 'agent.status') {
      const before = this.#sessions.get(event.data.sessionId)
      this.#sessions.set(event.data.sessionId, event.data.status)
      fresh = event.data.status === 'done' && before !== 'done'
    } else if (event.event === 'agent.session') {
      if (!('removed' in event.data)) return
      this.#sessions.delete(event.data.sessionId)
    } else return
    this.#machine.setTarget(companionTarget(this.#sessions.values()), fresh)
  }
}

export type CompanionHandlers = CompanionService['handlers']
