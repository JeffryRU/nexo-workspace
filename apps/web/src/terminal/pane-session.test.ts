import { describe, expect, it, vi } from 'vitest'
import { FakeXterm, manualFrames } from '../test-helpers.ts'
import { TerminalHub } from './hub.ts'
import { PaneSession, SessionRegistry } from './pane-session.ts'

function setup() {
  const frames = manualFrames()
  const timers: { cb: () => void; ms: number; cleared: boolean }[] = []
  const xterm = new FakeXterm()
  const hub = new TerminalHub({ frame: frames.frame, read: async () => ({ data: '', offset: 0 }) })
  const io = { spawn: vi.fn(), write: vi.fn(), resize: vi.fn() }
  let observed: (() => void) | undefined
  const stopObserving = vi.fn()
  const session = new PaneSession({
    paneId: 'p1',
    xterm,
    hub,
    io,
    frame: frames.frame,
    timer: (cb, ms) => {
      const t = { cb, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    },
    observe: (_el, cb) => {
      observed = cb
      return stopObserving
    },
  })
  const runTimers = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.cb()
  }
  return {
    session,
    xterm,
    hub,
    io,
    frames,
    timers,
    runTimers,
    observed: () => observed,
    stopObserving,
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('PaneSession', () => {
  it('WebGL solo mientras es visible: se carga al mostrar y se libera al ocultar', () => {
    const { session, xterm } = setup()
    const host = document.createElement('div')
    session.mount(host)
    expect(xterm.webglActive).toBe(false)
    session.setVisible(true)
    expect(xterm.webglActive).toBe(true)
    session.setVisible(false)
    expect(xterm.webglActive).toBe(false)
    session.setVisible(true)
    expect(xterm.webglLoads).toBe(2)
    expect(xterm.webglDisposals).toBe(1)
  })

  it('al mostrarse por primera vez pide la terminal con el tamaño ajustado', () => {
    const { session, io } = setup()
    session.mount(document.createElement('div'))
    session.setVisible(true)
    expect(io.spawn).toHaveBeenCalledWith('p1', 100, 30)
    session.setVisible(false)
    session.setVisible(true)
    expect(io.spawn).toHaveBeenCalledTimes(1)
  })

  it('sin tamaño medible usa el de xterm', () => {
    const { session, io, xterm } = setup()
    xterm.fitSize = undefined
    session.mount(document.createElement('div'))
    session.setVisible(true)
    expect(io.spawn).toHaveBeenCalledWith('p1', 80, 24)
  })

  it('agrupa las teclas por fotograma y las envía a la terminal', () => {
    const { session, xterm, io, frames } = setup()
    session.setTerminal('x1')
    xterm.type('l')
    xterm.type('s')
    xterm.type('\r')
    expect(io.write).not.toHaveBeenCalled()
    frames.flush()
    expect(io.write).toHaveBeenCalledTimes(1)
    expect(io.write).toHaveBeenCalledWith('x1', 'ls\r')
  })

  it('descarta la entrada si no hay terminal', () => {
    const { session, xterm, io, frames } = setup()
    xterm.type('a')
    frames.flush()
    expect(io.write).not.toHaveBeenCalled()
    expect(session.terminalId).toBeUndefined()
  })

  it('redimensiona con debounce y no repite el mismo tamaño', () => {
    const { session, xterm, io, runTimers } = setup()
    session.mount(document.createElement('div'))
    session.setVisible(true)
    session.setTerminal('x1')
    runTimers()
    expect(io.resize).toHaveBeenCalledWith('x1', 100, 30)
    xterm.fitSize = { cols: 90, rows: 20 }
    xterm.resize(90, 20)
    xterm.resize(91, 20)
    xterm.fitSize = { cols: 91, rows: 21 }
    runTimers()
    expect(io.resize).toHaveBeenCalledTimes(2)
    expect(io.resize).toHaveBeenLastCalledWith('x1', 91, 21)
    xterm.resize(91, 21)
    runTimers()
    expect(io.resize).toHaveBeenCalledTimes(2)
  })

  it('el observador de tamaño dispara el redimensionado', () => {
    const { session, io, runTimers, observed } = setup()
    session.mount(document.createElement('div'))
    session.setVisible(true)
    session.setTerminal('x1')
    runTimers()
    io.resize.mockClear()
    const n = { cols: 50, rows: 10 }
    ;(session.xterm as FakeXterm).fitSize = n
    observed()?.()
    runTimers()
    expect(io.resize).toHaveBeenCalledWith('x1', 50, 10)
  })

  it('al cambiar de terminal reinicia la pantalla y reasocia la salida', async () => {
    const { session, xterm, hub, frames } = setup()
    hub.sync(['x1', 'x2'])
    await tick()
    session.setTerminal('x1')
    hub.onOutput('x1', 1, 'a')
    frames.flush()
    session.setTerminal('x2')
    expect(xterm.resets).toBe(1)
    hub.onOutput('x2', 1, 'b')
    frames.flush()
    expect(xterm.written.join('')).toBe('b')
  })

  it('avisa del fin del proceso con texto de la interfaz y se reinicia con Intro', () => {
    const { session, xterm, io, frames } = setup()
    session.mount(document.createElement('div'))
    session.setVisible(true)
    session.setTerminal('x1')
    session.setExit({ exitCode: 2, signal: null })
    session.setExit({ exitCode: 2, signal: null })
    expect(xterm.notices).toHaveLength(1)
    expect(xterm.notices[0]).toContain('código 2')
    xterm.type('x')
    frames.flush()
    expect(io.write).not.toHaveBeenCalled()
    io.spawn.mockClear()
    xterm.type('\r')
    expect(io.spawn).toHaveBeenCalledTimes(1)
    expect(session.terminalId).toBeUndefined()
  })

  it('describe la señal y el caso sin código', () => {
    const a = setup()
    a.session.setTerminal('x1')
    a.session.setExit({ exitCode: null, signal: 'SIGKILL' })
    expect(a.xterm.notices[0]).toContain('SIGKILL')
    const b = setup()
    b.session.setTerminal('x1')
    b.session.setExit({ exitCode: null, signal: null })
    expect(b.xterm.notices[0]).toContain('terminó')
    b.session.setExit(undefined)
  })

  it('unmount quita el elemento y libera WebGL pero conserva la instancia', () => {
    const { session, xterm, stopObserving } = setup()
    const host = document.createElement('div')
    session.mount(host)
    session.setVisible(true)
    expect(host.contains(xterm.element)).toBe(true)
    session.unmount(document.createElement('div')) // otro host: se ignora
    expect(host.contains(xterm.element)).toBe(true)
    session.unmount(host)
    expect(host.contains(xterm.element)).toBe(false)
    expect(xterm.webglActive).toBe(false)
    expect(xterm.disposed).toBe(false)
    expect(stopObserving).toHaveBeenCalled()
    session.mount(host)
    expect(xterm.webglActive).toBe(true)
  })

  it('dispose libera xterm y deja de reaccionar', () => {
    const { session, xterm, io } = setup()
    session.dispose()
    session.dispose()
    session.setVisible(true)
    session.setTerminal('x1')
    session.mount(document.createElement('div'))
    expect(xterm.disposed).toBe(true)
    expect(io.spawn).not.toHaveBeenCalled()
  })

  it('focus y búsqueda se delegan en xterm', () => {
    const { session, xterm } = setup()
    session.focus()
    session.find('hola', 'next')
    session.clearSearch()
    expect(xterm.focused).toBe(1)
    expect(xterm.searches).toEqual(['next:hola'])
  })
})

describe('SessionRegistry', () => {
  it('crea una vez por panel y libera las de paneles que ya no existen', () => {
    const created: string[] = []
    const registry = new SessionRegistry((id) => {
      created.push(id)
      return setup().session
    })
    const a = registry.ensure('a')
    expect(registry.ensure('a')).toBe(a)
    registry.ensure('b')
    expect(created).toEqual(['a', 'b'])
    expect(registry.size).toBe(2)
    registry.prune(new Set(['b']))
    expect(registry.get('a')).toBeUndefined()
    expect(registry.size).toBe(1)
    registry.disposeAll()
    expect(registry.size).toBe(0)
  })
})
