import { LIMITS, type ModelInfo, Token } from '@nexo/contracts'
import { line } from './text.ts'

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export type ParsedModels = { models: ModelInfo[]; defaultModel: string | undefined }

/** Elementos candidatos a modelo dentro de un valor JSON: una lista, o la lista bajo una clave conocida. */
function candidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  for (const key of ['models', 'data', 'items', 'result', 'results']) {
    const inner = value[key]
    if (Array.isArray(inner)) return inner
  }
  // Un solo modelo suelto.
  return str(value.id) !== undefined ||
    str(value.slug) !== undefined ||
    str(value.model) !== undefined
    ? [value]
    : []
}

/**
 * Lee la salida de `agy models`. Formato verificado con agy 1.5.17: una cabecera («Fetching available
 * models...») y una línea `id<TAB>nombre` por modelo; `agy models` no admite `--output-format`. Por si una
 * versión futura cambia a JSON, también se acepta una lista, un objeto con la lista bajo `models`/`data`/`items`,
 * o JSON por líneas. Lo que no encaja se descarta: sin lista, el proveedor sigue usable con el modelo por omisión.
 */
export function parseModels(stdout: string): ParsedModels {
  const raw: unknown[] = []
  const text = stdout.trim()
  if (text === '') return { models: [], defaultModel: undefined }
  try {
    raw.push(...candidates(JSON.parse(text)))
  } catch {
    for (const l of text.split(/\r?\n/)) {
      const tab = l.indexOf('\t')
      if (tab > 0) {
        raw.push({ id: l.slice(0, tab).trim(), label: l.slice(tab + 1).trim() })
        continue
      }
      try {
        raw.push(...candidates(JSON.parse(l)))
      } catch {
        // línea que no es JSON (cabecera, aviso): se salta
      }
    }
  }
  const models: ModelInfo[] = []
  let defaultModel: string | undefined
  for (const item of raw) {
    let id: string | undefined
    let label: string | undefined
    let isDefault = false
    if (typeof item === 'string') id = item
    else if (isRecord(item)) {
      id = str(item.id) ?? str(item.slug) ?? str(item.model) ?? str(item.name)
      label =
        str(item.display_name) ??
        str(item.displayName) ??
        str(item.label) ??
        str(item.title) ??
        str(item.name)
      isDefault = item.default === true || item.is_default === true || item.isDefault === true
    }
    if (id === undefined || !Token.safeParse(id).success) continue
    if (models.some((m) => m.id === id) || models.length >= LIMITS.maxProviderModels) continue
    const shown =
      label === undefined || label === id ? undefined : line(label, LIMITS.maxTitleLength)
    models.push({ id, ...(shown === undefined || shown === '' ? {} : { label: shown }) })
    if (isDefault && defaultModel === undefined) defaultModel = id
  }
  return { models, defaultModel }
}
