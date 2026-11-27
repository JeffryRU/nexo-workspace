import type { CompanionState } from '@nexo/contracts'
import { FakeClock } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { CompanionStateMachine, DEFAULT_COMPANION_TIMING } from './companion-state.ts'

function rig() {
  const clock = new FakeClock(1000)
  const changes: [CompanionState, number][] = []
  const machine = new CompanionStateMachine({
    clock,
    onChange: (state, since) => changes.push([state, since]),
  })
  return { clock, changes, machine }
}

describe('CompanionStateMachine', () => {
  it('arranca en idle sin avisar', () => {
    const { machine, changes } = rig()
    expect(machine.state).toBe('idle')
    expect(machine.since).toBe(1000)
    expect(changes).toEqual([])
  })

  it('un estado de mayor prioridad se muestra enseguida', () => {
    const { machine, changes } = rig()
    machine.setTarget('thinking')
    expect(machine.state).toBe('thinking')
    machine.setTarget('waiting')
    expect(machine.state).toBe('waiting')
    expect(changes.map((c) => c[0])).toEqual(['thinking', 'waiting'])
  })

  it('bajar de prioridad espera al tiempo mínimo del estado actual (sin parpadeos)', () => {
    const { machine, clock, changes } = rig()
    machine.setTarget('thinking')
    clock.advance(300)
    machine.setTarget('idle')
    expect(machine.state).toBe('thinking')
    clock.advance(699)
    expect(machine.state).toBe('thinking')
    clock.advance(1)
    expect(machine.state).toBe('idle')
    expect(changes.map((c) => c[0])).toEqual(['thinking', 'idle'])
  })

  it('un parpadeo del objetivo (thinking, idle, thinking) no cambia lo que se ve', () => {
    const { machine, clock, changes } = rig()
    machine.setTarget('thinking')
    clock.advance(100)
    machine.setTarget('idle')
    clock.advance(100)
    machine.setTarget('thinking')
    clock.advance(5000)
    expect(machine.state).toBe('thinking')
    expect(changes.map((c) => c[0])).toEqual(['thinking'])
    expect(clock.pending).toBe(0)
  })

  it('pasado el tiempo mínimo, bajar es inmediato', () => {
    const { machine, clock } = rig()
    machine.setTarget('error')
    clock.advance(10_000)
    machine.setTarget('idle')
    expect(machine.state).toBe('idle')
  })

  it('done se celebra y vuelve a idle aunque el objetivo siga en done', () => {
    const { machine, clock, changes } = rig()
    machine.setTarget('done', true)
    expect(machine.state).toBe('done')
    clock.advance(DEFAULT_COMPANION_TIMING.doneHoldMs - 1)
    expect(machine.state).toBe('done')
    clock.advance(1)
    expect(machine.state).toBe('idle')
    clock.advance(60_000)
    expect(changes.map((c) => c[0])).toEqual(['done', 'idle'])
  })

  it('otro «terminado» vuelve a celebrar, y uno nuevo mientras se celebra reinicia el plazo', () => {
    const { machine, clock, changes } = rig()
    machine.setTarget('done', true)
    clock.advance(5000)
    machine.setTarget('done', true)
    clock.advance(5000)
    expect(machine.state).toBe('done')
    clock.advance(1000)
    expect(machine.state).toBe('idle')
    machine.setTarget('done', true)
    expect(machine.state).toBe('done')
    expect(changes.map((c) => c[0])).toEqual(['done', 'idle', 'done'])
  })

  it('de done a thinking es inmediato (el usuario manda otra orden)', () => {
    const { machine } = rig()
    machine.setTarget('done', true)
    machine.setTarget('thinking')
    expect(machine.state).toBe('thinking')
  })

  it('de waiting a error espera su tiempo mínimo', () => {
    const { machine, clock } = rig()
    machine.setTarget('waiting')
    machine.setTarget('error')
    expect(machine.state).toBe('waiting')
    clock.advance(2000)
    expect(machine.state).toBe('error')
  })

  it('dispose cancela temporizadores y deja de reaccionar', () => {
    const { machine, clock, changes } = rig()
    machine.setTarget('thinking')
    machine.setTarget('idle')
    machine.dispose()
    expect(clock.pending).toBe(0)
    clock.advance(10_000)
    machine.setTarget('error')
    expect(machine.state).toBe('thinking')
    expect(changes).toHaveLength(1)
  })

  it('acepta tiempos propios', () => {
    const clock = new FakeClock(0)
    const machine = new CompanionStateMachine({
      clock,
      timing: {
        minShowMs: { idle: 0, done: 10, thinking: 50, busy: 50, error: 10, waiting: 10 },
        doneHoldMs: 20,
      },
      onChange: () => {},
    })
    machine.setTarget('thinking')
    machine.setTarget('idle')
    clock.advance(49)
    expect(machine.state).toBe('thinking')
    clock.advance(1)
    expect(machine.state).toBe('idle')
  })
})
