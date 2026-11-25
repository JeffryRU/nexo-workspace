import type { Attention } from '@nexo/contracts'
import { NotificationCoordinator, type PaneSignal } from './coordinator.ts'
import { FakeNotifier } from './fake-notifier.ts'

/** Reloj y temporizadores manuales para probar el coordinador sin esperas reales. */
export function makeHarness(
  options: {
    supportsClick?: boolean
    timing?: ConstructorParameters<typeof NotificationCoordinator>[0]['timing']
  } = {},
) {
  let now = 1_000_000
  let nextId = 1
  const timers = new Map<number, { at: number; cb: () => void }>()
  const notifier = new FakeNotifier({ supportsClick: options.supportsClick ?? true })
  const state = { enabled: true, focused: false }
  const revealed: string[] = []
  const coordinator = new NotificationCoordinator({
    notifier,
    enabled: () => state.enabled,
    windowFocused: () => state.focused,
    reveal: (id) => revealed.push(id),
    now: () => now,
    setTimer: (cb, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, cb })
      return id
    },
    clearTimer: (h) => void timers.delete(h as number),
    ...(options.timing === undefined ? {} : { timing: options.timing }),
  })
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      timers.delete(due[0])
      now = Math.max(now, due[1].at)
      due[1].cb()
    }
    now = end
  }
  const pane = (paneId: string, attention: Attention, label = `Panel ${paneId}`): PaneSignal => ({
    paneId,
    attention,
    label,
  })
  return {
    coordinator,
    notifier,
    state,
    revealed,
    advance,
    pane,
    now: () => now,
    pendingTimers: () => timers.size,
  }
}
