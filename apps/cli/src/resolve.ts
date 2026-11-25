import type { Workspace } from '@nexo/contracts'
import { notFoundError, usageError } from './errors.ts'
import { sanitize } from './text.ts'

export type Kind = 'workspace' | 'tab' | 'pane'

export type Entity = {
  kind: Kind
  id: string
  /** Nombre o título (los paneles no se resuelven por nombre). */
  label: string
  workspaceId: string
  tabId?: string
  terminalId?: string
  cwd?: string
}

const KIND_ES: Record<Kind, string> = { workspace: 'espacio', tab: 'pestaña', pane: 'panel' }
const MAX_REF = 256

export function entitiesOf(workspaces: readonly Workspace[], kinds: readonly Kind[]): Entity[] {
  const out: Entity[] = []
  for (const w of workspaces) {
    if (kinds.includes('workspace')) {
      out.push({
        kind: 'workspace',
        id: w.id,
        label: w.name,
        workspaceId: w.id,
        ...(w.cwd === undefined ? {} : { cwd: w.cwd }),
      })
    }
    for (const t of w.tabs) {
      if (kinds.includes('tab')) {
        out.push({ kind: 'tab', id: t.id, label: t.title, workspaceId: w.id, tabId: t.id })
      }
      if (kinds.includes('pane')) {
        for (const p of t.panes) {
          out.push({
            kind: 'pane',
            id: p.id,
            label: p.title,
            workspaceId: w.id,
            tabId: t.id,
            ...(p.terminalId === undefined ? {} : { terminalId: p.terminalId }),
          })
        }
      }
    }
  }
  return out
}

/** `pane-1a2b3c4d` a partir de `pane-1a2b3c4d-....`; para ids sin prefijo, los primeros 12 caracteres. */
export function shortId(id: string): string {
  const m = /^([a-z]+)-(.{8})/.exec(id)
  return m === null ? id.slice(0, 12) : `${m[1]}-${m[2]}`
}

function describe(e: Entity): string {
  return `${KIND_ES[e.kind]} ${shortId(e.id)} "${sanitize(e.label, 40)}"`
}

function ambiguous(ref: string, matches: readonly Entity[]): Error {
  const shown = matches.slice(0, 5).map(describe).join('; ')
  const more = matches.length > 5 ? `; y ${matches.length - 5} más` : ''
  return usageError(
    `la referencia "${sanitize(ref, 64)}" es ambigua (${matches.length} coincidencias): ${shown}${more}. Usa un id más largo.`,
  )
}

function pick(ref: string, matches: Entity[]): Entity | undefined {
  if (matches.length === 0) return undefined
  const [only] = matches
  if (matches.length === 1 && only !== undefined) return only
  throw ambiguous(ref, matches)
}

/** Comprueba la referencia sin tocar el daemon: vacía o enorme es error de uso. */
export function validateRef(ref: string): void {
  if (ref.trim() === '') throw usageError('la referencia está vacía')
  if (ref.length > MAX_REF) throw usageError(`la referencia es demasiado larga (máximo ${MAX_REF})`)
}

/**
 * Resuelve una referencia: id exacto, luego nombre exacto (espacios y pestañas), luego prefijo único
 * del id (con o sin su prefijo `pane-`, `tab-`...). Vacía o enorme es error de uso; sin coincidencia,
 * no encontrado; con varias, ambigua.
 */
export function resolveRef(
  workspaces: readonly Workspace[],
  ref: string,
  kinds: readonly Kind[],
): Entity {
  validateRef(ref)
  const all = entitiesOf(workspaces, kinds)
  const byId = pick(
    ref,
    all.filter((e) => e.id === ref),
  )
  if (byId !== undefined) return byId
  const byName = pick(
    ref,
    all.filter((e) => e.kind !== 'pane' && e.label === ref),
  )
  if (byName !== undefined) return byName
  const byPrefix = pick(
    ref,
    all.filter((e) => e.id.startsWith(ref) || e.id.replace(/^[a-z]+-/, '').startsWith(ref)),
  )
  if (byPrefix !== undefined) return byPrefix
  const what = kinds.map((k) => KIND_ES[k]).join(' / ')
  throw notFoundError(`no se encontró ${what} "${sanitize(ref, 64)}"`)
}

export { KIND_ES }
