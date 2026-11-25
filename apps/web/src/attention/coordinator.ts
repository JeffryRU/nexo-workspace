import type { Attention } from '@nexo/contracts'
import { es, format } from '../i18n/es.ts'
import type { Notifier } from './notifier.ts'

/** Estados que merecen avisar al usuario cuando la ventana no tiene foco. */
export const NOTIFY_ATTENTIONS: readonly Attention[] = ['needs-input', 'error', 'done']

/** Más urgente primero: a qué panel lleva una notificación agrupada. */
const URGENCY: Record<string, number> = { 'needs-input': 0, error: 1, done: 2 }

export type PaneSignal = { paneId: string; attention: Attention; label: string }

export type CoordinatorTiming = {
  /** Espera para agrupar los cambios que llegan casi a la vez en una sola notificación. */
  coalesceMs: number
  /** Mínimo entre dos notificaciones del mismo panel (un agente que alterna estados no hace spam). */
  paneCooldownMs: number
  /** Mínimo entre dos notificaciones cualesquiera. */
  globalGapMs: number
  /** Tras una notificación, si la ventana recupera el foco en este plazo se salta al panel (sin clic nativo). */
  focusJumpMs: number
}

export const DEFAULT_TIMING: CoordinatorTiming = {
  coalesceMs: 1500,
  paneCooldownMs: 20_000,
  globalGapMs: 5000,
  focusJumpMs: 20_000,
}

export type CoordinatorDeps = {
  notifier: Notifier
  enabled: () => boolean
  windowFocused: () => boolean
  reveal: (paneId: string) => void
  now: () => number
  setTimer: (cb: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  timing?: Partial<CoordinatorTiming>
}

/** Texto apto para una notificación: sin controles ni saltos y de tamaño acotado. */
export function clip(text: string, max = 100): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim()
    .slice(0, max)
}

type Candidate = { paneId: string; attention: Attention; label: string }

/**
 * Decide cuándo notificar. Recibe la foto de los paneles cada vez que cambia (`observe`) y detecta los pasos
 * a `needs-input`, `error` o `done`. La primera vez que ve un panel solo lo anota (no avisa de lo que ya
 * estaba). Solo avisa con la ventana sin foco y el ajuste activado; agrupa lo que llega junto, respeta una
 * espera por panel y otra global, y descarta lo que dejó de ser cierto o la ventana recuperó el foco antes de
 * enviar.
 */
export class NotificationCoordinator {
  readonly #deps: CoordinatorDeps
  readonly #timing: CoordinatorTiming
  readonly #last = new Map<string, Attention>()
  readonly #current = new Map<string, PaneSignal>()
  readonly #queue = new Map<string, Candidate>()
  readonly #lastNotified = new Map<string, number>()
  #timer: unknown
  #lastFlush = Number.NEGATIVE_INFINITY
  #lastNotice: { paneId: string; at: number } | undefined
  #disposed = false

  constructor(deps: CoordinatorDeps) {
    this.#deps = deps
    this.#timing = { ...DEFAULT_TIMING, ...deps.timing }
  }

  observe(panes: readonly PaneSignal[]): void {
    if (this.#disposed) return
    const alive = new Set<string>()
    for (const p of panes) {
      alive.add(p.paneId)
      this.#current.set(p.paneId, p)
      const before = this.#last.get(p.paneId)
      this.#last.set(p.paneId, p.attention)
      if (before === undefined || before === p.attention) continue
      if (NOTIFY_ATTENTIONS.includes(p.attention)) this.#enqueue(p)
    }
    for (const id of [...this.#last.keys()]) {
      if (alive.has(id)) continue
      this.#last.delete(id)
      this.#current.delete(id)
      this.#queue.delete(id)
      this.#lastNotified.delete(id)
    }
  }

  /** La ventana ganó o perdió el foco. Al ganarlo se cancela lo pendiente y, sin clic nativo, se salta al panel. */
  focusChanged(focused: boolean): void {
    if (this.#disposed || !focused) return
    this.#cancelPending()
    const notice = this.#lastNotice
    this.#lastNotice = undefined
    if (
      notice !== undefined &&
      !this.#deps.notifier.supportsClick &&
      this.#deps.now() - notice.at <= this.#timing.focusJumpMs
    ) {
      this.#deps.reveal(notice.paneId)
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#cancelPending()
  }

  #cancelPending(): void {
    this.#queue.clear()
    if (this.#timer !== undefined) this.#deps.clearTimer(this.#timer)
    this.#timer = undefined
  }

  #enqueue(p: PaneSignal): void {
    if (!this.#deps.enabled() || this.#deps.windowFocused()) return
    const now = this.#deps.now()
    const lastAt = this.#lastNotified.get(p.paneId)
    if (lastAt !== undefined && now - lastAt < this.#timing.paneCooldownMs) return
    this.#queue.set(p.paneId, { paneId: p.paneId, attention: p.attention, label: p.label })
    if (this.#timer !== undefined) return
    const wait = Math.max(this.#timing.coalesceMs, this.#lastFlush + this.#timing.globalGapMs - now)
    this.#timer = this.#deps.setTimer(() => this.#flush(), wait)
  }

  #flush(): void {
    this.#timer = undefined
    const queued = [...this.#queue.values()]
    this.#queue.clear()
    if (this.#disposed || !this.#deps.enabled() || this.#deps.windowFocused()) return
    // Lo que ya no es cierto (se respondió, se enfocó, se cerró) no se avisa.
    const items = queued.filter((c) => this.#current.get(c.paneId)?.attention === c.attention)
    if (items.length === 0) return
    items.sort((a, b) => (URGENCY[a.attention] ?? 9) - (URGENCY[b.attention] ?? 9))
    const first = items[0] as Candidate
    const now = this.#deps.now()
    this.#lastFlush = now
    for (const c of items) this.#lastNotified.set(c.paneId, now)
    this.#lastNotice = { paneId: first.paneId, at: now }
    const content =
      items.length === 1
        ? {
            title: es.notifications.title[first.attention as 'needs-input' | 'error' | 'done'],
            body: clip(first.label),
            tag: `nexo-pane-${first.paneId}`,
          }
        : {
            title: format(es.notifications.group, { count: items.length }),
            body: items
              .slice(0, 3)
              .map((c) => clip(c.label, 40))
              .join(' · '),
            tag: 'nexo-group',
          }
    this.#deps.notifier.notify(content, () => this.#deps.reveal(first.paneId))
  }
}
