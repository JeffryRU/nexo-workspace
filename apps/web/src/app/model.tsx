import { PaneId, TerminalId } from '@nexo/contracts'
import { createContext, useContext } from 'solid-js'
import type { DaemonSession } from '../daemon/session.ts'
import { PaneSession, SessionRegistry } from '../terminal/pane-session.ts'
import type { XtermFactory } from '../terminal/xterm-adapter.ts'

export type AppModel = DaemonSession & { sessions: SessionRegistry }

const defaultFrame = (cb: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb())
  else setTimeout(cb, 16)
}

const defaultObserve = (el: HTMLElement, cb: () => void): (() => void) => {
  if (typeof ResizeObserver === 'undefined') return () => {}
  const observer = new ResizeObserver(() => cb())
  observer.observe(el)
  return () => observer.disconnect()
}

/** Una terminal recién mostrada carga WebGL si sigue a la vista tras esta espera (ver `PaneSessionDeps`). */
const WEBGL_DELAY_MS = 150

/** Añade al estado de la sesión el registro de terminales de xterm (una por panel). */
export function createAppModel(
  session: DaemonSession,
  xtermFactory: XtermFactory,
  frame: (cb: () => void) => void = defaultFrame,
  options: { webglDelayMs?: number } = {},
): AppModel {
  const io = {
    spawn: (paneId: string, cols: number, rows: number) =>
      void session.actions.spawn(PaneId.parse(paneId), cols, rows),
    write: (terminalId: string, data: string) =>
      void session.actions.write(TerminalId.parse(terminalId), data),
    resize: (terminalId: string, cols: number, rows: number) =>
      void session.actions.resizeTerminal(TerminalId.parse(terminalId), cols, rows),
  }
  const sessions = new SessionRegistry(
    (paneId) =>
      new PaneSession({
        paneId,
        xterm: xtermFactory(),
        hub: session.hub,
        io,
        frame,
        observe: defaultObserve,
        webglDelayMs: options.webglDelayMs ?? WEBGL_DELAY_MS,
      }),
  )
  return { ...session, sessions }
}

const Context = createContext<AppModel>()

export const ModelProvider = Context.Provider

export function useModel(): AppModel {
  const model = useContext(Context)
  if (model === undefined) throw new Error('falta el proveedor del modelo')
  return model
}
