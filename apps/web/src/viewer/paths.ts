import { safeHref, stripInvisible } from '../agent/safe-url.ts'

/**
 * Rutas y enlaces del visor (F4.2). Todo es puro: resolver un enlace relativo de un Markdown contra la carpeta
 * del archivo, y decidir qué es cada enlace (externo, archivo local, ancla o bloqueado). Lo que no se pueda
 * resolver con certeza se bloquea; el daemon (`fs-sandbox`) vuelve a validar cualquier ruta al leerla.
 */

const WIN_DRIVE = /^[A-Za-z]:[\\/]/
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const MAX_HREF = 2048

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

/** `/ruta` (no `//`, que es UNC o relativa al protocolo) o `C:\ruta` / `C:/ruta`. */
export function isAbsolutePath(path: string): boolean {
  return WIN_DRIVE.test(path) || (path.startsWith('/') && !path.startsWith('//'))
}

/**
 * Quita `.` y `..` de una ruta absoluta. `undefined` si no es absoluta, trae controles o NUL, o si un `..` sale
 * de la raíz (en Windows también si un componente lleva `:`, flujos de datos alternativos).
 */
export function normalizeAbsolute(path: string): string | undefined {
  if (path === '' || hasControl(path) || !isAbsolutePath(path)) return undefined
  const windows = WIN_DRIVE.test(path)
  const root = windows ? path.slice(0, 2) : ''
  const sep = windows && path.includes('\\') ? '\\' : '/'
  const rest = path.slice(windows ? 3 : 1)
  const parts: string[] = []
  for (const part of windows ? rest.split(/[\\/]/) : rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
      continue
    }
    if (windows && part.includes(':')) return undefined
    parts.push(part)
  }
  return `${root}${sep}${parts.join(sep)}`
}

/** La carpeta que contiene el archivo de una ruta absoluta (la raíz si ya está en ella). */
export function dirname(path: string): string | undefined {
  const norm = normalizeAbsolute(path)
  if (norm === undefined) return undefined
  const cut = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return cut <= (WIN_DRIVE.test(norm) ? 2 : 0) ? norm.slice(0, cut + 1) : norm.slice(0, cut)
}

/** Nombre del archivo de una ruta. */
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(cut + 1)
}

/** `target` absoluta o relativa a `baseDir` (una carpeta absoluta), normalizada; `undefined` si no se puede. */
export function resolveLocalPath(baseDir: string | undefined, target: string): string | undefined {
  if (target === '' || hasControl(target)) return undefined
  if (isAbsolutePath(target)) return normalizeAbsolute(target)
  if (baseDir === undefined || !isAbsolutePath(baseDir)) return undefined
  // Un relativo con letra de unidad (`C:foo`) o con esquema no es una ruta relativa.
  if (SCHEME.test(target)) return undefined
  const sep = WIN_DRIVE.test(baseDir) && baseDir.includes('\\') ? '\\' : '/'
  const base = baseDir.endsWith('/') || baseDir.endsWith('\\') ? baseDir : `${baseDir}${sep}`
  return normalizeAbsolute(`${base}${target}`)
}

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'anchor' }
  | { kind: 'blocked' }

/**
 * Qué hace un enlace del Markdown. `http(s)` y `mailto` son externos; una ruta (absoluta o relativa a `baseDir`)
 * es un archivo local; `#x` es un ancla; todo lo demás (`javascript:`, `data:`, `file:`, `//host`, controles,
 * `..` que sale de la raíz) queda bloqueado.
 */
export function classifyHref(raw: string, baseDir: string | undefined): LinkTarget {
  if (raw.length > MAX_HREF) return { kind: 'blocked' }
  const external = safeHref(raw)
  if (external !== undefined) return { kind: 'external', url: external }
  const compact = stripInvisible(raw)
  if (compact === '') return { kind: 'blocked' }
  if (compact.startsWith('#')) return { kind: 'anchor' }
  if (SCHEME.test(compact) && !WIN_DRIVE.test(compact)) return { kind: 'blocked' }
  // Aquí no hay esquema: cualquier control en el original es sospechoso (`java\tscript:` ya cayó arriba).
  if (hasControl(raw)) return { kind: 'blocked' }
  // `//host`, `\\srv\x` y `\x`: UNC, relativas al protocolo o a la unidad actual; nada de eso es del visor.
  if (raw.startsWith('/') && /^[\\/]/.test(raw.slice(1))) return { kind: 'blocked' }
  if (raw.startsWith('\\')) return { kind: 'blocked' }
  const cut = raw.search(/[?#]/)
  const withoutSuffix = cut === -1 ? raw : raw.slice(0, cut)
  let decoded: string
  try {
    decoded = decodeURIComponent(withoutSuffix)
  } catch {
    return { kind: 'blocked' }
  }
  // Un `%2e%2e` o un `%00` decodificados no pueden saltarse las comprobaciones.
  if (hasControl(decoded) || decoded.startsWith('//') || decoded.startsWith('\\\\')) {
    return { kind: 'blocked' }
  }
  if (SCHEME.test(decoded) && !WIN_DRIVE.test(decoded)) return { kind: 'blocked' }
  const path = resolveLocalPath(baseDir, decoded)
  return path === undefined ? { kind: 'blocked' } : { kind: 'file', path }
}
