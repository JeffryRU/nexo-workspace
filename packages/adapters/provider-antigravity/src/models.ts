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
 * Lee la salida de `agy models --output-format json` (o `stream-json`). La forma exacta no está verificada
 * (no se pudo ejecutar con la cuenta del usuario), así que se acepta una lista, un objeto con la lista bajo
 * `models`/`data`/`items`, o JSON por líneas; cada modelo, como cadena o como objeto con `id`/`slug`/`model`/`name`.
 * Lo que no encaja se descarta: sin lista, el proveedor sigue siendo usable con el modelo por omisión de `agy`.
 */
export function parseModels(stdout: string): ParsedModels {
  const raw: unknown[] = []
  const text = stdout.trim()
  if (text === '') return { models: [], defaultModel: undefined }
  try {
    raw.push(...candidates(JSON.parse(text)))
  } catch {
    for (const l of text.split('\n')) {
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
