import { es, format } from '../i18n/es.ts'
import type { ExitInfo } from '../state/model.ts'
import type { TerminalHub } from './hub.ts'
import type { XtermHandle } from './xterm-adapter.ts'

export type PaneIo = {
  spawn(paneId: string, cols: number, rows: number): void
  write(terminalId: string, data: string): void
  resize(terminalId: string, cols: number, rows: number): void
}

export type PaneSessionDeps = {
  paneId: string
  xterm: XtermHandle
  hub: TerminalHub
  io: PaneIo
  frame: (cb: () => void) => void
  /** `setTimeout` inyectable (debounce del redimensionado). */
  timer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  observe: (el: HTMLElement, cb: () => void) => () => void
  resizeDebounceMs?: number
}

const DEFAULT_SIZE = { cols: 80, rows: 24 }

/**
 * Una terminal de un panel: persiste mientras exista el panel, aunque su pestaña esté oculta o el componente
 * se vuelva a montar. Agrupa la entrada por fotograma, redimensiona con debounce y carga WebGL solo si es visible.
 */
export class PaneSession {
  readonly xterm: XtermHandle
  readonly #d: PaneSessionDeps
  #terminalId: string | undefined
  #detachHub: (() => void) | undefined
  #visible = false
  #exit: ExitInfo | undefined
  #input = ''
  #inputScheduled = false
  #lastSent: { cols: number; rows: number } | undefined
  #resizeTimer: unknown
  #stopObserving: (() => void) | undefined
  #host: HTMLElement | undefined
  #spawnRequested = false
  #disposed = false

  constructor(deps: PaneSessionDeps) {
    this.#d = deps
    this.xterm = deps.xterm
    this.xterm.onData((data) => this.#onData(data))
    this.xterm.onResize(() => this.#scheduleResize())
  }

  get terminalId(): string | undefined {
    return this.#terminalId
  }

  get visible(): boolean {
    return this.#visible
  }

  mount(host: HTMLElement): void {
    if (this.#disposed) return
    this.#stopObserving?.()
    this.#host = host
    this.xterm.mount(host)
    this.#stopObserving = this.#d.observe(host, () => this.#scheduleResize())
    if (this.#visible) this.#applyVisible()
  }

  unmount(host: HTMLElement): void {
    if (this.#host !== host) return
    this.#stopObserving?.()
    this.#stopObserving = undefined
    this.#host = undefined
    this.xterm.setWebgl(false)
    this.xterm.unmount()
  }

  /** Visible = su pestaña y su espacio están activos. Oculto libera WebGL; los datos siguen llegando. */
  setVisible(visible: boolean): void {
    if (this.#disposed || this.#visible === visible) return
    this.#visible = visible
    if (this.#terminalId !== undefined) this.#d.hub.setVisible(this.#terminalId, visible)
    this.#applyVisible()
  }

  #applyVisible(): void {
    if (this.#host === undefined) return
    if (!this.#visible) {
      this.xterm.setWebgl(false)
      return
    }
    this.xterm.fit()
    this.xterm.setWebgl(true)
    this.#maybeSpawn()
  }

  /** El panel (re)apunta a una terminal del daemon, o a ninguna. */
  setTerminal(terminalId: string | undefined): void {
    if (this.#disposed || terminalId === this.#terminalId) return
    this.#detachHub?.()
    this.#detachHub = undefined
    if (this.#terminalId !== undefined && terminalId !== undefined) this.xterm.reset()
    this.#terminalId = terminalId
    this.#lastSent = undefined
    this.#exit = undefined
    if (terminalId === undefined) {
      this.#maybeSpawn()
      return
    }
    this.#spawnRequested = false
    this.#detachHub = this.#d.hub.attach(terminalId, this.xterm)
    this.#d.hub.setVisible(terminalId, this.#visible)
    this.#scheduleResize()
  }

  /** El proceso terminó: avisa en la propia terminal (texto de la interfaz, no del proceso). */
  setExit(exit: ExitInfo | undefined): void {
    if (this.#disposed || exit === undefined || this.#exit !== undefined) return
    this.#exit = exit
    const what =
      exit.signal !== null
        ? format(es.pane.exitedWithSignal, { signal: exit.signal })
        : exit.exitCode !== null
          ? format(es.pane.exitedWithCode, { code: exit.exitCode })
          : es.pane.exited
    this.xterm.notice(`${what}. ${es.pane.pressEnter}`)
  }

  focus(): void {
    this.xterm.focus()
  }

  find(query: string, direction: 'next' | 'prev'): boolean {
    return this.xterm.find(query, direction)
  }

  clearSearch(): void {
    this.xterm.clearSearch()
  }

  /** Pide la terminal al daemon cuando el panel está visible y todavía no tiene una. */
  #maybeSpawn(): void {
    if (this.#terminalId !== undefined || this.#spawnRequested || !this.#visible) return
    this.#spawnRequested = true
    const size = this.xterm.fit() ?? {
      cols: this.xterm.cols || DEFAULT_SIZE.cols,
      rows: this.xterm.rows || DEFAULT_SIZE.rows,
    }
    this.#d.io.spawn(this.#d.paneId, size.cols, size.rows)
  }

  #onData(data: string): void {
    if (this.#exit !== undefined && this.#terminalId !== undefined) {
      // Terminal terminada: Intro la reinicia; el resto se descarta.
      if (data === '\r') {
        this.#exit = undefined
        this.#terminalId = undefined
        this.#detachHub?.()
        this.#detachHub = undefined
        this.#spawnRequested = false
        this.xterm.reset()
        this.#maybeSpawn()
      }
      return
    }
    if (this.#terminalId === undefined) return
    this.#input += data
    if (this.#inputScheduled) return
    this.#inputScheduled = true
    this.#d.frame(() => {
      this.#inputScheduled = false
      const id = this.#terminalId
      const text = this.#input
      this.#input = ''
      if (id !== undefined && text !== '') this.#d.io.write(id, text)
    })
  }

  #scheduleResize(): void {
    const timer = this.#d.timer ?? ((cb, ms) => setTimeout(cb, ms))
    const clear = this.#d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    if (this.#resizeTimer !== undefined) clear(this.#resizeTimer)
    this.#resizeTimer = timer(() => {
      this.#resizeTimer = undefined
      this.#sendResize()
    }, this.#d.resizeDebounceMs ?? 60)
  }

  #sendResize(): void {
    if (this.#disposed) return
    if (this.#visible && this.#host !== undefined) this.xterm.fit()
    const id = this.#terminalId
    if (id === undefined) return
    const cols = this.xterm.cols
    const rows = this.xterm.rows
    if (cols < 1 || rows < 1) return
    const last = this.#lastSent
    if (last !== undefined && last.cols === cols && last.rows === rows) return
    this.#lastSent = { cols, rows }
    this.#d.io.resize(id, cols, rows)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#stopObserving?.()
    this.#detachHub?.()
    if (this.#resizeTimer !== undefined) {
      const clear = this.#d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
      clear(this.#resizeTimer)
    }
    this.xterm.dispose()
  }
}

/** Sesiones de terminal por panel: se crean al ver el panel por primera vez y se liberan al cerrarlo. */
export class SessionRegistry {
  readonly #sessions = new Map<string, PaneSession>()
  readonly #create: (paneId: string) => PaneSession

  constructor(create: (paneId: string) => PaneSession) {
    this.#create = create
  }

  ensure(paneId: string): PaneSession {
    let s = this.#sessions.get(paneId)
    if (s === undefined) {
      s = this.#create(paneId)
      this.#sessions.set(paneId, s)
    }
    return s
  }

  get(paneId: string): PaneSession | undefined {
    return this.#sessions.get(paneId)
  }

  get size(): number {
    return this.#sessions.size
  }

  /** Libera las sesiones de paneles que ya no existen. */
  prune(livePaneIds: ReadonlySet<string>): void {
    for (const [id, s] of [...this.#sessions]) {
      if (!livePaneIds.has(id)) {
        s.dispose()
        this.#sessions.delete(id)
      }
    }
  }

  disposeAll(): void {
    for (const s of this.#sessions.values()) s.dispose()
    this.#sessions.clear()
  }
}
