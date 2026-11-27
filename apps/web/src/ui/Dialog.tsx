import { createEffect, type JSX, on, onCleanup, onMount } from 'solid-js'
import { trapTab } from './focus-trap.ts'
import { Icon } from './Icon.tsx'
import './dialog.css'

/**
 * Cabecera común de los diálogos: el título (se trunca) y un cerrar por icono, alineados en vertical, con un
 * separador debajo. `actions` admite más botones (de icono) a la izquierda del cerrar.
 */
export function DialogHeader(props: {
  title: string
  closeLabel: string
  onClose: () => void
  actions?: JSX.Element
  titleId?: string
}): JSX.Element {
  return (
    <header class="dialog-header">
      <h2 class="dialog-title ellipsis" id={props.titleId} title={props.title}>
        {props.title}
      </h2>
      {props.actions}
      <button
        type="button"
        class="icon-button dialog-close"
        title={props.closeLabel}
        aria-label={props.closeLabel}
        onClick={() => props.onClose()}
      >
        <Icon name="x" />
      </button>
    </header>
  )
}

/**
 * Diálogo modal: fondo, caja con `role="dialog"`, cabecera común y cuerpo con desplazamiento interno. Enfoca la
 * caja al abrir, atrapa Tab, cierra con Esc (o `onEscape`, que puede, por ejemplo, volver un paso atrás) y al
 * desmontarse devuelve el foco a lo que lo tenía. En anchos estrechos ocupa toda la ventana.
 * Se monta dentro de un `<Show when={abierto}>`.
 */
export function Dialog(props: {
  label: string
  closeLabel: string
  onClose: () => void
  /** Esc: por omisión cierra. */
  onEscape?: () => void
  /** Al cambiar este valor el foco vuelve a la caja (p. ej. al cambiar de vista dentro del diálogo). */
  refocus?: () => unknown
  class?: string
  actions?: JSX.Element
  children: JSX.Element
}): JSX.Element {
  let box!: HTMLDivElement
  let previous: Element | null = null
  onMount(() => {
    previous = document.activeElement
    box.focus()
  })
  createEffect(
    on(
      () => props.refocus?.(),
      () => box.focus(),
      { defer: true },
    ),
  )
  onCleanup(() => {
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
  })
  return (
    <div class="modal-backdrop">
      <div
        ref={box}
        class={`modal${props.class === undefined ? '' : ` ${props.class}`}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            if (props.onEscape === undefined) props.onClose()
            else props.onEscape()
          } else trapTab(box, e)
        }}
      >
        <DialogHeader
          title={props.label}
          closeLabel={props.closeLabel}
          onClose={props.onClose}
          actions={props.actions}
        />
        <div class="dialog-body">{props.children}</div>
      </div>
    </div>
  )
}
