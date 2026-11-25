import { describe, expect, it } from 'vitest'
import { type FocusDocument, trackWindowFocus } from './focus.ts'

function fakeEnv() {
  const listeners = new Map<string, Set<() => void>>()
  const add = (type: string, l: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)?.add(l)
  }
  const remove = (type: string, l: () => void) => void listeners.get(type)?.delete(l)
  const doc: FocusDocument & { focus: boolean; visibility: string } = {
    focus: true,
    visibility: 'visible',
    hasFocus() {
      return this.focus
    },
    get visibilityState() {
      return this.visibility
    },
    addEventListener: add,
    removeEventListener: remove,
  }
  const win = { addEventListener: add, removeEventListener: remove }
  const fire = (type: string) => {
    for (const l of [...(listeners.get(type) ?? [])]) l()
  }
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0)
  return { doc, win, fire, count }
}

describe('trackWindowFocus', () => {
  it('informa del estado inicial y de cada cambio, sin repetir', () => {
    const { doc, win, fire } = fakeEnv()
    const seen: boolean[] = []
    trackWindowFocus(win, doc, (f) => seen.push(f))
    expect(seen).toEqual([true])
    doc.focus = false
    fire('blur')
    fire('blur')
    doc.focus = true
    fire('focus')
    expect(seen).toEqual([true, false, true])
  })

  it('una ventana oculta no tiene foco aunque el documento lo tenga', () => {
    const { doc, win, fire } = fakeEnv()
    const seen: boolean[] = []
    trackWindowFocus(win, doc, (f) => seen.push(f))
    doc.visibility = 'hidden'
    fire('visibilitychange')
    expect(seen).toEqual([true, false])
  })

  it('la baja quita todos los oyentes', () => {
    const { doc, win, count } = fakeEnv()
    const stop = trackWindowFocus(win, doc, () => {})
    expect(count()).toBe(3)
    stop()
    expect(count()).toBe(0)
  })
})
