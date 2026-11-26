import { type BlockDraft, LIMITS, sanitizeBodyText } from '@nexo/contracts'
import {
  CollabItem,
  CommandItem,
  DynamicToolItem,
  FileChange,
  FileChangeItem,
  ImageViewItem,
  McpItem,
  WebSearchItem,
} from './protocol.ts'
import { line, truncateUtf8 } from './text.ts'

export type ActionDraft = Extract<BlockDraft, { type: 'action' }>
type Status = ActionDraft['status']

const asInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(Math.round(v)) && v >= 0 ? Math.round(v) : undefined

const asExitCode = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(Math.trunc(v)) ? Math.trunc(v) : undefined

function statusOf(status: string | undefined, fallback: Status): Status {
  switch (status) {
    case 'inProgress':
      return 'running'
    case 'completed':
      return 'ok'
    case 'failed':
    case 'declined':
      return 'error'
    default:
      return fallback
  }
}

function body(text: string, max: number): { text: string; truncated: boolean } {
  return truncateUtf8(sanitizeBodyText(text), max)
}

/** Resumen de una línea de los cambios de un `fileChange` y su diff combinado. */
function describeChanges(changes: readonly FileChange[]): {
  title: string
  patch: string
  firstPath?: string
} {
  const first = changes[0]
  const verb = (c: FileChange) =>
    c.kind?.type === 'add' ? 'Crear' : c.kind?.type === 'delete' ? 'Eliminar' : 'Editar'
  let title = 'Editar archivos'
  if (changes.length === 1 && first !== undefined) title = `${verb(first)} ${first.path}`
  else if (changes.length > 1) title = `Editar ${changes.length} archivos`
  const patch =
    changes.length === 1
      ? (first?.diff ?? '')
      : changes.map((c) => `--- ${c.path}\n${c.diff ?? ''}`).join('\n')
  return { title, patch, ...(first === undefined ? {} : { firstPath: first.path }) }
}

export function parseChanges(raw: readonly unknown[]): FileChange[] {
  const out: FileChange[] = []
  for (const c of raw) {
    const p = FileChange.safeParse(c)
    if (p.success) out.push(p.data)
  }
  return out
}

function searchTitle(item: ReturnType<typeof WebSearchItem.parse>): string {
  const a = item.action
  if (a?.type === 'openPage' && a.url) return `Abrir ${a.url}`
  if (a?.type === 'findInPage') return `Buscar «${a.pattern ?? ''}» en ${a.url ?? 'la página'}`
  const query = item.query || a?.query || a?.queries?.join(' · ') || ''
  return query === '' ? 'Búsqueda web' : `Buscar: ${query}`
}

function mcpOutput(item: ReturnType<typeof McpItem.parse>): string | undefined {
  if (item.error) return item.error.message
  const content = item.result?.content
  if (content === undefined || content.length === 0) return undefined
  const texts: string[] = []
  for (const part of content) {
    if (typeof part === 'object' && part !== null && 'text' in part) {
      const t = (part as { text: unknown }).text
      if (typeof t === 'string') {
        texts.push(t)
        continue
      }
    }
    texts.push(JSON.stringify(part))
  }
  return texts.join('\n')
}

/**
 * Convierte un `ThreadItem` de Codex (comando, cambio de archivo, búsqueda, MCP...) en un bloque `action`.
 * `undefined` si el item no es una acción (mensajes, razonamiento, items internos). `accumulated` es la
 * salida ya recibida por deltas (para cuando el item final no la trae).
 */
export function actionDraft(
  raw: Record<string, unknown>,
  options: { accumulated?: string; finished: boolean },
): ActionDraft | undefined {
  const id = typeof raw.id === 'string' ? line(raw.id, 128) : undefined
  const callId = id === undefined || id === '' ? {} : { callId: id }
  const fallback: Status = options.finished ? 'ok' : 'running'
  const max = LIMITS.maxBlockTextBytes
  switch (raw.type) {
    case 'commandExecution': {
      const p = CommandItem.safeParse(raw)
      if (!p.success) return undefined
      const c = p.data
      let status = statusOf(c.status, fallback)
      const exitCode = asExitCode(c.exitCode)
      if (status === 'ok' && exitCode !== undefined && exitCode !== 0) status = 'error'
      const out = body(c.aggregatedOutput ?? options.accumulated ?? '', max)
      const duration = asInt(c.durationMs)
      return {
        type: 'action',
        kind: 'exec',
        status,
        tool: 'shell',
        title: line(`Ejecutar: ${c.command}`, 200, 'Ejecutar un comando'),
        ...callId,
        input: body(c.command, LIMITS.maxBlockInputBytes).text,
        ...(out.text === '' ? {} : { output: out.text }),
        ...(status === 'running' || exitCode === undefined ? {} : { exitCode }),
        ...(duration === undefined ? {} : { durationMs: duration }),
        ...(out.truncated ? { truncated: true } : {}),
      }
    }
    case 'fileChange': {
      const p = FileChangeItem.safeParse(raw)
      if (!p.success) return undefined
      const changes = parseChanges(p.data.changes)
      const d = describeChanges(changes)
      const patch = body(d.patch, max)
      const path = line(d.firstPath ?? '', LIMITS.maxPathLength)
      return {
        type: 'action',
        kind: 'edit',
        status: statusOf(p.data.status, fallback),
        tool: 'apply_patch',
        title: line(d.title, LIMITS.maxTitleLength, 'Editar archivos'),
        ...callId,
        ...(path === '' ? {} : { path, diff: { path, patch: patch.text } }),
        ...(patch.truncated ? { truncated: true } : {}),
      }
    }
    case 'webSearch': {
      const p = WebSearchItem.safeParse(raw)
      if (!p.success) return undefined
      return {
        type: 'action',
        kind: 'search',
        status: fallback,
        tool: 'web_search',
        title: line(searchTitle(p.data), LIMITS.maxTitleLength, 'Búsqueda web'),
        ...callId,
        ...(p.data.query ? { input: body(p.data.query, LIMITS.maxBlockInputBytes).text } : {}),
      }
    }
    case 'mcpToolCall': {
      const p = McpItem.safeParse(raw)
      if (!p.success) return undefined
      const m = p.data
      const args =
        m.arguments === undefined || m.arguments === null ? undefined : JSON.stringify(m.arguments)
      const out = mcpOutput(m)
      const output = out === undefined ? undefined : body(out, max)
      const duration = asInt(m.durationMs)
      return {
        type: 'action',
        kind: 'other',
        status: statusOf(m.status, fallback),
        tool: line(`mcp__${m.server}__${m.tool}`, 128, 'mcp'),
        title: line(`${m.server}: ${m.tool}`, LIMITS.maxTitleLength, 'Herramienta MCP'),
        ...callId,
        ...(args === undefined ? {} : { input: body(args, LIMITS.maxBlockInputBytes).text }),
        ...(output === undefined || output.text === '' ? {} : { output: output.text }),
        ...(duration === undefined ? {} : { durationMs: duration }),
        ...(output?.truncated ? { truncated: true } : {}),
      }
    }
    case 'dynamicToolCall': {
      const p = DynamicToolItem.safeParse(raw)
      if (!p.success) return undefined
      const d = p.data
      const name = d.namespace ? `${d.namespace}__${d.tool}` : d.tool
      let status = statusOf(d.status, fallback)
      if (status === 'ok' && d.success === false) status = 'error'
      const args =
        d.arguments === undefined || d.arguments === null ? undefined : JSON.stringify(d.arguments)
      return {
        type: 'action',
        kind: 'other',
        status,
        tool: line(name, 128, 'tool'),
        title: line(`Herramienta: ${name}`, LIMITS.maxTitleLength),
        ...callId,
        ...(args === undefined ? {} : { input: body(args, LIMITS.maxBlockInputBytes).text }),
      }
    }
    case 'collabAgentToolCall': {
      const p = CollabItem.safeParse(raw)
      if (!p.success) return undefined
      return {
        type: 'action',
        kind: 'other',
        status: statusOf(p.data.status, fallback),
        tool: line(`collab_${p.data.tool}`, 128),
        title: line(`Subagente: ${p.data.tool}`, LIMITS.maxTitleLength),
        ...callId,
        ...(p.data.prompt ? { input: body(p.data.prompt, LIMITS.maxBlockInputBytes).text } : {}),
      }
    }
    case 'imageView': {
      const p = ImageViewItem.safeParse(raw)
      if (!p.success) return undefined
      return {
        type: 'action',
        kind: 'read',
        status: fallback,
        tool: 'view_image',
        title: line(`Ver imagen: ${p.data.path}`, LIMITS.maxTitleLength),
        ...callId,
        ...(line(p.data.path, LIMITS.maxPathLength) === ''
          ? {}
          : { path: line(p.data.path, LIMITS.maxPathLength) }),
      }
    }
    default:
      return undefined
  }
}
