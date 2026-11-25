import { parseArgv } from '../args.ts'
import type { Ctx } from '../context.ts'
import { usageError } from '../errors.ts'
import { shortId } from '../resolve.ts'
import { LsOutput } from '../schemas.ts'
import { sanitize } from '../text.ts'

export async function lsCommand(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  if (parsed.positionals.length > 0) throw usageError('uso: nexo ls [--json]')
  const client = await ctx.client()
  const { workspaces } = await client.call('workspace.list', {})
  const tree = {
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      ...(w.cwd === undefined ? {} : { cwd: w.cwd }),
      tabs: w.tabs.map((t) => ({
        id: t.id,
        title: t.title,
        active: w.activeTabId === t.id,
        panes: t.panes.map((p) => ({
          id: p.id,
          title: p.title,
          kind: p.kind,
          ...(p.terminalId === undefined ? {} : { terminalId: p.terminalId }),
          attention: p.attention,
          focused: t.focusedPaneId === p.id,
        })),
      })),
    })),
  }
  ctx.emit(LsOutput, tree, () => {
    if (tree.workspaces.length === 0) return 'No hay espacios. Crea uno con `nexo new`.'
    const lines: string[] = []
    for (const w of tree.workspaces) {
      const where = w.cwd === undefined ? '' : `  ${sanitize(w.cwd, 120)}`
      lines.push(`espacio ${shortId(w.id)}  ${sanitize(w.name, 80)}${where}`)
      for (const t of w.tabs) {
        lines.push(
          `  pestaña ${shortId(t.id)}  ${sanitize(t.title, 80)}${t.active ? '  *activa' : ''}`,
        )
        for (const p of t.panes) {
          const term = p.terminalId === undefined ? 'sin terminal' : shortId(p.terminalId)
          lines.push(
            `    panel ${shortId(p.id)}  ${p.kind}  ${term}  "${sanitize(p.title, 80)}"  ${p.attention}${p.focused ? '  *enfocado' : ''}`,
          )
        }
      }
    }
    return lines.join('\n')
  })
}
