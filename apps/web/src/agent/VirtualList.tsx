import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import { es } from '../i18n/es.ts'
import { VirtualModel } from './virtual-model.ts'

export type VirtualListApi = {
  /** Lleva el elemento `index` a la vista (y deja de seguir el final). */
  scrollToIndex(index: number): void
  scrollToEnd(): void
}

/** Distancia al final (px) a partir de la cual se considera que el usuario subió. */
const STICK_THRESHOLD = 32
const OVERSCAN = 600
/** Alto que se supone cuando el contenedor no tiene layout (oculto, o jsdom). */
const FALLBACK_VIEWPORT = 600

type Props = {
  ids: readonly string[]
  estimate: (id: string) => number
  renderItem: (id: string, index: number) => JSX.Element
  /** Función que programa un callback en el siguiente fotograma (inyectable en pruebas). */
  frame?: (cb: () => void) => void
  label: string
  busy?: boolean
  api?: (api: VirtualListApi) => void
}

const defaultFrame = (cb: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb())
  else setTimeout(cb, 16)
}

/**
 * Lista virtualizada con alturas variables: solo se dibujan los elementos a la vista (más un colchón). Sigue
 * el final mientras llega contenido salvo que el usuario haya subido. Es un `feed` ARIA: cada elemento lleva
 * su posición y el total porque la mayoría no está en el DOM.
 */
export function VirtualList(props: Props) {
  const frame = () => props.frame ?? defaultFrame
  const model = new VirtualModel((id) => props.estimate(id))
  const [version, setVersion] = createSignal(0)
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewport, setViewport] = createSignal(FALLBACK_VIEWPORT)
  const [stuck, setStuck] = createSignal(true)
  let scroller!: HTMLDivElement
  let observer: ResizeObserver | undefined
  let scheduled = false
  let dirtyHeights = false
  let pendingAdjust = 0
  /** Último `scrollTop` conocido: sirve para distinguir que el usuario subió de que el contenido creció. */
  let lastTop = 0

  const win = createMemo(() => {
    version()
    model.setIds(props.ids)
    return model.window(scrollTop(), viewport(), OVERSCAN)
  })
  const visible = createMemo(() => model.slice(win().start, win().end))

  /**
   * Una pestaña oculta (`hidden`, `display: none`) no tiene layout: `scrollHeight` es 0 y mover el scroll llevaría la
   * ventana al principio del documento. Al mostrarla de nuevo habría que montar otra vez ~50 bloques de golpe (lo que
   * encarecía el cambio de pestaña con agentes activos). Mientras está oculta se deja la ventana donde estaba.
   */
  const isHidden = () => scroller.closest('[hidden]') !== null

  const toEnd = () => {
    if (isHidden()) return
    scroller.scrollTop = scroller.scrollHeight
    lastTop = scroller.scrollTop
    setScrollTop(lastTop)
  }

  const flush = () => {
    scheduled = false
    if (isHidden()) {
      pendingAdjust = 0
      return
    }
    if (dirtyHeights) {
      dirtyHeights = false
      setVersion((v) => v + 1)
    }
    if (stuck()) toEnd()
    else if (pendingAdjust !== 0) {
      scroller.scrollTop += pendingAdjust
      setScrollTop(scroller.scrollTop)
    }
    pendingAdjust = 0
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    frame()(flush)
  }

  const onResize = (entries: ResizeObserverEntry[]) => {
    const first = model.indexAt(scrollTop())
    for (const e of entries) {
      const el = e.target as HTMLElement
      const id = el.dataset.id
      if (id === undefined) continue
      // Oculto (`display: none`): no hay medida real; se conserva la estimación.
      const h = el.offsetHeight
      const delta = model.measure(id, h)
      if (delta === 0) continue
      dirtyHeights = true
      if (model.indexOf(id) < first) pendingAdjust += delta
    }
    if (dirtyHeights) schedule()
  }

  const readViewport = () => {
    const h = scroller.clientHeight
    if (h > 0) setViewport(h)
  }

  onMount(() => {
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onResize)
      const container = new ResizeObserver(() => {
        readViewport()
        if (stuck()) schedule()
      })
      container.observe(scroller)
      onCleanup(() => container.disconnect())
    }
    readViewport()
    props.api?.({
      scrollToIndex(index) {
        setStuck(false)
        const top = model.offsetOf(index)
        scroller.scrollTop = top
        setScrollTop(top)
        setVersion((v) => v + 1)
      },
      scrollToEnd() {
        setStuck(true)
        schedule()
      },
    })
  })
  onCleanup(() => observer?.disconnect())

  // Más contenido (bloques nuevos o más alto): si seguimos el final, se baja.
  createEffect(() => {
    props.ids.length
    if (stuck()) schedule()
  })

  const onScroll = () => {
    const top = scroller.scrollTop
    setScrollTop(top)
    const previous = lastTop
    lastTop = top
    const distance = scroller.scrollHeight - top - scroller.clientHeight
    // Sin layout (jsdom) no hay nada que decidir.
    if (!Number.isFinite(distance) || scroller.clientHeight <= 0) return
    if (distance <= STICK_THRESHOLD) setStuck(true)
    // Solo subir desengancha: que el contenido crezca por debajo (el `scroll` programático llega después de
    // que el contenido ya creció) no es una acción del usuario.
    else if (top < previous - 1) setStuck(false)
  }

  return (
    <div class="vlist-wrap">
      <div
        ref={scroller}
        class="vlist"
        role="feed"
        aria-label={props.label}
        aria-busy={props.busy === true}
        onScroll={onScroll}
      >
        <div
          style={{ 'padding-top': `${win().padTop}px`, 'padding-bottom': `${win().padBottom}px` }}
        >
          <For each={visible()}>
            {(id) => {
              let el!: HTMLDivElement
              onMount(() => observer?.observe(el))
              onCleanup(() => observer?.unobserve(el))
              const index = () => model.indexOf(id)
              return (
                <article
                  ref={el}
                  class="vitem"
                  data-id={id}
                  aria-posinset={index() + 1}
                  aria-setsize={props.ids.length}
                >
                  {props.renderItem(id, index())}
                </article>
              )
            }}
          </For>
        </div>
      </div>
      <Show when={!stuck() && props.ids.length > 0}>
        <button
          type="button"
          class="vlist-end"
          onClick={() => {
            setStuck(true)
            schedule()
          }}
        >
          {es.agent.jumpToEnd}
        </button>
      </Show>
    </div>
  )
}
