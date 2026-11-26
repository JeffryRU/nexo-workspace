import {
  type AgentSessionId,
  type BlockRange,
  LIMITS,
  type MemoryPriority,
  type MemoryUsageTotals,
  type Observation,
  type ObservationDraft,
  type ProjectMemory,
  type Reflection,
  type SourceRange,
  type SummarizerUsage,
  sanitizeBodyText,
  truncateUtf8,
} from '@nexo/contracts'
import { estimateTokens } from './memory-tokens.ts'
import type { ObserveContent } from './ports/memory.ts'

const DRIVE_ONLY = /^[a-z]:$/

/**
 * Clave de proyecto: la carpeta normalizada. Pura (sin `node:path`) y estable entre plataformas:
 * - separadores `\` como `/`, sin repetidos ni `.` ni `..` (un `..` en la raíz se ignora);
 * - sin `/` final salvo la raíz;
 * - rutas de Windows (`C:\...`, `\\servidor\...`): sin distinguir mayúsculas, todo en minúsculas
 *   (el sistema de archivos tampoco las distingue); en POSIX las mayúsculas y `\` se conservan.
 */
export function normalizeProjectPath(raw: string): string {
  let p = raw.replaceAll('\0', '')
  const windows = /^[A-Za-z]:(?:[\\/]|$)/.test(p) || p.startsWith('\\\\') || /^\/\/[^/]/.test(p)
  if (windows) {
    p = p.replaceAll('\\', '/')
    if (p.startsWith('//?/')) p = p.slice(4)
    p = p.toLowerCase()
  }
  const unc = windows && p.startsWith('//')
  const absolute = p.startsWith('/')
  const segments: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      const last = segments[segments.length - 1]
      if (last !== undefined && last !== '..' && !(windows && DRIVE_ONLY.test(last))) segments.pop()
      else if (!absolute && !windows && (last === undefined || last === '..')) segments.push('..')
      continue
    }
    segments.push(part)
  }
  const body = segments.join('/')
  if (unc) return body === '' ? '/' : `//${body}`
  if (absolute) return `/${body}`
  if (windows && DRIVE_ONLY.test(body)) return `${body}/`
  // Una ruta relativa que parece una unidad (`./C:`) no debe confundirse con una de Windows al renormalizar.
  if (!windows && /^[A-Za-z]:(?:\/|$)/.test(body)) return `./${body}`
  return body
}

export function emptyProjectMemory(project: string, now: number): ProjectMemory {
  return {
    version: 1,
    project: normalizeProjectPath(project),
    updatedAt: now,
    nextSeq: 1,
    observations: [],
    reflection: null,
    sessions: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  }
}

export function observedThrough(memory: ProjectMemory, sessionId: AgentSessionId): number {
  return memory.sessions.find((s) => s.sessionId === sessionId)?.observedThrough ?? -1
}

/** Anota hasta qué bloque se observó una sesión (nunca retrocede). Descarta las sesiones más viejas al pasarse. */
export function markObserved(
  memory: ProjectMemory,
  sessionId: AgentSessionId,
  through: number,
  now: number,
): ProjectMemory {
  const current = observedThrough(memory, sessionId)
  const others = memory.sessions.filter((s) => s.sessionId !== sessionId)
  const next = { sessionId, observedThrough: Math.max(current, through), updatedAt: now }
  const sessions = [...others, next]
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return { ...memory, updatedAt: now, sessions: sessions.slice(0, LIMITS.maxMemorySessions) }
}

export function addUsage(
  memory: ProjectMemory,
  usage: SummarizerUsage,
  now: number,
): ProjectMemory {
  const t: MemoryUsageTotals = memory.usage
  const cap = Number.MAX_SAFE_INTEGER
  return {
    ...memory,
    updatedAt: now,
    usage: {
      calls: Math.min(cap, t.calls + 1),
      inputTokens: Math.min(cap, t.inputTokens + (usage.inputTokens ?? 0)),
      outputTokens: Math.min(cap, t.outputTokens + (usage.outputTokens ?? 0)),
      costUsd: Math.min(1e9, t.costUsd + (usage.costUsd ?? 0)),
    },
  }
}

const PRIORITY_RANK: Record<MemoryPriority, number> = { high: 2, medium: 1, low: 0 }
export const priorityRank = (p: MemoryPriority): number => PRIORITY_RANK[p]

const MAX_DRAFTS_PER_BATCH = 40

/** Etiquetas de prioridad y alcance aceptadas en una línea de texto (en español y en inglés). */
const PRIORITY_WORDS = new Map<string, MemoryPriority>([
  ['high', 'high'],
  ['alta', 'high'],
  ['medium', 'medium'],
  ['media', 'medium'],
  ['low', 'low'],
  ['baja', 'low'],
])
const SCOPE_WORDS = new Map<string, 'session' | 'project'>([
  ['session', 'session'],
  ['sesion', 'session'],
  ['sesión', 'session'],
  ['project', 'project'],
  ['proyecto', 'project'],
])

/**
 * Lee la salida de texto de un resumidor: una observación por línea `- [prioridad] [alcance] texto`
 * (etiquetas opcionales y en cualquier orden; sin etiquetas, prioridad media y alcance de sesión). Si algún
 * renglón lleva viñeta, los que no la llevan se ignoran (preámbulos del modelo); si ninguno, cada línea
 * no vacía cuenta.
 */
export function parseObservationText(text: string): ObservationDraft[] {
  const lines = text.split(/\r?\n/).slice(0, 2000)
  const bulleted = lines.some((l) => /^\s*[-*•]\s+\S/.test(l))
  const drafts: ObservationDraft[] = []
  for (const line of lines) {
    let rest = line.trim()
    if (rest === '') continue
    const bullet = /^[-*•]\s+/.exec(rest)
    if (bullet !== null) rest = rest.slice(bullet[0].length)
    else if (bulleted) continue
    let priority: MemoryPriority | undefined
    let scope: 'session' | 'project' | undefined
    for (;;) {
      const tag = /^\[([^\]\n]{1,16})\]\s*/.exec(rest)
      if (tag === null) break
      const word = (tag[1] as string).trim().toLowerCase()
      const p = PRIORITY_WORDS.get(word)
      const s = SCOPE_WORDS.get(word)
      if (p === undefined && s === undefined) break
      if (p !== undefined) priority = p
      if (s !== undefined) scope = s
      rest = rest.slice(tag[0].length)
    }
    if (rest === '') continue
    drafts.push({
      text: rest,
      ...(priority === undefined ? {} : { priority }),
      ...(scope === undefined ? {} : { scope }),
    })
    if (drafts.length >= MAX_DRAFTS_PER_BATCH) break
  }
  return drafts
}

/**
 * Convierte lo que propone el resumidor en observaciones saneadas de un lote: texto sin NUL ni sustitutos
 * sueltos, recortado al tope, sin vacíos ni repetidos, como mucho 40 por lote; el rango se acota al del lote
 * (el modelo no puede citar bloques que no vio). Aún sin `seq`: lo asigna `appendObservations`.
 */
export function acceptObservations(
  drafts: readonly ObservationDraft[],
  batch: { sessionId: AgentSessionId; range: BlockRange; now: number },
): Omit<Observation, 'seq'>[] {
  const out: Omit<Observation, 'seq'>[] = []
  const seen = new Set<string>()
  for (const d of drafts) {
    if (out.length >= MAX_DRAFTS_PER_BATCH) break
    const text = truncateUtf8(sanitizeBodyText(d.text).trim(), LIMITS.maxObservationBytes)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    let from = batch.range.from
    let to = batch.range.to
    if (d.range !== undefined) {
      from = Math.min(Math.max(d.range.from, batch.range.from), batch.range.to)
      to = Math.min(Math.max(d.range.to, from), batch.range.to)
    }
    out.push({
      at: batch.now,
      priority: d.priority ?? 'medium',
      scope: d.scope ?? 'session',
      sessionId: batch.sessionId,
      range: { from, to },
      text,
    })
  }
  return out
}

/**
 * Añade observaciones al proyecto (les asigna `seq`). Si se pasa el tope de `maxObservationsPerProject`
 * descarta primero las de menor prioridad y, entre iguales, las más antiguas; las nuevas solo se pierden si
 * por sí solas pasan del tope.
 */
export function appendObservations(
  memory: ProjectMemory,
  added: readonly Omit<Observation, 'seq'>[],
  now: number,
): ProjectMemory {
  let seq = memory.nextSeq
  const fresh: Observation[] = added
    .slice(0, LIMITS.maxObservationsPerProject)
    .map((o) => ({ ...o, seq: seq++ }))
  let all = [...memory.observations, ...fresh]
  const excess = all.length - LIMITS.maxObservationsPerProject
  if (excess > 0) {
    const freshSeqs = new Set(fresh.map((o) => o.seq))
    const drop = new Set(
      memory.observations
        .filter((o) => !freshSeqs.has(o.seq))
        .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.seq - b.seq)
        .slice(0, excess)
        .map((o) => o.seq),
    )
    all = all.filter((o) => !drop.has(o.seq))
  }
  return { ...memory, updatedAt: now, nextSeq: seq, observations: all }
}

/** Fusiona los rangos de una misma sesión que se tocan o se solapan y se queda con los últimos 64. */
export function mergeSources(sources: readonly SourceRange[]): SourceRange[] {
  const bySession = new Map<string, SourceRange[]>()
  for (const s of sources) {
    const list = bySession.get(s.sessionId)
    if (list === undefined) bySession.set(s.sessionId, [s])
    else list.push(s)
  }
  const merged: SourceRange[] = []
  for (const list of bySession.values()) {
    list.sort((a, b) => a.from - b.from)
    let current: SourceRange | undefined
    for (const r of list) {
      if (current !== undefined && r.from <= current.to + 1) {
        current = { ...current, to: Math.max(current.to, r.to) }
      } else {
        if (current !== undefined) merged.push(current)
        current = r
      }
    }
    if (current !== undefined) merged.push(current)
  }
  return merged.slice(-LIMITS.maxReflectionSources)
}

export type ReflectionResult =
  | { ok: true; memory: ProjectMemory }
  | { ok: false; reason: 'EMPTY' | 'NOTHING_TO_REFLECT' | 'NOT_SMALLER' }

/**
 * Aplica la salida del Reflector: la reflexión absorbe a la anterior y a las observaciones con `seq` hasta
 * `coversThroughSeq` (las posteriores se conservan). Se rechaza si el texto sale vacío, si no hay nada que
 * absorber o si no es más corto que lo que reemplaza: no crecer es la razón de ser del Reflector.
 */
export function applyReflection(
  memory: ProjectMemory,
  output: { text: string; coversThroughSeq: number },
  now: number,
): ReflectionResult {
  const text = truncateUtf8(sanitizeBodyText(output.text).trim(), LIMITS.maxReflectionBytes)
  if (text === '') return { ok: false, reason: 'EMPTY' }
  const through = Math.min(output.coversThroughSeq, memory.nextSeq - 1)
  const covered = memory.observations.filter((o) => o.seq <= through)
  if (covered.length === 0) return { ok: false, reason: 'NOTHING_TO_REFLECT' }
  let replaced = memory.reflection === null ? 0 : estimateTokens(memory.reflection.text)
  for (const o of covered) replaced += estimateTokens(o.text) + 8
  if (estimateTokens(text) >= replaced) return { ok: false, reason: 'NOT_SMALLER' }
  const reflection: Reflection = {
    generation: (memory.reflection?.generation ?? 0) + 1,
    createdAt: now,
    coversThroughSeq: through,
    text,
    sources: mergeSources([
      ...(memory.reflection?.sources ?? []),
      ...covered.map((o) => ({ sessionId: o.sessionId, from: o.range.from, to: o.range.to })),
    ]),
  }
  return {
    ok: true,
    memory: {
      ...memory,
      updatedAt: now,
      reflection,
      observations: memory.observations.filter((o) => o.seq > through),
    },
  }
}

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
    (t) => t.length > 1 || /\d/.test(t),
  )
}

/**
 * Búsqueda por términos (sin distinguir mayúsculas): puntúa cuántos términos de la consulta aparecen, con un
 * empujón por prioridad. Devuelve de más a menos relevante (a igualdad, la más reciente), sin pasar de `limit`.
 */
export function searchObservations(
  observations: readonly Observation[],
  query: string,
  limit: number,
): { matches: Observation[]; truncated: boolean } {
  const wanted = [...new Set(terms(query.slice(0, LIMITS.maxMemoryQueryChars)))].slice(0, 16)
  if (wanted.length === 0 || limit <= 0) return { matches: [], truncated: false }
  const scored: { o: Observation; score: number }[] = []
  for (const o of observations) {
    const hay = o.text.toLowerCase()
    let hits = 0
    for (const t of wanted) if (hay.includes(t)) hits++
    if (hits > 0) scored.push({ o, score: hits * 10 + priorityRank(o.priority) })
  }
  scored.sort((a, b) => b.score - a.score || b.o.seq - a.o.seq)
  return { matches: scored.slice(0, limit).map((s) => s.o), truncated: scored.length > limit }
}

/** Observaciones propuestas por una respuesta del resumidor, sea texto o estructurada. */
export function draftsFromContent(content: ObserveContent): ObservationDraft[] {
  return content.format === 'text'
    ? parseObservationText(content.text)
    : content.observations.slice(0, MAX_DRAFTS_PER_BATCH * 4)
}

/**
 * Cierra un lote del Observador: acepta las observaciones, las añade, anota hasta dónde se observó la sesión
 * y suma el uso. El progreso avanza aunque el modelo no encuentre nada que anotar (el lote ya se leyó).
 */
export function applyObserved(
  memory: ProjectMemory,
  batch: {
    sessionId: AgentSessionId
    range: BlockRange
    content: ObserveContent
    usage: SummarizerUsage
    now: number
  },
): ProjectMemory {
  const accepted = acceptObservations(draftsFromContent(batch.content), batch)
  const withObs = appendObservations(memory, accepted, batch.now)
  const withProgress = markObserved(withObs, batch.sessionId, batch.range.to, batch.now)
  return addUsage(withProgress, batch.usage, batch.now)
}
