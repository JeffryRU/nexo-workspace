import type {
  Block,
  HistoryBlock,
  HistoryProject,
  HistoryProviderStatus,
  HistorySession,
} from '@nexo/contracts'
import { es, format } from '../i18n/es.ts'
import { formatResetAt } from '../limits/view.ts'

/** Fecha y hora local a minutos; `?` si no es una fecha válida. */
export const formatLocalWhen = formatResetAt

/** Funciones puras de la vista de historial (F4.5): juntar páginas, filtrar, acotar lo que se pinta y convertir bloques. */

/** Sesiones que se pintan como mucho a la vez: miles de filas congelarían la ventana. */
export const MAX_RENDERED_SESSIONS = 500

const NO_FOLDER = '\u0000'
const folderKey = (cwd: string | null): string => (cwd === null ? NO_FOLDER : normalizeCwd(cwd))

/** Misma carpeta aunque cambie la barra, las mayúsculas de la unidad o la barra final (el daemon ya agrupa así). */
export function normalizeCwd(cwd: string): string {
  const slashed = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed
}

/**
 * Junta las páginas de `history.list` en proyectos únicos: una carpeta partida entre dos páginas se une y una sesión que
 * aparece dos veces (misma ficha y proveedor) se queda con la primera. Conserva el orden del daemon.
 */
export function mergeProjects(pages: readonly (readonly HistoryProject[])[]): HistoryProject[] {
  const byFolder = new Map<string, HistoryProject>()
  const seen = new Set<string>()
  for (const page of pages) {
    for (const project of page) {
      const key = folderKey(project.cwd)
      let target = byFolder.get(key)
      for (const session of project.sessions) {
        const id = `${session.provider}\u0000${session.sessionId}`
        if (seen.has(id)) continue
        seen.add(id)
        if (target === undefined) {
          target = { ...project, sessions: [] }
          byFolder.set(key, target)
        }
        target.sessions.push(session)
      }
    }
  }
  return [...byFolder.values()]
}

/** Texto en minúsculas sin acentos para comparar. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Sesiones y proyectos que contienen `query` (sin mayúsculas ni acentos) en el título, el nombre o la carpeta. Vacío = todo. */
export function filterProjects(
  projects: readonly HistoryProject[],
  query: string,
): HistoryProject[] {
  const needle = fold(query.trim())
  if (needle === '') return [...projects]
  const out: HistoryProject[] = []
  for (const project of projects) {
    const folderHit = fold(`${project.name} ${project.cwd ?? ''}`).includes(needle)
    const sessions = folderHit
      ? project.sessions
      : project.sessions.filter((s) => fold(s.title ?? '').includes(needle))
    if (sessions.length > 0) out.push({ ...project, sessions: [...sessions] })
  }
  return out
}

export function countSessions(projects: readonly HistoryProject[]): number {
  let n = 0
  for (const p of projects) n += p.sessions.length
  return n
}

/** Las primeras `max` sesiones, por orden, sin dejar carpetas vacías. */
export function capSessions(projects: readonly HistoryProject[], max: number): HistoryProject[] {
  const out: HistoryProject[] = []
  let room = Math.max(0, Math.floor(max))
  for (const project of projects) {
    if (room <= 0) break
    const sessions = project.sessions.slice(0, room)
    room -= sessions.length
    out.push(sessions.length === project.sessions.length ? project : { ...project, sessions })
  }
  return out
}

/** Título para mostrar: nunca vacío. El texto se pinta como texto plano. */
export function sessionTitle(session: Pick<HistorySession, 'title'>): string {
  const t = session.title?.trim()
  return t === undefined || t === '' ? es.history.untitled : t
}

/** Aviso por proveedor que no listó bien (`ok` no avisa). `name` resuelve el nombre para mostrar. */
export function providerNotice(
  status: HistoryProviderStatus,
  name: (provider: string) => string,
): string | undefined {
  if (status.status === 'ok') return undefined
  const reason = status.reason === undefined || status.reason === '' ? '' : `: ${status.reason}`
  return format(es.history.providerStatus[status.status], { name: name(status.provider), reason })
}

/** Id de bloque de una transcripción antigua (los bloques del historial no traen id: es la posición). */
export function historyBlockId(index: number): string {
  return `hist-${String(index).padStart(8, '0')}`
}

/**
 * Bloque del historial como bloque de panel: mismo contenido, con la identidad que pide el render. Una sesión antigua ya no
 * está en curso: los textos se dan por completos (sin cursor parpadeante).
 */
export function toBlock(h: HistoryBlock): Block {
  const done = h.block.type === 'text' || h.block.type === 'reasoning' ? { complete: true } : {}
  return {
    ...h.block,
    ...done,
    id: historyBlockId(h.index),
    index: h.index,
    turn: h.turn,
    seq: 0,
    createdAt: 0,
  } as unknown as Block
}

/** Junta páginas de bloques sin repetir posiciones y en orden. */
export function mergeBlocks(pages: readonly (readonly HistoryBlock[])[]): HistoryBlock[] {
  const byIndex = new Map<number, HistoryBlock>()
  for (const page of pages) for (const b of page) if (!byIndex.has(b.index)) byIndex.set(b.index, b)
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}
