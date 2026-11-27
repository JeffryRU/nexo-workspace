import type { CompanionState } from '@nexo/contracts'
import { COMPANION_PRIORITY } from './companion-rules.ts'
import type { ClockPort } from './ports/misc.ts'

export type CompanionTiming = {
  /** Tiempo mínimo que un estado se muestra antes de que lo reemplace otro de igual o menor prioridad. */
  minShowMs: Readonly<Record<CompanionState, number>>
  /** `done` es una celebración: tras este tiempo la mascota vuelve a `idle` aunque la atención siga en «terminado». */
  doneHoldMs: number
}

export const DEFAULT_COMPANION_TIMING: CompanionTiming = {
  minShowMs: { idle: 0, done: 2500, thinking: 1000, busy: 1000, error: 2500, waiting: 2000 },
  doneHoldMs: 6000,
}

export type CompanionStateMachineOptions = {
  clock: ClockPort
  timing?: CompanionTiming
  onChange: (state: CompanionState, since: number) => void
}

/**
 * Máquina de estados de la mascota (F5.2). Recibe el estado «objetivo» que dicen los agentes y decide qué muestra:
 * un estado de mayor prioridad se muestra enseguida; uno de igual o menor prioridad espera a que el actual haya
 * estado visible su tiempo mínimo (así no parpadea). Todo el tiempo sale del reloj inyectado.
 */
export class CompanionStateMachine {
  readonly #clock: ClockPort
  readonly #timing: CompanionTiming
  readonly #onChange: CompanionStateMachineOptions['onChange']
  #state: CompanionState = 'idle'
  #since: number
  #target: CompanionState = 'idle'
  /** `done` ya se celebró: el objetivo `done` cuenta como `idle` hasta que cambie o llegue otro «terminado». */
  #decayed = false
  #pending: (() => void) | undefined
  #decay: (() => void) | undefined
  #disposed = false

  constructor(options: CompanionStateMachineOptions) {
    this.#clock = options.clock
    this.#timing = options.timing ?? DEFAULT_COMPANION_TIMING
    this.#onChange = options.onChange
    this.#since = options.clock.now()
  }

  get state(): CompanionState {
    return this.#state
  }

  get since(): number {
    return this.#since
  }

  /** `fresh`: una sesión acaba de terminar, aunque el objetivo siga siendo `done` (se vuelve a celebrar). */
  setTarget(target: CompanionState, fresh = false): void {
    if (this.#disposed) return
    if (target !== this.#target) this.#decayed = false
    this.#target = target
    if (fresh && target === 'done') {
      this.#decayed = false
      if (this.#state === 'done') this.#armDecay()
    }
    this.#evaluate()
  }

  dispose(): void {
    this.#disposed = true
    this.#pending?.()
    this.#decay?.()
    this.#pending = undefined
    this.#decay = undefined
  }

  #effective(): CompanionState {
    return this.#target === 'done' && this.#decayed ? 'idle' : this.#target
  }

  #evaluate(): void {
    this.#pending?.()
    this.#pending = undefined
    const next = this.#effective()
    if (next === this.#state) return
    if (COMPANION_PRIORITY[next] > COMPANION_PRIORITY[this.#state]) {
      this.#switchTo(next)
      return
    }
    const wait = this.#since + this.#timing.minShowMs[this.#state] - this.#clock.now()
    if (wait <= 0) {
      this.#switchTo(next)
      return
    }
    this.#pending = this.#clock.setTimeout(() => {
      this.#pending = undefined
      if (!this.#disposed) this.#evaluate()
    }, wait)
  }

  #switchTo(next: CompanionState): void {
    this.#decay?.()
    this.#decay = undefined
    this.#state = next
    this.#since = this.#clock.now()
    if (next === 'done') this.#armDecay()
    this.#onChange(next, this.#since)
  }

  #armDecay(): void {
    this.#decay?.()
    const hold = Math.max(this.#timing.doneHoldMs, this.#timing.minShowMs.done)
    this.#decay = this.#clock.setTimeout(() => {
      this.#decay = undefined
      if (this.#disposed) return
      this.#decayed = true
      this.#evaluate()
    }, hold)
  }
}
