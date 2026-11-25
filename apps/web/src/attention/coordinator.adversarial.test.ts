import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMING } from './coordinator.ts'
import { makeHarness } from './coordinator-harness.ts'

describe('NotificationCoordinator (adversarial)', () => {
  it('etiquetas hostiles (HTML, controles, enormes) salen limpias y acotadas', () => {
    const h = makeHarness()
    const evil = `<img src=x onerror=alert(1)>\u0000\u001b[31m\n${'A'.repeat(100_000)}`
    h.coordinator.observe([h.pane('p1', 'working', evil)])
    h.coordinator.observe([h.pane('p1', 'done', evil)])
    h.advance(DEFAULT_TIMING.coalesceMs)
    const body = h.notifier.sent[0]?.body ?? ''
    expect(body.length).toBeLessThanOrEqual(100)
    expect(body).not.toMatch(/\p{Cc}/u)
  })

  it('mil paneles que cambian a la vez dan una sola notificación', () => {
    const h = makeHarness()
    const ids = Array.from({ length: 1000 }, (_, i) => `p${i}`)
    h.coordinator.observe(ids.map((id) => h.pane(id, 'working')))
    h.coordinator.observe(ids.map((id) => h.pane(id, 'needs-input')))
    h.advance(DEFAULT_TIMING.coalesceMs)
    expect(h.notifier.sent).toHaveLength(1)
    expect(h.notifier.sent[0]?.title).toBe('1000 paneles necesitan atención')
    expect(h.notifier.sent[0]?.body.length).toBeLessThanOrEqual(3 * 40 + 6)
  })

  it('ráfagas de cambios con el reloj quieto no crean temporizadores sin límite', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'working')])
    for (let i = 0; i < 5000; i++) {
      h.coordinator.observe([h.pane('p1', i % 2 === 0 ? 'needs-input' : 'working')])
    }
    expect(h.pendingTimers()).toBeLessThanOrEqual(1)
  })

  it('observar y cambiar el foco después de dispose no hace nada ni lanza', () => {
    const h = makeHarness()
    h.coordinator.dispose()
    expect(() => {
      h.coordinator.observe([h.pane('p1', 'done')])
      h.coordinator.focusChanged(true)
      h.coordinator.dispose()
    }).not.toThrow()
  })

  it('un notificador sin permiso no rompe el flujo', () => {
    const h = makeHarness()
    h.notifier.current = 'denied'
    h.coordinator.observe([h.pane('p1', 'working')])
    h.coordinator.observe([h.pane('p1', 'done')])
    expect(() => h.advance(60_000)).not.toThrow()
    expect(h.notifier.sent).toHaveLength(0)
  })

  it('un panel que desaparece mientras espera no se notifica', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'working')])
    h.coordinator.observe([h.pane('p1', 'done')])
    h.coordinator.observe([])
    h.advance(60_000)
    expect(h.notifier.sent).toHaveLength(0)
  })
})
