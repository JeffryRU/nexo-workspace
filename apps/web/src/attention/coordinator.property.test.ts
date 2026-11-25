import type { Attention } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, it } from 'vitest'
import { DEFAULT_TIMING } from './coordinator.ts'
import { makeHarness } from './coordinator-harness.ts'

const ATTENTIONS: Attention[] = ['idle', 'working', 'needs-input', 'done', 'error']

type Step =
  | { kind: 'set'; pane: number; attention: Attention }
  | { kind: 'wait'; ms: number }
  | { kind: 'focus'; focused: boolean }
  | { kind: 'enable'; enabled: boolean }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('set' as const),
    pane: fc.integer({ min: 0, max: 3 }),
    attention: fc.constantFrom(...ATTENTIONS),
  }),
  fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 30_000 }) }),
  fc.record({ kind: fc.constant('focus' as const), focused: fc.boolean() }),
  fc.record({ kind: fc.constant('enable' as const), enabled: fc.boolean() }),
)

describe('NotificationCoordinator (propiedades)', () => {
  it('nunca avisa con foco, desactivado, dos veces por panel dentro de la espera, ni más rápido que la espera global', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 80 }), (steps) => {
        const h = makeHarness()
        const states: Attention[] = ['idle', 'idle', 'idle', 'idle']
        const sentAt: number[] = []
        const lastByTag = new Map<string, number>()
        const origNotify = h.notifier.notify.bind(h.notifier)
        h.notifier.notify = (content, onClick) => {
          // Lo que ve el sistema: la ventana sigue sin foco y el ajuste sigue activo.
          if (h.state.focused || !h.state.enabled)
            throw new Error('avisó sin permiso de la interfaz')
          const now = h.now()
          sentAt.push(now)
          if (content.tag.startsWith('nexo-pane-')) {
            const last = lastByTag.get(content.tag)
            if (last !== undefined && now - last < DEFAULT_TIMING.paneCooldownMs) {
              throw new Error('dos avisos del mismo panel dentro de la espera')
            }
            lastByTag.set(content.tag, now)
          }
          origNotify(content, onClick)
        }
        const observe = () => h.coordinator.observe(states.map((a, i) => h.pane(`p${i}`, a)))
        observe()
        for (const s of steps) {
          if (s.kind === 'set') {
            states[s.pane] = s.attention
            observe()
          } else if (s.kind === 'wait') h.advance(s.ms)
          else if (s.kind === 'focus') {
            h.state.focused = s.focused
            h.coordinator.focusChanged(s.focused)
          } else h.state.enabled = s.enabled
        }
        h.advance(60_000)
        for (let i = 1; i < sentAt.length; i++) {
          const gap = (sentAt[i] as number) - (sentAt[i - 1] as number)
          if (gap < DEFAULT_TIMING.globalGapMs) throw new Error(`avisos a ${gap} ms`)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('la primera foto nunca produce avisos, sea cual sea el estado', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ATTENTIONS), { maxLength: 20 }), (all) => {
        const h = makeHarness()
        h.coordinator.observe(all.map((a, i) => h.pane(`p${i}`, a)))
        h.advance(120_000)
        return h.notifier.sent.length === 0
      }),
    )
  })
})
