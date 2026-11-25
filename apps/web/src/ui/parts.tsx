import type { Attention } from '@nexo/contracts'
import { createMemo, type JSX, onMount, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es, format } from '../i18n/es.ts'
import { activeTabOf } from '../state/store.ts'
import './parts.css'

export function AttentionDot(props: { attention: Attention }) {
  return (
    <span
      class="attention-dot"
      data-attention={props.attention}
      role="img"
      aria-label={es.attention[props.attention]}
      title={es.attention[props.attention]}
    />
  )
}

/** Contador de pendientes (permisos y preguntas esperando respuesta); no se pinta con 0. */
export function AttentionCount(props: { count: number }) {
  return (
    <Show when={props.count > 0}>
      <span
        class="attention-count"
        role="img"
        aria-label={format(es.attention.pendingCount, { count: props.count })}
        title={format(es.attention.pendingCount, { count: props.count })}
      >
        {props.count > 99 ? '99+' : props.count}
      </span>
    </Show>
  )
}

/** Interruptor de las notificaciones del sistema (activar pide el permiso: cuelga de este clic). */
export function NotificationToggle() {
  const { notifications } = useModel()
  return (
    <button
      type="button"
      class="status-toggle"
      data-state={notifications.state()}
      aria-pressed={notifications.state() === 'on'}
      title={es.notifications.toggleHint}
      onClick={() => void notifications.toggle()}
    >
      {es.notifications[notifications.state()]}
    </button>
  )
}

/** Id del espacio visible: el elegido en la interfaz o, si ya no existe, el primero. */
export function useCurrentWorkspaceId() {
  const { store, ui } = useModel()
  return createMemo(() => {
    const chosen = ui.activeWorkspaceId()
    const list = store.state.workspaces
    return (list.find((w) => w.id === chosen) ?? list[0])?.id
  })
}

export function useCurrentTab() {
  const { store } = useModel()
  const id = useCurrentWorkspaceId()
  return createMemo(() => activeTabOf(store.state.workspaces.find((w) => w.id === id())))
}

/** Edición en línea: Intro confirma, Esc cancela, perder el foco confirma. */
export function InlineEdit(props: {
  value: string
  editing: boolean
  label: string
  onCommit: (value: string) => void
  onCancel: () => void
  children: JSX.Element
}) {
  return (
    <Show when={props.editing} fallback={props.children}>
      <EditField {...props} />
    </Show>
  )
}

function EditField(props: {
  value: string
  label: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  let input!: HTMLInputElement
  let done = false
  const finish = (commit: boolean) => {
    if (done) return
    done = true
    if (commit) props.onCommit(input.value)
    else props.onCancel()
  }
  onMount(() => {
    input.focus()
    input.select()
  })
  return (
    <input
      ref={input}
      class="inline-edit"
      value={props.value}
      aria-label={props.label}
      maxLength={256}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}
