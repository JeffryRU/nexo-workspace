import { type HistoryProject, type HistorySession, LIMITS, sanitizeBodyText } from '@nexo/contracts'
import { normalizeProjectPath } from './memory-model.ts'

/**
 * Orden y paginación del historial (F4.3), puros. El orden es total: carpetas de la más reciente a la más antigua
 * (por su sesión más reciente) y, dentro de cada una, sesiones de la más reciente a la más antigua; así una
 * carpeta ocupa un tramo contiguo y la paginación por cursor (keyset) no repite ni pierde sesiones mientras los
 * datos no cambien. Si cambian entre páginas, el cursor sigue siendo válido (continúa «después de» esa posición).
 */

export const NO_FOLDER_NAME = '(sin carpeta)'

/** Posición de una sesión en el orden. `h` es un hash de la carpeta: el cursor no lleva la ruta entera. */
export type HistoryOrderKey = {
  /** Actividad más reciente de la carpeta. */
  m: number
  /** Hash FNV-1a de la carpeta normalizada (0 = sin carpeta). */
  h: number
  u: number
  p: string
  i: string
}

export function projectKeyOf(cwd: string | undefined): string | null {
  return cwd === undefined ? null : normalizeProjectPath(cwd)
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function compareKeys(a: HistoryOrderKey, b: HistoryOrderKey): number {
  if (a.m !== b.m) return b.m - a.m
  if (a.h !== b.h) return a.h - b.h
  if (a.u !== b.u) return b.u - a.u
  if (a.p !== b.p) return a.p < b.p ? -1 : 1
  if (a.i !== b.i) return a.i < b.i ? -1 : 1
  return 0
}

type Ordered = { session: HistorySession; project: string | null; key: HistoryOrderKey }

export function orderHistory(sessions: readonly HistorySession[]): Ordered[] {
  const newest = new Map<string, number>()
  const items = sessions.map((session) => {
    const project = projectKeyOf(session.cwd)
    const name = project ?? ''
    newest.set(name, Math.max(newest.get(name) ?? 0, session.updatedAt))
    return { session, project }
  })
  const out: Ordered[] = items.map(({ session, project }) => ({
    session,
    project,
    key: {
      m: newest.get(project ?? '') ?? session.updatedAt,
      h: project === null ? 0 : fnv1a(project),
      u: session.updatedAt,
      p: session.provider,
      i: session.sessionId,
    },
  }))
  out.sort((a, b) => {
    const c = compareKeys(a.key, b.key)
    if (c !== 0) return c
    // Dos carpetas con el mismo hash y la misma actividad (improbable): se mantienen contiguas.
    return (a.project ?? '') < (b.project ?? '')
      ? -1
      : (a.project ?? '') > (b.project ?? '')
        ? 1
        : 0
  })
  return out
}

// ---- cursor ----

/** Escapa una cadena a `[A-Za-z0-9_]` (el `-` separa campos y `_` es el escape: `_XX` con XX en hexadecimal). */
function escapeField(value: string): string {
  let out = ''
  for (const ch of encodeURIComponent(value)) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch
    else if (ch === '%') out += '_'
    else out += `_${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

function unescapeField(value: string): string | undefined {
  if (!/^(?:[A-Za-z0-9]|_[0-9A-F]{2})*$/.test(value)) return undefined
  try {
    return decodeURIComponent(value.replaceAll('_', '%'))
  } catch {
    return undefined
  }
}

export function encodeHistoryCursor(key: HistoryOrderKey): string {
  return ['h1', key.m, key.h, key.u, escapeField(key.p), escapeField(key.i)].join('-')
}

const UINT = /^\d{1,16}$/

/** `undefined` si el texto no es un cursor emitido por `encodeHistoryCursor` (hostil, truncado, de otra versión). */
export function decodeHistoryCursor(cursor: string): HistoryOrderKey | undefined {
  const parts = cursor.split('-')
  if (parts.length !== 6 || parts[0] !== 'h1') return undefined
  const [, m, h, u, p, i] = parts as [string, string, string, string, string, string]
  if (!UINT.test(m) || !UINT.test(h) || !UINT.test(u)) return undefined
  const provider = unescapeField(p)
  const id = unescapeField(i)
  if (provider === undefined || id === undefined) return undefined
  const key = { m: Number(m), h: Number(h), u: Number(u), p: provider, i: id }
  if (![key.m, key.h, key.u].every((n) => Number.isSafeInteger(n)) || key.h > 0xffffffff) {
    return undefined
  }
  return key
}

/** Nombre para mostrar de una carpeta: su último segmento, sin caracteres de control. */
export function projectDisplayName(cwd: string | null): string {
  if (cwd === null) return NO_FOLDER_NAME
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const last = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
  const clean = Array.from(sanitizeBodyText(last || trimmed || cwd), (ch) =>
    isControl(ch.charCodeAt(0)) ? ' ' : ch,
  )
    .join('')
    .trim()
  return (clean === '' ? NO_FOLDER_NAME : clean).slice(0, LIMITS.maxTitleLength)
}

export type HistoryPage = { projects: HistoryProject[]; nextCursor: string | null; total: number }

/** Una página de `limit` sesiones a partir de `cursor` (exclusivo), agrupadas por carpeta. */
export function pageHistory(
  sessions: readonly HistorySession[],
  options: { cursor?: HistoryOrderKey; limit: number },
): HistoryPage {
  const ordered = orderHistory(sessions)
  const limit = Math.max(1, Math.min(options.limit, LIMITS.maxHistoryPage))
  let start = 0
  if (options.cursor !== undefined) {
    const after = options.cursor
    start = ordered.findIndex((o) => compareKeys(o.key, after) > 0)
    if (start < 0) start = ordered.length
  }
  const page = ordered.slice(start, start + limit)
  const projects: HistoryProject[] = []
  let currentKey: string | null | undefined
  for (const item of page) {
    const last = projects[projects.length - 1]
    if (last !== undefined && currentKey === item.project) {
      last.sessions.push(item.session)
      continue
    }
    currentKey = item.project
    projects.push({
      cwd: item.session.cwd ?? null,
      name: projectDisplayName(item.project === null ? null : (item.session.cwd ?? null)),
      sessions: [item.session],
    })
  }
  const lastItem = page[page.length - 1]
  const more = start + limit < ordered.length && lastItem !== undefined
  return {
    projects,
    nextCursor: more ? encodeHistoryCursor(lastItem.key) : null,
    total: ordered.length,
  }
}

function isControl(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029
}
