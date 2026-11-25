import type { ClockPort, Unsubscribe } from '@nexo/core'

/** Reloj real. Los temporizadores no mantienen vivo el proceso. */
export class SystemClock implements ClockPort {
  now(): number {
    return Date.now()
  }

  setTimeout(callback: () => void, ms: number): Unsubscribe {
    const timer = setTimeout(callback, Math.max(0, ms))
    timer.unref()
    return () => clearTimeout(timer)
  }
}
