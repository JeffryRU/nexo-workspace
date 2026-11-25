import { createEffect, onCleanup, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import type { ExitInfo } from '../state/model.ts'
import type { PaneSession } from '../terminal/pane-session.ts'
import { useVisible } from './visibility.ts'

/**
 * Terminal de un panel. La instancia de xterm vive en el registro (no en este componente): al ocultarse la
 * pestaña o recolocarse el panel solo se mueve su elemento; WebGL se libera si no está a la vista.
 */
export function TerminalView(props: {
  paneId: string
  terminalId: string | undefined
  exit: ExitInfo | undefined
  focused: boolean
}) {
  const { sessions } = useModel()
  const visible = useVisible()
  let host!: HTMLDivElement
  let session: PaneSession | undefined

  createEffect(() => {
    const show = visible()
    if (session === undefined) {
      if (!show) return // la terminal de una pestaña nunca vista no se crea todavía
      session = sessions.ensure(props.paneId)
      session.mount(host)
    }
    session.setTerminal(props.terminalId)
    session.setVisible(show)
  })

  createEffect(() => {
    const exit = props.exit
    if (exit !== undefined) session?.setExit(exit)
  })

  createEffect(() => {
    if (props.focused && visible()) session?.focus()
  })

  onCleanup(() => session?.unmount(host))

  return (
    <div class="terminal-view">
      <div class="terminal-host" ref={host} />
      <Show when={props.terminalId === undefined}>
        <div class="terminal-loading">{es.pane.loading}</div>
      </Show>
    </div>
  )
}
