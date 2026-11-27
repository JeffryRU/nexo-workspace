import { onCleanup, onMount, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { CompanionDock } from '../companion/CompanionDock.tsx'
import { es } from '../i18n/es.ts'
import { trapTab } from './focus-trap.ts'
import { Sidebar } from './Sidebar.tsx'
import { SIDE_COLUMN_ID } from './TabBar.tsx'
import './SideColumn.css'

/** Cómo se muestra la columna lateral (barra de espacios + mascota). */
export type SideMode = 'full' | 'rail' | 'hidden' | 'drawer'

/**
 * Columna lateral. `full`: barra y mascota a su ancho. `rail`: colapsada, queda un carril estrecho solo con la
 * mascota (si no hay mascota, `hidden`). `drawer`: en ventanas estrechas es un cajón superpuesto (con la mascota
 * dentro) que se abre con el botón de la barra de pestañas.
 */
export function SideColumn(props: { mode: SideMode }) {
  return (
    <>
      <Show when={props.mode === 'full'}>
        <div class="side-column" id={SIDE_COLUMN_ID}>
          <Sidebar />
          <CompanionDock />
        </div>
      </Show>
      <Show when={props.mode === 'rail'}>
        <div class="side-column rail" id={SIDE_COLUMN_ID}>
          <CompanionDock />
        </div>
      </Show>
      <Show when={props.mode === 'drawer'}>
        <Drawer />
      </Show>
    </>
  )
}

/**
 * Cajón de la barra lateral: fondo que cierra con un clic, foco atrapado, Esc cierra y el foco vuelve al botón
 * que lo abrió. Elegir una pestaña o un espacio lo cierra.
 */
function Drawer() {
  const { ui } = useModel()
  return (
    <Show when={ui.drawerOpen()}>
      <DrawerPanel onClose={() => ui.setDrawerOpen(false)} />
    </Show>
  )
}

function DrawerPanel(props: { onClose: () => void }) {
  let box!: HTMLDivElement
  let previous: Element | null = null
  onMount(() => {
    previous = document.activeElement
    box.focus()
  })
  onCleanup(() => {
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
  })
  return (
    <>
      <div class="drawer-backdrop" data-testid="drawer-backdrop" onPointerDown={props.onClose} />
      <div
        ref={box}
        class="side-column drawer"
        id={SIDE_COLUMN_ID}
        role="dialog"
        aria-modal="true"
        aria-label={es.sidebar.drawerLabel}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            props.onClose()
          } else trapTab(box, e)
        }}
        onClick={(e) => {
          if ((e.target as Element).closest('.ws-name, .tab-row') !== null) props.onClose()
        }}
      >
        <Sidebar onClose={props.onClose} />
        <CompanionDock />
      </div>
    </>
  )
}
