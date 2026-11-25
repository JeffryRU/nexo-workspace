import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  webglThrows: false,
  webglInstances: [] as { dispose: ReturnType<typeof vi.fn>; lose: () => void }[],
  terminals: [] as Record<string, unknown>[],
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    written: string[] = []
    options: unknown
    dataCb: ((d: string) => void) | undefined
    constructor(options: unknown) {
      this.options = options
      state.terminals.push(this as unknown as Record<string, unknown>)
    }
    loadAddon() {}
    open() {}
    write(data: string, cb?: () => void) {
      this.written.push(data)
      cb?.()
    }
    onData(cb: (d: string) => void) {
      this.dataCb = cb
    }
    onResize() {}
    focus() {}
    reset() {}
    dispose() {}
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext(q: string) {
      return q === 'si'
    }
    findPrevious(q: string) {
      return q === 'si'
    }
    clearDecorations() {}
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    dispose = vi.fn()
    #loss: (() => void) | undefined
    constructor() {
      if (state.webglThrows) throw new Error('sin WebGL')
      state.webglInstances.push({ dispose: this.dispose, lose: () => this.#loss?.() })
    }
    onContextLoss(cb: () => void) {
      this.#loss = cb
    }
  },
}))

const { createXtermHandle } = await import('./xterm-adapter.ts')

beforeEach(() => {
  state.webglThrows = false
  state.webglInstances.length = 0
  state.terminals.length = 0
})

describe('createXtermHandle', () => {
  it('abre la terminal una sola vez y reubica su elemento', () => {
    const h = createXtermHandle()
    const a = document.createElement('div')
    const b = document.createElement('div')
    h.mount(a)
    h.mount(b)
    expect(a.contains(h.element)).toBe(false)
    expect(b.contains(h.element)).toBe(true)
    h.unmount()
    expect(b.contains(h.element)).toBe(false)
  })

  it('carga WebGL al activarlo y lo libera al desactivarlo', () => {
    const h = createXtermHandle()
    h.setWebgl(true) // sin abrir todavía: no hace nada
    expect(h.webglActive).toBe(false)
    h.mount(document.createElement('div'))
    h.setWebgl(true)
    h.setWebgl(true)
    expect(h.webglActive).toBe(true)
    expect(state.webglInstances).toHaveLength(1)
    h.setWebgl(false)
    expect(h.webglActive).toBe(false)
    expect(state.webglInstances[0]?.dispose).toHaveBeenCalledTimes(1)
    h.setWebgl(true)
    expect(state.webglInstances).toHaveLength(2)
  })

  it('si WebGL falla al crearse se queda con el renderer DOM sin romper', () => {
    state.webglThrows = true
    const h = createXtermHandle()
    h.mount(document.createElement('div'))
    expect(() => h.setWebgl(true)).not.toThrow()
    expect(h.webglActive).toBe(false)
  })

  it('si se pierde el contexto WebGL cae al renderer DOM', () => {
    const h = createXtermHandle()
    h.mount(document.createElement('div'))
    h.setWebgl(true)
    state.webglInstances[0]?.lose()
    expect(h.webglActive).toBe(false)
    expect(state.webglInstances[0]?.dispose).toHaveBeenCalled()
    // y se puede volver a intentar
    h.setWebgl(true)
    expect(h.webglActive).toBe(true)
  })

  it('fit devuelve undefined si el contenedor no tiene tamaño', () => {
    const h = createXtermHandle()
    expect(h.fit()).toBeUndefined()
    h.mount(document.createElement('div'))
    expect(h.fit()).toBeUndefined() // jsdom: clientWidth = 0
  })

  it('búsqueda, avisos, escritura y datos', () => {
    const h = createXtermHandle()
    expect(h.find('', 'next')).toBe(false)
    expect(h.find('si', 'next')).toBe(true)
    expect(h.find('si', 'prev')).toBe(true)
    h.clearSearch()
    h.notice('hola\x1b[31m')
    const term = state.terminals[0] as { written: string[]; dataCb?: (d: string) => void }
    expect(term.written[0]).not.toContain('\x1b[31m')
    const got: string[] = []
    h.onData((d) => got.push(d))
    h.onResize(() => {})
    term.dataCb?.('x')
    expect(got).toEqual(['x'])
    const done = vi.fn()
    h.write('abc', done)
    expect(done).toHaveBeenCalled()
    h.focus()
    h.reset()
    expect(h.cols).toBe(80)
    expect(h.rows).toBe(24)
    h.dispose()
  })
})
