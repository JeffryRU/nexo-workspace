import { describe, expect, it } from 'vitest'
import { clip, DEFAULT_TIMING } from './coordinator.ts'
import { makeHarness } from './coordinator-harness.ts'

describe('NotificationCoordinator', () => {
  it('la primera vez que ve un panel solo lo anota: no avisa de lo que ya estaba', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'needs-input')])
    h.advance(60_000)
    expect(h.notifier.sent).toHaveLength(0)
  })

  it('avisa del paso a needs-input, done y error con la ventana sin foco', () => {
    for (const [attention, title] of [
      ['needs-input', 'Necesita tu respuesta'],
      ['done', 'Terminado'],
      ['error', 'Con error'],
    ] as const) {
      const h = makeHarness()
      h.coordinator.observe([h.pane('p1', 'idle', 'Espacio 1 · Agente')])
      h.coordinator.observe([h.pane('p1', 'working', 'Espacio 1 · Agente')])
      h.coordinator.observe([h.pane('p1', attention, 'Espacio 1 · Agente')])
      expect(h.notifier.sent).toHaveLength(0)
      h.advance(DEFAULT_TIMING.coalesceMs)
      expect(h.notifier.sent).toHaveLength(1)
      expect(h.notifier.sent[0]).toMatchObject({
        title,
        body: 'Espacio 1 · Agente',
        tag: 'nexo-pane-p1',
      })
    }
  })

  it('no avisa de working ni de idle', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'idle')])
    h.coordinator.observe([h.pane('p1', 'working')])
    h.coordinator.observe([h.pane('p1', 'idle')])
    h.advance(60_000)
    expect(h.notifier.sent).toHaveLength(0)
  })

  it('no avisa con la ventana a la vista ni con el ajuste desactivado', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'working')])
    h.state.focused = true
    h.coordinator.observe([h.pane('p1', 'done')])
    h.state.focused = false
    h.coordinator.observe([h.pane('p1', 'working')])
    h.state.enabled = false
    h.coordinator.observe([h.pane('p1', 'needs-input')])
    h.advance(60_000)
    expect(h.notifier.sent).toHaveLength(0)
  })

  it('descarta lo que ya no es cierto al enviar (se respondió antes de que pasara la espera)', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'working')])
    h.coordinator.observe([h.pane('p1', 'needs-input')])
    h.advance(500)
    h.coordinator.observe([h.pane('p1', 'working')])
    h.advance(5000)
    expect(h.notifier.sent).toHaveLength(0)
  })

  it('si la ventana recupera el foco durante la espera, no se envía nada', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'working')])
    h.coordinator.observe([h.pane('p1', 'done')])
    h.advance(500)
    h.state.focused = true
    h.coordinator.focusChanged(true)
    h.advance(5000)
    expect(h.notifier.sent).toHaveLength(0)
    expect(h.pendingTimers()).toBe(0)
  })

  it('agrupa varios paneles que cambian a la vez en una sola notificación, la más urgente primero', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('a', 'working'), h.pane('b', 'working'), h.pane('c', 'working')])
    h.coordinator.observe([h.pane('a', 'done'), h.pane('b', 'working'), h.pane('c', 'working')])
    h.advance(400)
    h.coordinator.observe([h.pane('a', 'done'), h.pane('b', 'needs-input'), h.pane('c', 'error')])
    h.advance(DEFAULT_TIMING.coalesceMs)
    expect(h.notifier.sent).toHaveLength(1)
    const n = h.notifier.sent[0]
    expect(n?.title).toBe('3 paneles necesitan atención')
    expect(n?.tag).toBe('nexo-group')
    n?.click()
    expect(h.revealed).toEqual(['b'])
  })

  it('un clic en una notificación individual revela su panel', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'working')])
    h.coordinator.observe([h.pane('p1', 'done')])
    h.advance(DEFAULT_TIMING.coalesceMs)
    h.notifier.sent[0]?.click()
    expect(h.revealed).toEqual(['p1'])
  })

  it('un agente que alterna estados no hace spam: espera por panel', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'working')])
    for (let i = 0; i < 20; i++) {
      h.coordinator.observe([h.pane('p1', 'needs-input')])
      h.advance(2000)
      h.coordinator.observe([h.pane('p1', 'working')])
      h.advance(2000)
    }
    // 80 s en total: una cada 20 s como mucho.
    expect(h.notifier.sent.length).toBeLessThanOrEqual(4)
    expect(h.notifier.sent.length).toBeGreaterThanOrEqual(1)
  })

  it('entre dos notificaciones de paneles distintos respeta la espera global', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('a', 'working'), h.pane('b', 'working')])
    h.coordinator.observe([h.pane('a', 'done'), h.pane('b', 'working')])
    h.advance(DEFAULT_TIMING.coalesceMs)
    expect(h.notifier.sent).toHaveLength(1)
    h.coordinator.observe([h.pane('a', 'done'), h.pane('b', 'done')])
    h.advance(DEFAULT_TIMING.coalesceMs)
    expect(h.notifier.sent).toHaveLength(1)
    h.advance(DEFAULT_TIMING.globalGapMs)
    expect(h.notifier.sent).toHaveLength(2)
  })

  it('olvida los paneles cerrados (un id reutilizado vuelve a empezar)', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'working')])
    h.coordinator.observe([])
    h.coordinator.observe([h.pane('p1', 'done')])
    h.advance(60_000)
    expect(h.notifier.sent).toHaveLength(0)
  })

  it('sin clic nativo (escritorio), recuperar el foco poco después lleva al panel', () => {
    const h = makeHarness({ supportsClick: false })
    h.coordinator.observe([h.pane('p1', 'working')])
    h.coordinator.observe([h.pane('p1', 'needs-input')])
    h.advance(DEFAULT_TIMING.coalesceMs)
    expect(h.notifier.sent).toHaveLength(1)
    h.advance(3000)
    h.state.focused = true
    h.coordinator.focusChanged(true)
    expect(h.revealed).toEqual(['p1'])
    // Solo una vez.
    h.coordinator.focusChanged(true)
    expect(h.revealed).toEqual(['p1'])
  })

  it('sin clic nativo, un regreso tardío no salta a ningún panel; con clic nativo tampoco', () => {
    const late = makeHarness({ supportsClick: false })
    late.coordinator.observe([late.pane('p1', 'working')])
    late.coordinator.observe([late.pane('p1', 'done')])
    late.advance(DEFAULT_TIMING.coalesceMs + DEFAULT_TIMING.focusJumpMs + 1)
    late.coordinator.focusChanged(true)
    expect(late.revealed).toEqual([])

    const native = makeHarness({ supportsClick: true })
    native.coordinator.observe([native.pane('p1', 'working')])
    native.coordinator.observe([native.pane('p1', 'done')])
    native.advance(DEFAULT_TIMING.coalesceMs)
    native.coordinator.focusChanged(true)
    expect(native.revealed).toEqual([])
  })

  it('dispose cancela lo pendiente y deja de observar', () => {
    const h = makeHarness()
    h.coordinator.observe([h.pane('p1', 'working')])
    h.coordinator.observe([h.pane('p1', 'done')])
    h.coordinator.dispose()
    h.coordinator.observe([h.pane('p2', 'working')])
    h.coordinator.observe([h.pane('p2', 'done')])
    h.advance(60_000)
    expect(h.notifier.sent).toHaveLength(0)
    expect(h.pendingTimers()).toBe(0)
  })
})

describe('clip', () => {
  it('quita controles y saltos, junta espacios y acota', () => {
    expect(clip('a\u0000b\nc‮d   e')).toBe('a b c d e')
    expect(clip('x'.repeat(500))).toHaveLength(100)
    expect(clip('   ')).toBe('')
  })
})
