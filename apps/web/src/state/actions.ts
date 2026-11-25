import {
  LIMITS,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type PaneId,
  type SplitDirection,
  type TabId,
  type TerminalId,
  type WorkspaceId,
} from '@nexo/contracts'
import { es, format } from '../i18n/es.ts'
import { measureTabSwitch } from '../perf.ts'
import { type AppStore, findPaneTab, findWorkspace } from './store.ts'
import type { UiState } from './ui.ts'

export type CallClient = {
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>
}

/** Texto apto para un nombre: sin caracteres de control, recortado y con tope; `undefined` si queda vacío. */
export function cleanName(text: string): string | undefined {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? ' ' : ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > LIMITS.maxTitleLength) out = out.slice(0, LIMITS.maxTitleLength).trim()
  return out === '' ? undefined : out
}

/** Trozos de como máximo `maxChars` unidades UTF-16 sin partir un par sustituto. */
export function chunkText(data: string, maxChars: number): string[] {
  if (data.length <= maxChars) return data === '' ? [] : [data]
  const out: string[] = []
  let i = 0
  while (i < data.length) {
    let end = Math.min(i + maxChars, data.length)
    const code = data.charCodeAt(end - 1)
    if (end < data.length && code >= 0xd800 && code <= 0xdbff) end--
    out.push(data.slice(i, end))
    i = end
  }
  return out
}

/** `terminal.write` admite 64 KiB UTF-8: 16 000 unidades UTF-16 caben siempre (≤ 4 bytes cada par). */
const WRITE_CHUNK_CHARS = 16_000

export type Actions = ReturnType<typeof createActions>

/** Órdenes del usuario hacia el daemon. Todas pasan por `@nexo/client`, que valida con zod. */
export function createActions(deps: {
  client: () => CallClient | undefined
  store: AppStore
  ui: UiState
}) {
  const { store, ui } = deps
  const spawning = new Set<string>()

  async function run<T>(fn: (c: CallClient) => Promise<T>): Promise<T | undefined> {
    const client = deps.client()
    if (client === undefined) return undefined
    try {
      return await fn(client)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ui.showError(format(es.errors.generic, { message }))
      return undefined
    }
  }

  function currentWorkspaceId(): WorkspaceId | undefined {
    const s = store.snapshot()
    const chosen = findWorkspace(s, ui.activeWorkspaceId())
    return (chosen ?? s.workspaces[0])?.id
  }

  const actions = {
    currentWorkspaceId,

    async newWorkspace(): Promise<void> {
      const n = store.snapshot().workspaces.length + 1
      const created = await run((c) =>
        c.call('workspace.create', { name: `${es.sidebar.workspaceDefaultName} ${n}` }),
      )
      if (created === undefined) return
      ui.setActiveWorkspaceId(created.workspace.id)
      await run((c) => c.call('tab.create', { workspaceId: created.workspace.id }))
    },

    async renameWorkspace(workspaceId: WorkspaceId, name: string): Promise<void> {
      const clean = cleanName(name)
      if (clean === undefined) return
      await run((c) => c.call('workspace.rename', { workspaceId, name: clean }))
    },

    async closeWorkspace(workspaceId: WorkspaceId): Promise<void> {
      await run((c) => c.call('workspace.close', { workspaceId }))
    },

    async newTab(workspaceId: WorkspaceId | undefined = currentWorkspaceId()): Promise<void> {
      if (workspaceId === undefined) return
      await run((c) => c.call('tab.create', { workspaceId }))
    },

    async renameTab(tabId: TabId, title: string): Promise<void> {
      const clean = cleanName(title)
      if (clean === undefined) return
      await run((c) => c.call('tab.rename', { tabId, title: clean }))
    },

    async closeTab(tabId: TabId): Promise<void> {
      await run((c) => c.call('tab.close', { tabId }))
    },

    /** Cambio inmediato en local (con la marca `tab-switch`) y aviso al daemon. */
    async selectTab(workspaceId: WorkspaceId, tabId: TabId): Promise<void> {
      measureTabSwitch(() => {
        ui.setActiveWorkspaceId(workspaceId)
        store.setActiveTab(workspaceId, tabId)
      })
      await run((c) => c.call('tab.focus', { tabId }))
    },

    selectWorkspace(workspaceId: WorkspaceId): void {
      ui.setActiveWorkspaceId(workspaceId)
    },

    async focusPane(paneId: PaneId): Promise<void> {
      const found = findPaneTab(store.snapshot(), paneId)
      if (found === undefined || found.tab.focusedPaneId === paneId) return
      store.setFocusedPane(paneId)
      await run((c) => c.call('pane.focus', { paneId }))
    },

    async splitPane(paneId: PaneId, direction: SplitDirection): Promise<void> {
      await run((c) => c.call('pane.split', { paneId, direction }))
    },

    async closePane(paneId: PaneId): Promise<void> {
      await run((c) => c.call('pane.close', { paneId }))
    },

    async resizePane(paneId: PaneId, delta: number): Promise<void> {
      if (!Number.isFinite(delta) || delta === 0) return
      await run((c) => c.call('pane.resize', { paneId, delta: Math.max(-1, Math.min(1, delta)) }))
    },

    async swapPanes(paneId: PaneId, otherPaneId: PaneId): Promise<void> {
      if (paneId === otherPaneId) return
      await run((c) => c.call('pane.swap', { paneId, otherPaneId }))
    },

    /** Crea la terminal del panel (una sola vez a la vez por panel). */
    async spawn(paneId: PaneId, cols: number, rows: number): Promise<void> {
      if (spawning.has(paneId)) return
      spawning.add(paneId)
      try {
        await run((c) => c.call('terminal.spawn', { paneId, cols, rows }))
      } finally {
        spawning.delete(paneId)
      }
    },

    async write(terminalId: TerminalId, data: string): Promise<void> {
      for (const part of chunkText(data, WRITE_CHUNK_CHARS)) {
        await run((c) => c.call('terminal.write', { terminalId, data: part }))
      }
    },

    async resizeTerminal(terminalId: TerminalId, cols: number, rows: number): Promise<void> {
      await run((c) => c.call('terminal.resize', { terminalId, cols, rows }))
    },
  }
  return actions
}
