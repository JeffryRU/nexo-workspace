import {
  COMPANION_MIMES,
  COMPANION_STATES,
  type CompanionManifest,
  type CompanionSheet,
  type CompanionState,
  type CompanionStateView,
  LIMITS,
} from '@nexo/contracts'

/**
 * Lógica pura de la mascota (F5.3): decodificar recursos, fusionar el estado que llega por consulta y por evento,
 * elegir qué imagen dibujar (con `idle` de respaldo) y la geometría de las hojas de sprites. Sin DOM ni Solid.
 */

/** Lado del recuadro de la mascota en píxeles CSS (el CSS usa el mismo valor). */
export const COMPANION_BOX = 96

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_BASE64 = Math.ceil(LIMITS.maxCompanionAssetBytes / 3) * 4

/**
 * Decodifica base64 estricto (alfabeto estándar, relleno correcto, sin espacios). Devuelve `undefined` ante cualquier
 * irregularidad o si `expectedBytes` no coincide con lo decodificado: un recurso corrupto no se dibuja.
 */
export function decodeBase64(data: unknown, expectedBytes?: number): Uint8Array | undefined {
  if (typeof data !== 'string' || data.length > MAX_BASE64 || !BASE64.test(data)) return undefined
  let binary: string
  try {
    binary = atob(data)
  } catch {
    return undefined
  }
  if (expectedBytes !== undefined && binary.length !== expectedBytes) return undefined
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** ¿Es un tipo de imagen que el daemon sirve? (lo demás se descarta aunque llegue). */
export function isCompanionMime(mime: unknown): boolean {
  return typeof mime === 'string' && (COMPANION_MIMES as readonly string[]).includes(mime)
}

const isState = (v: unknown): v is CompanionState =>
  typeof v === 'string' && (COMPANION_STATES as readonly string[]).includes(v)

/** Valida de nuevo lo que llega (el cliente ya lo hace, pero un valor raro no debe romper la interfaz). */
export function sanitizeView(v: unknown): CompanionStateView | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const { state, since, selected } = v as Record<string, unknown>
  if (!isState(state)) return undefined
  if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) return undefined
  if (selected !== null && (typeof selected !== 'string' || selected === '')) return undefined
  return { state, since, selected }
}

/**
 * Fusiona un evento `companion.state` con el estado actual: se descarta si es del mismo compañero y empezó **antes**
 * que el actual (llegó fuera de orden); uno igual al actual no cambia nada (misma referencia, sin repintar). Un
 * compañero distinto siempre se acepta: elegir no cambia `since`. (La consulta inicial no pasa por aquí: el modelo
 * la ignora si ya llegó algún evento.)
 */
export function mergeState(
  current: CompanionStateView | undefined,
  incoming: CompanionStateView,
): CompanionStateView {
  if (current === undefined) return incoming
  if (
    current.selected === incoming.selected &&
    current.state === incoming.state &&
    current.since === incoming.since
  ) {
    return current
  }
  if (current.selected === incoming.selected && incoming.since < current.since) return current
  return incoming
}

/** Una imagen ya lista para dibujar. */
export type DrawableAsset = { url: string; sheet?: CompanionSheet | undefined }

/**
 * Qué se dibuja para un estado: su imagen; si falta o falló, la de `idle`; si tampoco hay, nada (`undefined`).
 * `broken` son los estados cuya imagen el navegador no pudo decodificar.
 */
export function resolveAsset(
  assets: Partial<Record<CompanionState, DrawableAsset>>,
  state: CompanionState,
  broken: ReadonlySet<CompanionState> = new Set(),
): { state: CompanionState; asset: DrawableAsset } | undefined {
  for (const candidate of state === 'idle' ? (['idle'] as const) : [state, 'idle' as const]) {
    const asset = assets[candidate]
    if (asset !== undefined && !broken.has(candidate)) return { state: candidate, asset }
  }
  return undefined
}

/** Rutas distintas que declara el manifiesto, en el orden de los estados (una imagen compartida se pide una vez). */
export function manifestPaths(manifest: CompanionManifest): string[] {
  const seen = new Set<string>()
  for (const state of COMPANION_STATES) {
    const src = manifest.states[state]?.src
    if (src !== undefined) seen.add(src)
  }
  return [...seen]
}

// ---- hojas de sprites ----

export type SheetLayout = { columns: number; rows: number }

export function sheetLayout(sheet: CompanionSheet): SheetLayout {
  const columns = Math.max(1, Math.min(sheet.columns ?? sheet.frames, sheet.frames))
  return { columns, rows: Math.ceil(sheet.frames / columns) }
}

/** Esquina superior izquierda del cuadro `index` (acotado a los cuadros que hay) en píxeles de la imagen. */
export function frameOffset(sheet: CompanionSheet, index: number): { x: number; y: number } {
  const { columns } = sheetLayout(sheet)
  const i = Number.isFinite(index) ? Math.min(Math.max(Math.trunc(index), 0), sheet.frames - 1) : 0
  return { x: (i % columns) * sheet.frameWidth, y: Math.floor(i / columns) * sheet.frameHeight }
}

/** Cuadro siguiente: con `reduced` (prefers-reduced-motion) siempre el primero; sin `loop` se queda en el último. */
export function nextFrame(sheet: CompanionSheet, current: number, reduced: boolean): number {
  if (reduced) return 0
  const next = current + 1
  if (next < sheet.frames) return next
  return sheet.loop === false ? sheet.frames - 1 : 0
}

/** Milisegundos entre cuadros (`fps` ya viene acotado a 0.1-60 por el contrato; aquí se vuelve a acotar). */
export function frameIntervalMs(sheet: CompanionSheet): number {
  const fps = Number.isFinite(sheet.fps) ? Math.min(Math.max(sheet.fps, 0.1), 60) : 1
  return Math.max(16, Math.round(1000 / fps))
}

/** Escala para meter un cuadro en el recuadro; entera si amplía (el pixel art no se ve borroso). */
export function frameScale(sheet: CompanionSheet, box = COMPANION_BOX): number {
  const raw = Math.min(box / sheet.frameWidth, box / sheet.frameHeight)
  return raw >= 1 ? Math.floor(raw) : raw
}
