import type { FileType } from '@nexo/contracts'

/**
 * Reglas puras de `fs-sandbox` (F4.1): sintaxis de rutas, rutas sensibles, contención en una raíz y detección
 * de tipo. Sin `node:*`: las comparten el adaptador real y el falso del testkit, así que el falso no miente.
 * La resolución de enlaces simbólicos y la E/S son del adaptador.
 */

export type PathPlatform = 'win32' | 'posix'

const CONTROL = (c: number) => c < 0x20 || c === 0x7f

/** Nombres de dispositivo de Windows (con o sin extensión, sin distinguir mayúsculas). */
const WIN_DEVICES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  'CLOCK$',
  ...Array.from({ length: 10 }, (_, i) => `COM${i}`),
  ...Array.from({ length: 10 }, (_, i) => `LPT${i}`),
  'COM¹',
  'COM²',
  'COM³',
  'LPT¹',
  'LPT²',
  'LPT³',
])

export function isWindowsDeviceName(segment: string): boolean {
  const base = (segment.split('.')[0] ?? '').replace(/[ ]+$/, '').toUpperCase()
  return WIN_DEVICES.has(base)
}

/** Parte una ruta en segmentos no vacíos (en Windows, ambas barras separan; la letra de unidad va aparte). */
export function pathSegments(path: string, platform: PathPlatform): string[] {
  const body = platform === 'win32' && /^[A-Za-z]:/.test(path) ? path.slice(2) : path
  return body.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter((s) => s !== '')
}

/**
 * Comprueba la sintaxis de una ruta que pide un cliente. Devuelve el motivo del rechazo o `undefined` si es
 * aceptable. Solo se admiten rutas absolutas y sin `..`: quien llama resuelve lo relativo antes de pedir.
 * No toca el disco; el adaptador comprueba además `realpath`, raíces y rutas sensibles.
 */
export function checkPathSyntax(path: string, platform: PathPlatform): string | undefined {
  if (path.length === 0) return 'ruta vacía'
  if (path.length > 4096) return 'ruta demasiado larga'
  for (let i = 0; i < path.length; i++) {
    if (CONTROL(path.charCodeAt(i))) return 'caracteres de control o bytes nulos'
  }
  if (platform === 'win32') return checkWindowsPath(path)
  if (!path.startsWith('/')) return 'la ruta debe ser absoluta'
  for (const s of path.split('/')) if (s === '..') return 'recorrido de ruta (..)'
  return undefined
}

function checkWindowsPath(path: string): string | undefined {
  if (/^[\\/]{2}/.test(path)) {
    return /^[\\/]{2}[?.][\\/]/.test(path) || /^[\\/]{2}[?.]$/.test(path)
      ? 'ruta de espacio de dispositivos (\\\\?\\ o \\\\.\\)'
      : 'ruta UNC'
  }
  if (/^[\\/]\?\?[\\/]/.test(path)) return 'ruta del espacio de nombres de NT'
  if (!/^[A-Za-z]:[\\/]/.test(path)) return 'la ruta debe ser absoluta con letra de unidad'
  for (const s of pathSegments(path, 'win32')) {
    if (s === '..') return 'recorrido de ruta (..)'
    if (s === '.') continue
    if (/[<>:"|?*]/.test(s)) return 'caracteres no válidos en Windows (flujos alternos, comodines)'
    if (/[. ]$/.test(s)) return 'segmento que termina en punto o espacio'
    if (isWindowsDeviceName(s)) return 'nombre de dispositivo de Windows'
  }
  return undefined
}

// ---- rutas sensibles ----

/** Carpetas que nunca se leen, en cualquier posición de la ruta (minúsculas). */
export const SENSITIVE_DIRS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.codex',
  '.claude',
  '.gemini',
  '.git',
  '.password-store',
  '.terraform.d',
]

/** Secuencias de segmentos sensibles (minúsculas), en cualquier posición. */
export const SENSITIVE_SEQUENCES: readonly (readonly string[])[] = [
  ['.config', 'gcloud'],
  ['.config', 'gh'],
  ['.local', 'share', 'keyrings'],
  ['appdata', 'roaming', 'gcloud'],
  ['appdata', 'roaming', 'microsoft', 'credentials'],
  ['appdata', 'roaming', 'microsoft', 'protect'],
  ['appdata', 'local', 'microsoft', 'credentials'],
]

const SENSITIVE_FILES = new Set([
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  '.vault-token',
  '.credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])
const SENSITIVE_EXTENSIONS = ['.pfx', '.p12', '.kdbx', '.ppk']
/** `.env.example` y parecidos no llevan secretos. */
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/

/** `true` si algún segmento de la ruta (absoluta) apunta a algo sensible: carpetas, secuencias o archivos. */
export function isSensitivePath(segments: readonly string[]): boolean {
  const lower = segments.map((s) => s.toLowerCase().replace(/[. ]+$/, ''))
  for (const s of lower) if (SENSITIVE_DIRS.includes(s)) return true
  for (const seq of SENSITIVE_SEQUENCES) {
    for (let i = 0; i + seq.length <= lower.length; i++) {
      if (seq.every((part, j) => lower[i + j] === part)) return true
    }
  }
  const name = lower.at(-1)
  if (name === undefined) return false
  if (SENSITIVE_FILES.has(name)) return true
  if (SENSITIVE_EXTENSIONS.some((e) => name.endsWith(e))) return true
  if ((name === '.env' || name.startsWith('.env.')) && !ENV_TEMPLATE.test(name)) return true
  return false
}

/** `true` si `target` es `root` o está dentro (comparando segmentos, nunca por prefijo de texto). */
export function isWithin(
  root: readonly string[],
  target: readonly string[],
  caseInsensitive: boolean,
): boolean {
  if (target.length < root.length) return false
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s)
  return root.every((s, i) => fold(s) === fold(target[i] as string))
}

// ---- tipo de archivo ----

/** Bytes iniciales que se leen para detectar el tipo. */
export const SNIFF_BYTES = 8192

const MIME: Record<FileType, string> = {
  markdown: 'text/markdown',
  text: 'text/plain',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  binary: 'application/octet-stream',
}
export const mimeOf = (type: FileType): string => MIME[type]

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  return b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0))

function signature(b: Uint8Array): FileType | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'gif'
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'webp'
  // Solo en el offset 0: aceptar `%PDF-` más adentro tomaría por PDF un texto que lo cite.
  if (startsWith(b, ascii('%PDF-'))) return 'pdf'
  return undefined
}

/** Longitud de la secuencia UTF-8 que empieza con `lead`, o 0 si no es un byte inicial válido. */
function utf8SeqLength(lead: number): number {
  if (lead < 0x80) return 1
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return 0
}

/**
 * Valida UTF-8 estricto (sin sobrelargas, sustitutos ni más allá de U+10FFFF). Con `truncated` se tolera una
 * secuencia incompleta al final (el trozo cortó un carácter).
 */
export function isValidUtf8(bytes: Uint8Array, truncated = false): boolean {
  let i = 0
  while (i < bytes.length) {
    const lead = bytes[i] as number
    const len = utf8SeqLength(lead)
    if (len === 0) return false
    if (len === 1) {
      i++
      continue
    }
    if (i + len > bytes.length) {
      if (!truncated) return false
      // Lo que hay del carácter cortado debe ser, al menos, una continuación válida.
      for (let k = i + 1; k < bytes.length; k++) {
        if (((bytes[k] as number) & 0xc0) !== 0x80) return false
      }
      return true
    }
    const b1 = bytes[i + 1] as number
    for (let k = 1; k < len; k++) if (((bytes[i + k] as number) & 0xc0) !== 0x80) return false
    if (lead === 0xe0 && b1 < 0xa0) return false
    if (lead === 0xed && b1 > 0x9f) return false
    if (lead === 0xf0 && b1 < 0x90) return false
    if (lead === 0xf4 && b1 > 0x8f) return false
    i += len
  }
  return true
}

/** Controles C0 que no aparecen en texto (se admiten tab, LF, FF, CR y ESC). */
function hasBinaryControls(bytes: Uint8Array): boolean {
  for (const c of bytes) {
    if (c === 0) return true
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d && c !== 0x1b) return true
  }
  return false
}

/** Índice tras el cierre de `open` (que empieza en `from`) o -1 si no cierra. */
function skipPast(lower: string, from: number, open: number, close: string): number {
  const at = lower.indexOf(close, from + open)
  return at === -1 ? -1 : at + close.length
}

/** `true` si el texto es, de verdad, un documento SVG (tras prólogo XML, comentarios y DOCTYPE). */
export function looksLikeSvg(text: string): boolean {
  const lower = text.toLowerCase()
  let i = lower.charCodeAt(0) === 0xfeff ? 1 : 0
  for (let guard = 0; guard < 64; guard++) {
    while (i < lower.length && /\s/.test(lower[i] as string)) i++
    let next: number
    if (lower.startsWith('<?', i)) next = skipPast(lower, i, 2, '?>')
    else if (lower.startsWith('<!--', i)) next = skipPast(lower, i, 4, '-->')
    else if (lower.startsWith('<!doctype', i)) {
      const open = lower.indexOf('[', i)
      const close = lower.indexOf('>', i)
      if (open !== -1 && (close === -1 || open < close)) {
        const inner = lower.indexOf(']', open)
        next = inner === -1 ? -1 : skipPast(lower, inner, 1, '>')
      } else next = close === -1 ? -1 : close + 1
    } else break
    if (next === -1) return false
    i = next
  }
  return /^<svg[\s>/]/.test(lower.slice(i, i + 5))
}

/**
 * Tipo por firma (los primeros bytes) y extensión. La firma manda sobre la extensión: un `.png` que no es PNG
 * es texto o binario según su contenido. Un `.md` es Markdown solo si el contenido es texto, y un `.svg` solo
 * si además su raíz es `<svg>` (si no, `text`). `complete` indica que `sample` es el archivo entero.
 */
export function detectFileType(
  sample: Uint8Array,
  name: string,
  complete: boolean,
): { type: FileType; mime: string } {
  const sig = signature(sample)
  if (sig !== undefined) return { type: sig, mime: MIME[sig] }
  const head = sample.subarray(0, SNIFF_BYTES)
  if (hasBinaryControls(head) || !isValidUtf8(head, !complete && head.length === SNIFF_BYTES)) {
    return { type: 'binary', mime: MIME.binary }
  }
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  if (ext === 'svg') {
    let text = ''
    for (const c of head.subarray(0, 4096)) text += String.fromCharCode(c)
    if (looksLikeSvg(text)) return { type: 'svg', mime: MIME.svg }
  }
  if (MARKDOWN_EXT.has(ext)) return { type: 'markdown', mime: MIME.markdown }
  return { type: 'text', mime: MIME.text }
}

/**
 * Cuántos bytes iniciales de `bytes` se pueden decodificar sin partir un carácter UTF-8 al final. Con `atEof`
 * es todo. Un trozo que empieza en medio de un carácter no es válido para el cliente: ver `startsOnBoundary`.
 */
export function utf8SafeLength(bytes: Uint8Array, atEof: boolean): number {
  if (atEof || bytes.length === 0) return bytes.length
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const b = bytes[bytes.length - back] as number
    if ((b & 0xc0) === 0x80) continue
    const len = utf8SeqLength(b)
    return len > back ? bytes.length - back : bytes.length
  }
  return bytes.length
}

/** `false` si el byte es una continuación UTF-8 (el trozo empezaría en medio de un carácter). */
export const startsOnBoundary = (byte: number): boolean => (byte & 0xc0) !== 0x80
