import type { ClientState, ResyncInfo, Snapshot } from '@nexo/client'
import {
  type Attention,
  type Layout,
  type Pane,
  PaneId,
  type Tab,
  TabId,
  TerminalId,
  type Workspace,
  WorkspaceId,
} from '@nexo/contracts'
import type { ClientLike } from './daemon/session.ts'
import type { StoreEvent } from './state/model.ts'
import type { XtermHandle } from './terminal/xterm-adapter.ts'

export const wid = (s: string) => WorkspaceId.parse(s)
export const tid = (s: string) => TabId.parse(s)
export const pid = (s: string) => PaneId.parse(s)
export const xid = (s: string) => TerminalId.parse(s)

export function mkPane(id: string, extra: Partial<Pane> = {}): Pane {
  return { id: pid(id), kind: 'terminal', title: `t-${id}`, attention: 'idle', ...extra }
}

export const leaf = (id: string): Layout => ({ type: 'leaf', paneId: pid(id) })

export function split(direction: 'row' | 'column', ...children: Layout[]): Layout {
  return {
    type: 'split',
    direction,
    children,
    ratios: children.map(() => 1 / children.length),
  }
}

/** Árbol lineal con los ids dados (todos en una fila). */
export function rowOf(...ids: string[]): Layout {
  const [only] = ids
  return ids.length === 1 && only !== undefined ? leaf(only) : split('row', ...ids.map(leaf))
}

export function mkTab(id: string, paneIds: string[] = [`${id}-p1`], extra: Partial<Tab> = {}): Tab {
  const first = paneIds[0] as string
  return {
    id: tid(id),
    title: `Pestaña ${id}`,
    layout: rowOf(...paneIds),
    panes: paneIds.map((p) => mkPane(p)),
    focusedPaneId: pid(first),
    ...extra,
  }
}

export function mkWorkspace(
  id: string,
  tabs: Tab[] = [],
  extra: Partial<Workspace> = {},
): Workspace {
  const first = tabs[0]
  return {
    id: wid(id),
    name: `Espacio ${id}`,
    tabs,
    ...(first === undefined ? {} : { activeTabId: first.id }),
    ...extra,
  }
}

export const snapshotOf = (workspaces: Workspace[], seq = 1): Snapshot => ({ seq, workspaces })

export function summaryOf(w: Workspace) {
  return {
    id: w.id,
    name: w.name,
    ...(w.cwd === undefined ? {} : { cwd: w.cwd }),
    ...(w.activeTabId === undefined ? {} : { activeTabId: w.activeTabId }),
    tabs: w.tabs.map((t) => ({ id: t.id, title: t.title })),
  }
}

export function layoutEvent(
  workspaceId: string,
  tab: Tab | null,
  seq: number,
  tabId?: string,
): StoreEvent {
  return {
    event: 'layout.changed',
    seq,
    data: {
      workspaceId: wid(workspaceId),
      tabId: tab?.id ?? tid(tabId ?? 'gone'),
      layout: tab?.layout ?? null,
      focusedPaneId: tab?.focusedPaneId ?? null,
      panes: tab?.panes ?? [],
    },
  }
}

export const workspaceEvent = (w: Workspace, seq: number): StoreEvent => ({
  event: 'workspace.changed',
  seq,
  data: { workspace: summaryOf(w) },
})

export const attentionEvent = (paneId: string, attention: Attention, seq: number): StoreEvent => ({
  event: 'pane.attention',
  seq,
  data: { paneId: pid(paneId), attention },
})

/** Planificador de fotogramas manual. */
export function manualFrames() {
  const queue: (() => void)[] = []
  return {
    frame: (cb: () => void) => void queue.push(cb),
    flush(max = 1000): number {
      let n = 0
      while (queue.length > 0 && n < max) {
        ;(queue.shift() as () => void)()
        n++
      }
      return n
    },
    get pending() {
      return queue.length
    },
  }
}

type Handler = (params: unknown) => unknown | Promise<unknown>

/** Cliente falso: registra llamadas, responde con manejadores y permite empujar eventos. */
export class FakeClient implements ClientLike {
  state: ClientState = 'connecting'
  readonly calls: { method: string; params: unknown }[] = []
  readonly handlers = new Map<string, Handler>()
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>()
  connectError: Error | undefined
  closed = false
  snapshot: Snapshot = { seq: 0, workspaces: [] }
  onSnapshot: ((s: Snapshot, i: ResyncInfo) => void) | undefined

  constructor() {
    this.handlers.set('snapshot', () => this.snapshot)
    this.handlers.set('terminal.read', () => ({ data: '', offset: 0 }))
    this.handlers.set('daemon.info', () => ({
      version: '9.9.9',
      protocol: 1,
      pid: 1,
      startedAt: 'ahora',
    }))
  }

  async connect(): Promise<void> {
    if (this.connectError !== undefined) throw this.connectError
    this.setState('open')
  }

  async subscribe(): Promise<{ seq: number }> {
    return { seq: 0 }
  }

  close(): void {
    this.closed = true
    this.setState('closed')
  }

  async call(method: string, params: unknown): Promise<never> {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)
    if (this.state !== 'open') throw new Error('sin conexión')
    return (handler === undefined ? {} : await handler(params)) as never
  }

  on(event: string, handler: (...args: never[]) => void): () => void {
    let set = this.#listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const h of [...(this.#listeners.get(event) ?? [])])
      (h as (...a: unknown[]) => void)(...args)
  }

  setState(state: ClientState): void {
    this.state = state
    this.emit('state', state)
  }

  callsOf(method: string) {
    return this.calls.filter((c) => c.method === method)
  }
}

/** xterm falso: guarda lo escrito y cuenta cargas de WebGL. */
export class FakeXterm implements XtermHandle {
  readonly element = document.createElement('div')
  cols = 80
  rows = 24
  webglActive = false
  webglLoads = 0
  webglDisposals = 0
  written: string[] = []
  notices: string[] = []
  resets = 0
  mounted: HTMLElement | undefined
  fitSize: { cols: number; rows: number } | undefined = { cols: 100, rows: 30 }
  disposed = false
  focused = 0
  searches: string[] = []
  #onData: (d: string) => void = () => {}
  #onResize: (s: { cols: number; rows: number }) => void = () => {}
  holdWrites = false
  pendingDone: (() => void)[] = []

  mount(host: HTMLElement): void {
    this.mounted = host
    host.appendChild(this.element)
  }
  unmount(): void {
    this.mounted = undefined
    this.element.remove()
  }
  fit() {
    if (this.fitSize !== undefined) {
      this.cols = this.fitSize.cols
      this.rows = this.fitSize.rows
    }
    return this.fitSize
  }
  onData(cb: (d: string) => void): void {
    this.#onData = cb
  }
  onResize(cb: (s: { cols: number; rows: number }) => void): void {
    this.#onResize = cb
  }
  setWebgl(on: boolean): void {
    if (on && !this.webglActive) {
      this.webglActive = true
      this.webglLoads++
    } else if (!on && this.webglActive) {
      this.webglActive = false
      this.webglDisposals++
    }
  }
  focus(): void {
    this.focused++
  }
  find(query: string, direction: 'next' | 'prev'): boolean {
    this.searches.push(`${direction}:${query}`)
    return true
  }
  clearSearch(): void {}
  notice(text: string): void {
    this.notices.push(text)
  }
  write(data: string, done: () => void): void {
    this.written.push(data)
    if (this.holdWrites) this.pendingDone.push(done)
    else done()
  }
  reset(): void {
    this.resets++
    this.written = []
  }
  dispose(): void {
    this.disposed = true
  }
  type(data: string): void {
    this.#onData(data)
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.#onResize({ cols, rows })
  }
}
