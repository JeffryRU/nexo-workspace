import type { Layout, PaneId, SplitDirection, TabId } from '@nexo/contracts'
import { createEffect, For, Match, onCleanup, Show, Switch } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import { type DividerAddress, dividerAddress, dividerPercent } from '../layout/tree.ts'
import { PaneView } from './PaneView.tsx'
import './PaneTree.css'

export const MIN_PERCENT = 5
const KEY_STEP = 0.02
const KEY_STEP_BIG = 0.1

type Where = { tabId: TabId; path: readonly number[] }

export function LayoutView(props: { node: Layout } & Where) {
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
            tabId={props.tabId}
            path={props.path}
          />
        )}
      </Match>
    </Switch>
  )
}

function SplitView(
  props: {
    node: { direction: SplitDirection; children: Layout[]; ratios: number[] }
  } & Where,
) {
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
                tabId={props.tabId}
                path={props.path}
                ratios={props.node.ratios}
                container={() => container}
              />
            </Show>
            <div class="split-child" style={{ flex: `${props.node.ratios[i()] ?? 1} 1 0%` }}>
              <LayoutView node={child} tabId={props.tabId} path={[...props.path, i()]} />
            </div>
          </>
        )}
      </For>
    </div>
  )
}

function Divider(
  props: {
    direction: SplitDirection
    index: number
    ratios: number[]
    container: () => HTMLElement
  } & Where,
) {
  const { actions, status } = useModel()
  const target = (): DividerAddress | undefined => dividerAddress(props.path, props.index)
  const vertical = () => props.direction === 'row'
  const percent = () => dividerPercent(props.ratios, props.index)
  let drag: { start: number; sent: number; size: number; target: DividerAddress } | undefined
  let el!: HTMLHRElement

  const send = (fraction: number) => {
    const t = drag?.target ?? target()
    if (t === undefined) return
    void actions.resizeDivider(props.tabId, t.path, t.index, fraction)
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
      }}
      aria-orientation={vertical() ? 'vertical' : 'horizontal'}
      aria-label={es.pane.resizeSeparator}
      aria-valuemin={MIN_PERCENT}
      aria-valuemax={100 - MIN_PERCENT}
      aria-valuenow={percent()}
      tabIndex={0}
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
