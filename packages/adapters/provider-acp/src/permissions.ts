import { LIMITS, type PermissionOption, sanitizeBodyText } from '@nexo/contracts'
import { unifiedDiff } from './diff.ts'
import { permissionOptions, RequestPermissionParams, readToolContent } from './protocol.ts'
import { line, truncateUtf8 } from './text.ts'

/** Respuesta a `session/request_permission` (esquema `RequestPermissionResponse`). */
export type PermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } }

export const CANCELLED: PermissionOutcome = { outcome: { outcome: 'cancelled' } }

/** Cómo se muestra y se responde una solicitud de permiso del agente. */
export type PermissionPlan = {
  tool: string
  title: string
  detail?: string
  options: PermissionOption[]
  /** `optionId` del agente para cada `id` local de opción (los del agente son cadenas arbitrarias). */
  responses: Record<string, string>
}

const KIND: Record<string, PermissionOption['kind']> = {
  allow_once: 'allow-once',
  allow_always: 'allow-always',
  reject_once: 'reject-once',
  reject_always: 'reject-always',
}

/**
 * Plan de una solicitud `session/request_permission`; `undefined` si los parámetros no valen o no hay ninguna
 * opción reconocible (entonces se responde `cancelled`). Las opciones llevan las `PermissionOptionKind` del
 * agente tal cual (`allow_once` → `allow-once`...); el id local es `opt-N` porque los del agente son opacos.
 */
export function planPermission(params: unknown): PermissionPlan | undefined {
  const p = RequestPermissionParams.safeParse(params)
  if (!p.success) return undefined
  const options: PermissionOption[] = []
  const responses: Record<string, string> = {}
  for (const o of permissionOptions(p.data.options)) {
    const kind = KIND[o.kind]
    if (kind === undefined || options.length >= LIMITS.maxBlockOptions) continue
    const id = `opt-${options.length + 1}`
    options.push({ id, label: line(o.name, LIMITS.maxTitleLength, id), kind })
    responses[id] = o.optionId
  }
  if (options.length === 0) return undefined

  const call = p.data.toolCall
  const { diffs, paths } = readToolContent(call)
  const tool = line(call.name ?? call.kind ?? 'tool', 128, 'tool')
  const title = line(call.title ?? '', LIMITS.maxTitleLength, 'Solicitud de permiso')
  const lines: string[] = []
  if (call.rawInput !== undefined && call.rawInput !== null) {
    try {
      lines.push(
        typeof call.rawInput === 'string' ? call.rawInput : JSON.stringify(call.rawInput, null, 2),
      )
    } catch {
      // rawInput no serializable: se omite
    }
  }
  for (const d of diffs.slice(0, 8)) {
    const patch = unifiedDiff(d.path, d.oldText, d.newText)
    lines.push(patch === '' ? `Archivo: ${d.path}` : patch)
  }
  if (diffs.length === 0 && paths.length > 0)
    lines.push(`Archivos: ${paths.slice(0, 8).join(', ')}`)
  const text = lines.join('\n')
  const detail =
    text === '' ? undefined : truncateUtf8(sanitizeBodyText(text), LIMITS.maxBlockInputBytes).text
  return {
    tool,
    title,
    ...(detail === undefined || detail === '' ? {} : { detail }),
    options,
    responses,
  }
}
