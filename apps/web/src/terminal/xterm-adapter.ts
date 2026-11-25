import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSink } from './hub.ts'
import { terminalTheme, withSymbolsFallback } from './theme.ts'

/** Lo que el resto de la interfaz necesita de una terminal; xterm queda detrás de esta interfaz. */
export interface XtermHandle extends TerminalSink {
  readonly element: HTMLElement
  readonly cols: number
  readonly rows: number
  /** Inserta la terminal en `host` (la abre la primera vez; después solo la reubica). */
  mount(host: HTMLElement): void
  unmount(): void
  /** Ajusta filas y columnas al contenedor; `undefined` si no hay tamaño medible. */
  fit(): { cols: number; rows: number } | undefined
  onData(cb: (data: string) => void): void
  onResize(cb: (size: { cols: number; rows: number }) => void): void
  /** Carga o libera el renderer WebGL; si falla o se pierde el contexto, queda el renderer DOM. */
  setWebgl(on: boolean): void
  readonly webglActive: boolean
  focus(): void
  find(query: string, direction: 'next' | 'prev'): boolean
  clearSearch(): void
  /** Texto propio de la interfaz (no viene del proceso). */
  notice(text: string): void
  dispose(): void
}

export type XtermFactory = () => XtermHandle

export const SCROLLBACK = 5000

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v === '' ? fallback : v
  } catch {
    return fallback
  }
}

export function createXtermHandle(): XtermHandle {
  const term = new Terminal({
    allowProposedApi: true,
    scrollback: SCROLLBACK,
    cursorBlink: true,
    fontSize: 13,
    fontFamily: withSymbolsFallback(cssVar('--font-mono', 'monospace')),
    theme: terminalTheme,
    macOptionIsMeta: true,
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer')
    }),
  )

  const element = document.createElement('div')
  element.className = 'xterm-host'
  let opened = false
  let webgl: WebglAddon | undefined

  const dropWebgl = () => {
    const w = webgl
    webgl = undefined
    try {
      w?.dispose()
    } catch {
      // ya liberado
    }
  }

  return {
    element,
    get cols() {
      return term.cols
    },
    get rows() {
      return term.rows
    },
    get webglActive() {
      return webgl !== undefined
    },
    mount(host) {
      host.appendChild(element)
      if (!opened) {
        opened = true
        term.open(element)
      }
    },
    unmount() {
      element.remove()
    },
    fit() {
      if (!opened || element.clientWidth === 0 || element.clientHeight === 0) return undefined
      try {
        fit.fit()
      } catch {
        return undefined
      }
      return { cols: term.cols, rows: term.rows }
    },
    onData(cb) {
      term.onData(cb)
    },
    onResize(cb) {
      term.onResize(cb)
    },
    setWebgl(on) {
      if (!on) {
        dropWebgl()
        return
      }
      if (webgl !== undefined || !opened) return
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          if (webgl === addon) dropWebgl()
        })
        term.loadAddon(addon)
        webgl = addon
      } catch {
        webgl = undefined
      }
    },
    focus() {
      term.focus()
    },
    find(query, direction) {
      if (query === '') return false
      return direction === 'next' ? search.findNext(query) : search.findPrevious(query)
    },
    clearSearch() {
      search.clearDecorations()
    },
    notice(text) {
      term.write(`\r\n\x1b[2m${text.replace(/\p{Cc}/gu, ' ')}\x1b[0m\r\n`)
    },
    write(data, done) {
      term.write(data, done)
    },
    reset() {
      term.reset()
    },
    dispose() {
      dropWebgl()
      term.dispose()
      element.remove()
    },
  }
}
