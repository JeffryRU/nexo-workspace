import { fireEvent, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { manualFrames } from '../test-helpers.ts'
import { VirtualList, type VirtualListApi } from './VirtualList.tsx'

// jsdom no tiene layout: se simula un contenedor de 400 px donde cada elemento mide 100 px.
const VIEWPORT = 400
const ITEM = 100
let observers: { cb: ResizeObserverCallback; targets: Set<Element> }[] = []

class FakeResizeObserver {
  readonly #entry: { cb: ResizeObserverCallback; targets: Set<Element> }
  constructor(cb: ResizeObserverCallback) {
    this.#entry = { cb, targets: new Set() }
    observers.push(this.#entry)
  }
  observe(el: Element) {
    this.#entry.targets.add(el)
  }
  unobserve(el: Element) {
    this.#entry.targets.delete(el)
  }
  disconnect() {
    this.#entry.targets.clear()
  }
}

const originals: Record<string, PropertyDescriptor | undefined> = {}
const patch = (name: string, get: (this: HTMLElement) => number) => {
  originals[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get })
}

beforeEach(() => {
  observers = []
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
  patch('clientHeight', function () {
    return this.classList.contains('vlist') ? VIEWPORT : 0
  })
  patch('scrollHeight', function () {
    return this.classList.contains('vlist') ? 10_000 : 0
  })
  patch('offsetHeight', function () {
    return this.classList.contains('vitem') ? ITEM : 0
  })
})

afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  for (const [name, d] of Object.entries(originals)) {
    if (d === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(HTMLElement.prototype, name, d)
  }
})

const ids = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`)

function mount(initial: string[]) {
  const frames = manualFrames()
  const [list, setList] = createSignal(initial)
  let api: VirtualListApi | undefined
  const view = render(() => (
    <VirtualList
      ids={list()}
      label="Documento"
      estimate={() => 50}
      frame={frames.frame}
      api={(a) => {
        api = a
      }}
      renderItem={(id) => <span>{id}</span>}
    />
  ))
  const scroller = view.container.querySelector('.vlist') as HTMLElement
  const resize = (el: Element) => {
    for (const o of observers)
      if (o.targets.has(el)) o.cb([{ target: el } as ResizeObserverEntry], {} as ResizeObserver)
  }
  return { ...view, frames, setList, scroller, resize, api: () => api as VirtualListApi }
}

describe('VirtualList', () => {
  it('dibuja solo la ventana visible y la rellena con espaciadores', () => {
    const m = mount(ids(1000))
    const drawn = m.container.querySelectorAll('.vitem')
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThan(60)
    expect(m.scroller.getAttribute('role')).toBe('feed')
    expect(drawn[0]?.getAttribute('aria-setsize')).toBe('1000')
    expect(drawn[0]?.getAttribute('aria-posinset')).toBe('1')
  })

  it('sigue el final cuando llega contenido y no cuando el usuario subió', async () => {
    const m = mount(ids(100))
    m.frames.flush()
    expect(m.scroller.scrollTop).toBe(m.scroller.scrollHeight)
    // Más contenido: se baja otra vez.
    m.setList(ids(120))
    m.frames.flush()
    expect(m.scroller.scrollTop).toBe(m.scroller.scrollHeight)
    await Promise.resolve() // el scroll programático ya terminó
    // El usuario sube: scrollHeight - scrollTop - clientHeight > umbral.
    m.scroller.scrollTop = 100
    fireEvent.scroll(m.scroller)
    expect(m.container.querySelector('.vlist-end')).not.toBeNull()
    m.setList(ids(140))
    m.frames.flush()
    expect(m.scroller.scrollTop).toBe(100)
    // «Ir al final» vuelve a seguir.
    fireEvent.click(m.container.querySelector('.vlist-end') as HTMLElement)
    m.frames.flush()
    expect(m.scroller.scrollTop).toBe(m.scroller.scrollHeight)
    expect(m.container.querySelector('.vlist-end')).toBeNull()
  })

  it('al medir un elemento por encima de la vista, compensa el scroll para que no salte', () => {
    const m = mount(ids(200))
    m.frames.flush()
    m.scroller.scrollTop = 4000
    fireEvent.scroll(m.scroller)
    const before = m.scroller.scrollTop
    const items = [...m.container.querySelectorAll('.vitem')]
    // Los elementos medidos (100 px) eran estimados en 50: crecen 50 px cada uno.
    for (const el of items) m.resize(el)
    m.frames.flush()
    const above = items.filter((el) => Number(el.getAttribute('aria-posinset')) - 1 < 80).length
    expect(m.scroller.scrollTop).toBeGreaterThanOrEqual(before)
    expect(above).toBeGreaterThanOrEqual(0)
  })

  it('scrollToIndex lleva el elemento a la vista y deja de seguir el final', () => {
    const m = mount(ids(300))
    m.frames.flush()
    m.api().scrollToIndex(10)
    expect(m.container.querySelector('[data-id="i10"]')).not.toBeNull()
    expect(m.container.querySelector('.vlist-end')).not.toBeNull()
    m.api().scrollToEnd()
    m.frames.flush()
    expect(m.container.querySelector('.vlist-end')).toBeNull()
  })

  it('la lista vacía no pinta elementos', () => {
    const m = mount([])
    expect(m.container.querySelectorAll('.vitem')).toHaveLength(0)
    expect(m.container.querySelector('.vlist-end')).toBeNull()
  })
})
