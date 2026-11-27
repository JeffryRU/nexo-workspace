import {
  type Attention,
  CompanionManifest,
  type CompanionMime,
  type CompanionSheet,
  type CompanionState,
  type CompanionStateAsset,
  LIMITS,
  utf8ByteLength,
} from '@nexo/contracts'
import { isValidUtf8, isWindowsDeviceName, looksLikeSvg } from './file-rules.ts'

/**
 * Reglas puras de los compañeros (F5.2): manifiesto, imágenes y SVG, y la agregación de atención a estado de
 * mascota. Sin `node:*`: las comparten el cargador real (`companion-fs`) y el falso del testkit.
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string }

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

/** Recursos distintos que usa el manifiesto, en orden estable. */
export function manifestAssetPaths(manifest: CompanionManifest): string[] {
  const out = new Set<string>()
  for (const asset of Object.values(manifest.states)) {
    if (asset !== undefined) out.add(asset.src)
  }
  return [...out]
}

/** Entrada `[estado, recurso]` de los estados declarados. */
export function manifestStates(
  manifest: CompanionManifest,
): [CompanionState, CompanionStateAsset][] {
  return (
    Object.entries(manifest.states) as [CompanionState, CompanionStateAsset | undefined][]
  ).flatMap(([state, asset]) =>
    asset === undefined ? [] : [[state, asset] as [CompanionState, CompanionStateAsset]],
  )
}

/** Un segmento no puede ser un nombre de dispositivo de Windows (`CON.png`, `nul`...). */
function hasReservedName(path: string): boolean {
  return path.split('/').some((s) => isWindowsDeviceName(s))
}

/**
 * Valida un `companion.json` ya parseado: esquema zod estricto, id = nombre de la carpeta (`expectedId`) y rutas
 * sin nombres de dispositivo de Windows. El motivo del rechazo es corto y sin eco del contenido hostil.
 */
export function parseCompanionManifest(
  raw: unknown,
  expectedId?: string,
): Checked<CompanionManifest> {
  const parsed = CompanionManifest.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue === undefined ? '' : ` (${issue.path.map(String).join('.').slice(0, 80)})`
    return fail(`manifiesto no válido${where}`)
  }
  const manifest = parsed.data
  if (expectedId !== undefined && manifest.id !== expectedId) {
    return fail('el id del manifiesto no coincide con el nombre de la carpeta')
  }
  if (isWindowsDeviceName(manifest.id)) return fail('id reservado en Windows')
  for (const path of manifestAssetPaths(manifest)) {
    if (hasReservedName(path)) return fail('ruta con un nombre reservado de Windows')
  }
  return { ok: true, value: manifest }
}

/** Texto de `companion.json` -> manifiesto: tope de bytes, JSON válido y `parseCompanionManifest`. */
export function parseCompanionManifestText(
  text: string,
  expectedId?: string,
): Checked<CompanionManifest> {
  if (utf8ByteLength(text) > LIMITS.maxCompanionManifestBytes)
    return fail('manifiesto demasiado grande')
  let raw: unknown
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return fail('el manifiesto no es JSON')
  }
  return parseCompanionManifest(raw, expectedId)
}

// ---- imágenes ----

export type CompanionImage = { mime: CompanionMime; width?: number; height?: number }

const ascii = (b: Uint8Array, at: number, s: string): boolean =>
  b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0))

const u16le = (b: Uint8Array, at: number): number =>
  (b[at] as number) | ((b[at + 1] as number) << 8)
const u32be = (b: Uint8Array, at: number): number =>
  (((b[at] as number) << 24) |
    ((b[at + 1] as number) << 16) |
    ((b[at + 2] as number) << 8) |
    (b[at + 3] as number)) >>>
  0

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 30) return undefined
  if (ascii(b, 12, 'VP8X')) {
    const w = 1 + ((b[24] as number) | ((b[25] as number) << 8) | ((b[26] as number) << 16))
    const h = 1 + ((b[27] as number) | ((b[28] as number) << 8) | ((b[29] as number) << 16))
    return { width: w, height: h }
  }
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    const w = 1 + ((b[21] as number) | (((b[22] as number) & 0x3f) << 8))
    const h =
      1 + (((b[22] as number) >> 6) | ((b[23] as number) << 2) | (((b[24] as number) & 0x0f) << 10))
    return { width: w, height: h }
  }
  if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  return undefined
}

/** Texto ASCII/UTF-8 de los bytes, como cadena «latin1» (para buscar patrones ASCII sin decodificar). */
function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 8192)))
  }
  return out
}

/** Referencias que un SVG puede llevar sin salir de sí mismo: fragmentos (`#id`) e imágenes de mapa de bits `data:`. */
const SAFE_HREF = /^(#|data:image\/(png|jpeg|gif|webp);base64,)/

/**
 * Motivo por el que un SVG no se acepta, o `undefined` si pasa. Se rechaza (no se sanea): scripts, `foreignObject`,
 * marcos y objetos incrustados, manejadores `on*`, `javascript:`, entidades y DOCTYPE con subconjunto interno,
 * referencias de caracteres, `@import`, `url()` y enlaces que no sean fragmentos locales. Es defensa en
 * profundidad: el cliente debe dibujarlo siempre como `<img>`, donde el navegador no ejecuta nada.
 */
export function checkSvgSafety(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return 'SVG vacío'
  if (!isValidUtf8(bytes)) return 'el SVG no es UTF-8 válido'
  const text = latin1(bytes)
  if (text.includes('\u0000')) return 'el SVG tiene bytes nulos'
  const lower = text.toLowerCase()
  const body = text.startsWith('ï»¿') ? text.slice(3) : text
  if (!looksLikeSvg(body.slice(0, 4096))) return 'no es un documento SVG'
  const banned = [
    '<script',
    '<foreignobject',
    '<iframe',
    '<embed',
    '<object',
    '<audio',
    '<video',
    '<link',
    '<meta',
    '<!entity',
    '<?xml-stylesheet',
    '@import',
    'javascript:',
    'vbscript:',
    'data:text',
    'data:application',
    'data:image/svg',
    'expression(',
    '&#',
  ]
  for (const word of banned)
    if (lower.includes(word)) return `contenido no permitido en el SVG (${word})`
  if (/<!doctype[^>]*\[/.test(lower)) return 'DOCTYPE con subconjunto interno'
  if (/&(?!(amp|lt|gt|quot|apos);)/.test(lower)) return 'entidades no permitidas en el SVG'
  if (/[\s"'/]on[a-z]+\s*=/.test(lower)) return 'manejador de eventos en el SVG'
  if (/attributename\s*=\s*["']?\s*(xlink:)?href/.test(lower))
    return 'animación de un enlace en el SVG'
  if (/(?:xlink:)?href\s*=\s*[^"'\s]/.test(lower)) return 'enlace sin comillas en el SVG'
  for (const m of lower.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gs)) {
    if (!SAFE_HREF.test((m[2] as string).trim())) return 'referencia externa en el SVG'
  }
  for (const m of lower.matchAll(/url\(\s*(["']?)\s*([^)]{0,16})/g)) {
    if (!(m[2] as string).startsWith('#')) return 'url() externa en el SVG'
  }
  return undefined
}

const EXT_MIME: Record<string, CompanionMime> = {
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

/**
 * Comprueba que `bytes` ES una imagen del tipo que dice la extensión de `path` (por los bytes mágicos, no por el
 * nombre), que no pasa de `maxCompanionAssetBytes` ni de `maxCompanionImageSide` por lado (cuando el encabezado lo
 * dice) y, si es SVG, que `checkSvgSafety` lo acepta.
 */
export function inspectCompanionImage(bytes: Uint8Array, path: string): Checked<CompanionImage> {
  if (bytes.length === 0) return fail('recurso vacío')
  if (bytes.length > LIMITS.maxCompanionAssetBytes) return fail('recurso demasiado grande')
  const dot = path.lastIndexOf('.')
  const expected = EXT_MIME[dot === -1 ? '' : path.slice(dot + 1).toLowerCase()]
  if (expected === undefined) return fail('extensión de imagen no admitida')
  let image: CompanionImage | undefined
  if (PNG_SIG.every((v, i) => bytes[i] === v)) {
    if (bytes.length < 24 || !ascii(bytes, 12, 'IHDR')) return fail('PNG sin encabezado')
    image = { mime: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
  } else if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) {
    if (bytes.length < 10) return fail('GIF truncado')
    image = { mime: 'image/gif', width: u16le(bytes, 6), height: u16le(bytes, 8) }
  } else if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    const size = webpSize(bytes)
    if (size === undefined) return fail('WebP no reconocido')
    image = { mime: 'image/webp', ...size }
  } else if (expected === 'image/svg+xml') {
    const reason = checkSvgSafety(bytes)
    if (reason !== undefined) return fail(reason)
    return { ok: true, value: { mime: 'image/svg+xml' } }
  } else {
    return fail('el recurso no es una imagen')
  }
  if (image.mime !== expected) return fail('la extensión no coincide con el tipo de imagen')
  const { width, height } = image
  if (
    width === undefined ||
    height === undefined ||
    width < 1 ||
    height < 1 ||
    width > LIMITS.maxCompanionImageSide ||
    height > LIMITS.maxCompanionImageSide
  ) {
    return fail('dimensiones de imagen fuera de rango')
  }
  return { ok: true, value: image }
}

/** La hoja de sprites cabe en la imagen (si se conocen sus dimensiones). `undefined` si todo va bien. */
export function checkSheetFits(sheet: CompanionSheet, image: CompanionImage): string | undefined {
  if (image.width === undefined || image.height === undefined) return undefined
  const columns = sheet.columns ?? sheet.frames
  const rows = Math.ceil(sheet.frames / columns)
  if (columns * sheet.frameWidth > image.width || rows * sheet.frameHeight > image.height) {
    return 'la hoja de sprites no cabe en la imagen'
  }
  return undefined
}

// ---- base64 (core no tiene `Buffer` ni `btoa`) ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64Encode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out
}

// ---- atención -> estado de mascota ----

/** Prioridad de cada estado (mayor gana). Coherente con `nexo://attention`: needs-input > error > working > done > idle. */
export const COMPANION_PRIORITY: Readonly<Record<CompanionState, number>> = {
  idle: 0,
  done: 1,
  thinking: 2,
  busy: 3,
  error: 4,
  waiting: 5,
}

/** Estado objetivo de la mascota a partir de la atención de todas las sesiones de agente. */
export function companionTarget(statuses: Iterable<Attention>): CompanionState {
  let working = 0
  let needsInput = false
  let error = false
  let done = false
  for (const s of statuses) {
    if (s === 'needs-input') needsInput = true
    else if (s === 'error') error = true
    else if (s === 'working') working++
    else if (s === 'done') done = true
  }
  if (needsInput) return 'waiting'
  if (error) return 'error'
  if (working >= 2) return 'busy'
  if (working === 1) return 'thinking'
  return done ? 'done' : 'idle'
}
