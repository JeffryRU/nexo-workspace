import { type ActionKind, LIMITS } from '@nexo/contracts'
import { line, truncateUtf8 } from './text.ts'

/**
 * Herramientas de `agy` → clase de acción, título, ruta, entrada y diff. De la documentación solo consta el
 * nombre canónico `run_command` (con `CommandLine`) y que existe `write_to_file`; los demás nombres y
 * parámetros son los de las herramientas de Antigravity que conocemos y NO están verificados contra un turno
 * real (ver ARCHITECTURE). Por eso la búsqueda de parámetros es tolerante y lo desconocido cae en `other`
 * con el nombre de la herramienta como título.
 */

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const EXEC = /^(run_command|command_status|send_command_input|terminal|shell|bash|execute)/i
const EDIT = /(write|replace|edit|patch|create|delete|rename|move)_?(to_)?(file|content)?/i
const READ = /^(view|read|list|open)_?/i
const SEARCH = /^(grep|find|search|glob|codebase)/i

/** Clase normalizada de una herramienta; las desconocidas son `other`. */
export function kindOf(tool: string): ActionKind {
  if (EXEC.test(tool)) return 'exec'
  if (SEARCH.test(tool)) return 'search'
  if (READ.test(tool) && !/url|web|browser/i.test(tool)) return 'read'
  if (EDIT.test(tool) && /(file|content|edit|patch)/i.test(tool)) return 'edit'
  return 'other'
}

function firstString(data: Json, keys: readonly string[]): string | undefined {
  for (const wanted of keys) {
    for (const [key, value] of Object.entries(data)) {
      if (key.toLowerCase() === wanted.toLowerCase() && typeof value === 'string' && value !== '') {
        return value
      }
    }
  }
  return undefined
}

const PATH_KEYS = [
  'TargetFile',
  'AbsolutePath',
  'FilePath',
  'File',
  'file_path',
  'path',
  'target_file',
  'DirectoryPath',
  'SearchPath',
  'SearchDirectory',
]
const COMMAND_KEYS = ['CommandLine', 'command', 'cmd']

/** Ruta relativa a `cwd` si está dentro; si no, la original (con `/`). */
export function relativeTo(cwd: string, file: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const base = norm(cwd).replace(/\/+$/, '')
  const f = norm(file)
  const windows = /^[A-Za-z]:\//.test(base)
  const a = windows ? f.toLowerCase() : f
  const b = windows ? base.toLowerCase() : base
  if (base !== '' && a.startsWith(`${b}/`)) return f.slice(base.length + 1)
  return f
}

/** Quita la carpeta de la sesión de las rutas dentro del JSON de la entrada (solo se muestra; con `/` o con `\\` escapada). */
function stripCwd(json: string, cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, '')
  if (base === '') return json
  const forward = `${base.replace(/\\/g, '/')}/`
  const escaped = `${base.replace(/\\/g, '\\\\')}\\\\`
  return json.split(forward).join('').split(escaped).join('')
}

function lineCount(text: string): number {
  if (text === '') return 0
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length
}

function patchLines(prefix: '-' | '+', text: string): string {
  // Un salto de línea final no es una línea más: `a\n` es una línea, no dos.
  return (text.endsWith('\n') ? text.slice(0, -1) : text)
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n')
}

/** Diff unificado mínimo (sin contexto) de reemplazos; suficiente para mostrar el cambio. */
export function editPatch(path: string, pairs: readonly { old: string; next: string }[]): string {
  const hunks = pairs.map((p) => {
    const parts = [`@@ ${lineCount(p.old)} -> ${lineCount(p.next)} @@`]
    if (p.old !== '') parts.push(patchLines('-', p.old))
    if (p.next !== '') parts.push(patchLines('+', p.next))
    return parts.join('\n')
  })
  return `--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}`
}

export type ToolDescription = {
  kind: ActionKind
  title: string
  path?: string
  input?: string
  diff?: { path: string; patch: string }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function pairsOf(data: Json): { old: string; next: string }[] {
  const chunks = Array.isArray(data.ReplacementChunks)
    ? data.ReplacementChunks.filter(isRecord)
    : []
  if (chunks.length > 0) {
    return chunks.map((c) => ({
      old: str(c.TargetContent) ?? '',
      next: str(c.ReplacementContent) ?? '',
    }))
  }
  if (data.TargetContent !== undefined || data.ReplacementContent !== undefined) {
    return [{ old: str(data.TargetContent) ?? '', next: str(data.ReplacementContent) ?? '' }]
  }
  const content = str(data.CodeContent) ?? str(data.Content)
  return content === undefined ? [] : [{ old: '', next: content }]
}

/** Descripción de una llamada a partir de su nombre y parámetros crudos. `cwd` acorta las rutas. */
export function describeTool(tool: string, parameters: unknown, cwd: string): ToolDescription {
  const data = isRecord(parameters) ? parameters : {}
  const kind = kindOf(tool)
  const rawPath = firstString(data, PATH_KEYS)
  const path =
    rawPath === undefined
      ? undefined
      : line(relativeTo(cwd, rawPath), LIMITS.maxPathLength) || undefined
  let json: string | undefined
  try {
    json = stripCwd(JSON.stringify(parameters), cwd)
  } catch {
    json = undefined
  }
  const title = (text: string) => line(text, LIMITS.maxTitleLength, tool)
  const base = {
    kind,
    ...(path === undefined ? {} : { path }),
    ...(json === undefined ? {} : { input: truncateUtf8(json, LIMITS.maxBlockInputBytes).text }),
  }
  switch (kind) {
    case 'exec':
      return { ...base, title: title(firstString(data, COMMAND_KEYS) ?? 'Ejecutar un comando') }
    case 'read':
      return { ...base, title: title(`Leer ${path ?? 'archivo'}`) }
    case 'search':
      return {
        ...base,
        title: title(
          `Buscar ${firstString(data, ['Query', 'Pattern', 'pattern', 'query']) ?? 'texto'}`,
        ),
      }
    case 'edit': {
      const pairs = pairsOf(data)
      return {
        ...base,
        title: title(`Editar ${path ?? 'archivo'}`),
        ...(path === undefined || pairs.length === 0
          ? {}
          : { diff: { path, patch: editPatch(path, pairs) } }),
      }
    }
    default:
      return { ...base, title: title(tool) }
  }
}
