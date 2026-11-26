import { resolve } from 'node:path'
import { PaneId, TabId, type Workspace } from '@nexo/contracts'
import { expectPositionals, parseArgv, str } from '../args.ts'
import type { Ctx } from '../context.ts'
import { notFoundError, usageError } from '../errors.ts'
import { resolveRef, validateRef } from '../resolve.ts'
import { OpenOutput } from '../schemas.ts'
import { sanitize } from '../text.ts'

const USAGE = 'nexo open <ruta> [--pane <panel>]'

const within = (root: string, path: string): boolean => {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  const r = norm(root)
  const p = norm(path)
  return p === r || p.startsWith(`${r}/`)
}

/** El espacio cuya carpeta contiene la ruta (el de carpeta más específica); si ninguno, el primero. */
function pickWorkspace(workspaces: readonly Workspace[], path: string): Workspace | undefined {
  const usable = workspaces.filter((w) => w.tabs.length > 0)
  let best: Workspace | undefined
  for (const w of usable) {
    if (w.cwd === undefined || !within(w.cwd, path)) continue
    if (best === undefined || w.cwd.length > (best.cwd?.length ?? 0)) best = w
  }
  return best ?? usable[0]
}

/**
 * Abre un archivo en el visor del panel: reutiliza el visor de la pestaña (`viewer.open`) o, si no hay,
 * divide un panel con uno nuevo (`pane.split` con `kind: viewer`). Las rutas relativas se resuelven contra la
 * carpeta actual; que la ruta sea legible lo comprueba el daemon (`fs.stat`).
 */
export async function openCommand(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { pane: { type: 'string' } })
  const [raw] = expectPositionals(parsed, 1, 1, USAGE) as [string]
  if (raw === '' || raw.includes('\0')) throw usageError('ruta no válida')
  const path = resolve(ctx.deps.cwd(), raw)
  const paneRef = str(parsed, 'pane')
  if (paneRef !== undefined) validateRef(paneRef)

  const client = await ctx.client()
  const st = await client.call('fs.stat', { path })
  if (st.kind === 'directory') throw usageError('es una carpeta: el visor abre archivos')
  const { workspaces } = await client.call('workspace.list', {})

  let workspace: Workspace | undefined
  let tab: Workspace['tabs'][number] | undefined
  let source: string | undefined
  if (paneRef !== undefined) {
    const entity = resolveRef(workspaces, paneRef, ['pane'])
    workspace = workspaces.find((w) => w.id === entity.workspaceId)
    tab = workspace?.tabs.find((t) => t.id === entity.tabId)
    source = entity.id
  } else {
    workspace = pickWorkspace(workspaces, path)
    tab = workspace?.tabs.find((t) => t.id === workspace?.activeTabId) ?? workspace?.tabs[0]
    source = tab?.focusedPaneId
  }
  if (tab === undefined || source === undefined) {
    throw notFoundError('no hay ningún panel abierto donde mostrarlo (crea uno con `nexo new`)')
  }
  const sourcePane = tab.panes.find((p) => p.id === source)
  const viewer =
    sourcePane?.kind === 'viewer' ? sourcePane : tab.panes.find((p) => p.kind === 'viewer')

  let paneId: string
  let created = false
  if (viewer !== undefined) {
    await client.call('viewer.open', { paneId: PaneId.parse(viewer.id), path: st.path })
    paneId = viewer.id
  } else {
    const split = await client.call('pane.split', {
      paneId: PaneId.parse(source),
      direction: 'row',
      kind: 'viewer',
      path: st.path,
    })
    paneId = split.pane.id
    created = true
  }
  await client.call('tab.focus', { tabId: TabId.parse(tab.id) })
  await client.call('pane.focus', { paneId: PaneId.parse(paneId) })
  ctx.emit(
    OpenOutput,
    { paneId, tabId: tab.id, path: st.path, created },
    () => `${created ? 'creado' : 'actualizado'} el visor ${paneId}: ${sanitize(st.path, 300)}`,
  )
}
