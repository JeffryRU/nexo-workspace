import { type ActionKind, LIMITS } from '@nexo/contracts'
import { body, line } from './text.ts'

const KINDS: Readonly<Record<string, ActionKind>> = {
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'exec',
  PowerShell: 'exec',
  Grep: 'search',
  Glob: 'search',
}

/** Clase de acción normalizada de una herramienta de Claude Code; las desconocidas (MCP, nuevas) son `other`. */
export function inferKind(tool: string): ActionKind {
  return Object.hasOwn(KINDS, tool) ? (KINDS[tool] as ActionKind) : 'other'
}

type Json = Record<string, unknown>

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export type ToolDescription = {
  title: string
  path?: string
  /** JSON de la entrada, acotado. */
  input?: string
  diff?: { path: string; patch: string }
}

function patchLines(prefix: '-' | '+', text: string): string {
  return text
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n')
}

/** Diff unificado mínimo (sin contexto) de un reemplazo; suficiente para mostrar el cambio. */
export function editPatch(path: string, pairs: readonly { old: string; next: string }[]): string {
  const hunks = pairs.map((p) => {
    const parts = [`@@ ${p.old.split('\n').length} -> ${p.next.split('\n').length} @@`]
    if (p.old !== '') parts.push(patchLines('-', p.old))
    if (p.next !== '') parts.push(patchLines('+', p.next))
    return parts.join('\n')
  })
  return `--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}`
}

function stringify(input: unknown): string | undefined {
  try {
    const json = JSON.stringify(input)
    return json === undefined ? undefined : json
  } catch {
    return undefined
  }
}

/** Título, ruta, entrada acotada y diff de una llamada a herramienta, a partir de su entrada cruda. */
export function describeTool(tool: string, input: unknown): ToolDescription {
  const data = isRecord(input) ? input : {}
  const filePath = str(data.file_path) ?? str(data.notebook_path) ?? str(data.path)
  const pathText = filePath === undefined ? undefined : line(filePath, LIMITS.maxPathLength)
  const path = pathText === '' ? undefined : pathText
  const json = stringify(input)
  const base = {
    ...(path === undefined ? {} : { path }),
    ...(json === undefined ? {} : { input: body(json, LIMITS.maxBlockInputBytes).text }),
  }
  const title = (text: string) => line(text, LIMITS.maxTitleLength, tool)

  switch (tool) {
    case 'Read':
      return { ...base, title: title(`Leer ${path ?? 'archivo'}`) }
    case 'Edit': {
      const old = str(data.old_string) ?? ''
      const next = typeof data.new_string === 'string' ? data.new_string : ''
      return {
        ...base,
        title: title(`Editar ${path ?? 'archivo'}`),
        ...(path === undefined ? {} : { diff: { path, patch: editPatch(path, [{ old, next }]) } }),
      }
    }
    case 'MultiEdit': {
      const edits = Array.isArray(data.edits) ? data.edits.filter(isRecord) : []
      const pairs = edits.map((e) => ({
        old: typeof e.old_string === 'string' ? e.old_string : '',
        next: typeof e.new_string === 'string' ? e.new_string : '',
      }))
      return {
        ...base,
        title: title(`Editar ${path ?? 'archivo'}`),
        ...(path === undefined || pairs.length === 0
          ? {}
          : { diff: { path, patch: editPatch(path, pairs) } }),
      }
    }
    case 'Write': {
      const content = typeof data.content === 'string' ? data.content : ''
      return {
        ...base,
        title: title(`Escribir ${path ?? 'archivo'}`),
        ...(path === undefined
          ? {}
          : { diff: { path, patch: editPatch(path, [{ old: '', next: content }]) } }),
      }
    }
    case 'Bash':
    case 'PowerShell':
      return {
        ...base,
        title: title(str(data.description) ?? str(data.command) ?? 'Ejecutar un comando'),
      }
    case 'Grep':
      return { ...base, title: title(`Buscar ${str(data.pattern) ?? 'texto'}`) }
    case 'Glob':
      return { ...base, title: title(`Buscar archivos ${str(data.pattern) ?? ''}`) }
    default:
      return { ...base, title: title(tool) }
  }
}

/** Código de salida que Claude Code escribe al inicio del resultado de un comando fallido (`Exit code 2`). */
export function parseExitCode(output: string): number | undefined {
  const m = /^Exit code (\d{1,5})\b/.exec(output)
  return m === null ? undefined : Number(m[1])
}
