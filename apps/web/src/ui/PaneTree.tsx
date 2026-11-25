import type { Layout, PaneId, SplitDirection } from '@nexo/contracts'
import {
  type Accessor,
  createContext,
  createEffect,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  useContext,
} from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import { type DividerTarget, dividerTarget } from '../layout/tree.ts'
import { PaneView } from './PaneView.tsx'
import './PaneTree.css'

export const MIN_PERCENT = 5
const KEY_STEP = 0.02
const KEY_STEP_BIG = 0.1

export function LayoutView(props: { node: Layout }) {
  return (
    <Switch>
      <Match when={props.node.type === 'leaf' && props.node}>
        {(leaf) => <PaneView paneId={(leaf() as { paneId: PaneId }).paneId} />}
      </Match>
      <Match when={props.node.type === 'split' && props.node}>
        {(split) => (
          <SplitView
            node={
              split() as {
                direction: SplitDirection
                children: Layout[]
                ratios: number[]
              }
            }
          />
        )}
      </Match>
    </Switch>
  )
}

function SplitView(props: {
  node: { direction: SplitDirection; children: Layout[]; ratios: number[] }
}) {
  let container!: HTMLDivElement
  const row = () => props.node.direction === 'row'
  return (
    <div class="split" classList={{ row: row(), column: !row() }} ref={container}>
      <For each={props.node.children}>
        {(child, i) => (
          <>
            <Show when={i() > 0}>
              <Divider
                direction={props.node.direction}
                index={i() - 1}
                siblings={props.node.children}
                ratios={props.node.ratios}
                container={() => container}
              />
            </Show>
            <div class="split-child" style={{ flex: `${props.node.ratios[i()] ?? 1} 1 0%` }}>
              <LayoutView node={child} />
            </div>
          </>
        )}
      </For>
    </div>
  )
}

function Divider(props: {
  direction: SplitDirection
  index: number
  siblings: Layout[]
  ratios: number[]
  container: () => HTMLElement
}) {
  const { actions, status } = useModel()
  const target = (): DividerTarget | undefined => dividerTarget(props.siblings, props.index)
  const vertical = () => props.direction === 'row'
  const percent = () => Math.round((props.ratios[props.index] ?? 0) * 100)
  let drag: { start: number; sent: number; size: number; target: DividerTarget } | undefined
  let el!: HTMLHRElement

  const send = (fraction: number) => {
    const t = drag?.target ?? target()
    if (t === undefined) return
    void actions.resizePane(t.paneId, fraction * t.sign)
  }

  const end = () => {
    drag = undefined
    el.classList.remove('dragging')
  }

  // Si se pierde la conexión a mitad de un arrastre, se suelta el divisor.
  createEffect(() => {
    if (status() !== 'open') end()
  })
  onCleanup(() => {
    drag = undefined
  })

  const position = (e: PointerEvent) => (vertical() ? e.clientX : e.clientY)

  return (
    <hr
      ref={el}
      class="divider"
      classList={{
        vertical: vertical(),
        horizontal: !vertical(),
        disabled: target() === undefined,
      }}
      aria-orientation={vertical() ? 'vertical' : 'horizontal'}
      aria-label={es.pane.resizeSeparator}
      aria-valuemin={MIN_PERCENT}
      aria-valuemax={100 - MIN_PERCENT}
      aria-valuenow={percent()}
      aria-disabled={target() === undefined ? 'true' : undefined}
      tabIndex={target() === undefined ? -1 : 0}
      onPointerDown={(e) => {
        const t = target()
        if (t === undefined || status() !== 'open' || e.button !== 0) return
        const rect = props.container().getBoundingClientRect()
        const size = vertical() ? rect.width : rect.height
        if (size <= 0) return
        e.preventDefault()
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // sin captura de puntero (p. ej. jsdom)
        }
        drag = { start: position(e), sent: 0, size, target: t }
        el.classList.add('dragging')
      }}
      onPointerMove={(e) => {
        if (drag === undefined) return
        const total = (position(e) - drag.start) / drag.size
        const delta = total - drag.sent
        if (Math.abs(delta) < 0.001) return
        drag.sent = total
        send(delta)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        const back = vertical() ? 'ArrowLeft' : 'ArrowUp'
        const forward = vertical() ? 'ArrowRight' : 'ArrowDown'
        if (e.key !== back && e.key !== forward) return
        e.preventDefault()
        const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP
        send(e.key === forward ? step : -step)
      }}
    />
  )
}
