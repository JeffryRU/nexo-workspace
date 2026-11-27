import { z } from 'zod'
import { LIMITS } from './limits.ts'
import { DisplayText, lineText } from './text.ts'

/**
 * Compañeros (mascotas, F5.2; ADR 0006): un paquete de datos (`companion.json` + imágenes) y los métodos
 * `companion.*`. Sin código ejecutable. Ver `docs/ARCHITECTURE.md`, «Compañeros (F5.2)».
 */

const Millis = z.int().nonnegative()

/**
 * Estados de la mascota. Salen de la atención de los agentes con la misma prioridad que `nexo://attention`
 * (needs-input > error > working > done > idle); `thinking` es un agente trabajando y `busy`, varios a la vez.
 */
export const COMPANION_STATES = ['idle', 'thinking', 'waiting', 'busy', 'done', 'error'] as const
export const CompanionState = z.enum(COMPANION_STATES)
export type CompanionState = z.infer<typeof CompanionState>

/** Id del paquete = nombre de su carpeta: minúsculas, dígitos, `-` y `_`. */
export const CompanionId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, 'id de compañero no válido')
export type CompanionId = z.infer<typeof CompanionId>

export const COMPANION_IMAGE_EXTENSIONS = ['png', 'webp', 'gif', 'svg'] as const
export const COMPANION_MIMES = ['image/png', 'image/webp', 'image/gif', 'image/svg+xml'] as const
export const CompanionMime = z.enum(COMPANION_MIMES)
export type CompanionMime = z.infer<typeof CompanionMime>

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/**
 * Ruta de un recurso dentro del paquete: relativa, con `/`, hasta 4 segmentos de `[A-Za-z0-9._-]` que no
 * empiezan por punto ni terminan en punto, y extensión de imagen. Sin `..`, absolutas, UNC, `C:`, barras
 * invertidas, espacios ni flujos alternos. Los nombres de dispositivo de Windows los rechaza `core`.
 */
export const CompanionAssetPath = z
  .string()
  .min(1)
  .max(LIMITS.maxCompanionPathLength)
  .refine(
    (p) => {
      const segments = p.split('/')
      if (segments.length > 4) return false
      if (!segments.every((s) => SEGMENT.test(s) && !s.endsWith('.'))) return false
      const dot = p.lastIndexOf('.')
      const ext = dot === -1 ? '' : p.slice(dot + 1).toLowerCase()
      return (COMPANION_IMAGE_EXTENSIONS as readonly string[]).includes(ext)
    },
    {
      message: 'ruta de recurso no válida (relativa, segura y con extensión png, webp, gif o svg)',
    },
  )
export type CompanionAssetPath = z.infer<typeof CompanionAssetPath>

/** Hoja de sprites: cuadros del mismo tamaño en filas de `columns` (por omisión, todos en una fila). */
export const CompanionSheet = z
  .strictObject({
    frameWidth: z.int().min(1).max(LIMITS.maxCompanionImageSide),
    frameHeight: z.int().min(1).max(LIMITS.maxCompanionImageSide),
    frames: z.int().min(1).max(LIMITS.maxCompanionFrames),
    columns: z.int().min(1).max(LIMITS.maxCompanionFrames).optional(),
    fps: z.number().min(0.1).max(60),
    loop: z.boolean().optional(),
  })
  .refine((s) => s.columns === undefined || s.columns <= s.frames, {
    message: 'columns no puede pasar de frames',
  })
export type CompanionSheet = z.infer<typeof CompanionSheet>

export const CompanionStateAsset = z.strictObject({
  src: CompanionAssetPath,
  sheet: CompanionSheet.optional(),
})
export type CompanionStateAsset = z.infer<typeof CompanionStateAsset>

const Semver = z
  .string()
  .regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,32})?$/, 'versión no válida')
const License = z.string().regex(/^[A-Za-z0-9.+() -]{1,64}$/, 'licencia no válida (usa un id SPDX)')

/** `companion.json`. `idle` es obligatorio: los estados que falten se dibujan con él. */
export const CompanionManifest = z.strictObject({
  format: z.literal(1),
  id: CompanionId,
  name: DisplayText,
  version: Semver,
  description: DisplayText.optional(),
  author: z.strictObject({
    name: DisplayText,
    url: z
      .string()
      .max(256)
      .regex(/^https:\/\/[^\s<>"']+$/, 'la URL debe ser https')
      .optional(),
  }),
  license: License,
  states: z.strictObject({
    idle: CompanionStateAsset,
    thinking: CompanionStateAsset.optional(),
    waiting: CompanionStateAsset.optional(),
    busy: CompanionStateAsset.optional(),
    done: CompanionStateAsset.optional(),
    error: CompanionStateAsset.optional(),
  }),
})
export type CompanionManifest = z.infer<typeof CompanionManifest>

export const CompanionSummary = z.strictObject({
  id: CompanionId,
  name: DisplayText,
  version: Semver,
  license: License,
  author: z.string().min(1).max(LIMITS.maxTitleLength),
  description: DisplayText.optional(),
})
export type CompanionSummary = z.infer<typeof CompanionSummary>

export const CompanionAssetInfo = z.strictObject({
  path: CompanionAssetPath,
  mime: CompanionMime,
  bytes: z.int().nonnegative().max(LIMITS.maxCompanionAssetBytes),
})
export type CompanionAssetInfo = z.infer<typeof CompanionAssetInfo>

export const CompanionDetail = z.strictObject({
  manifest: CompanionManifest,
  assets: z.array(CompanionAssetInfo).max(LIMITS.maxCompanionFiles),
  totalBytes: z.int().nonnegative().max(LIMITS.maxCompanionPackageBytes),
})
export type CompanionDetail = z.infer<typeof CompanionDetail>

/** Estado actual de la mascota; es también el `data` del evento `companion.state`. */
export const CompanionStateView = z.strictObject({
  state: CompanionState,
  /** Cuándo empezó este estado (ms Unix). */
  since: Millis,
  /** Compañero elegido; `null` es «sin mascota» (el valor por omisión). */
  selected: CompanionId.nullable(),
})
export type CompanionStateView = z.infer<typeof CompanionStateView>

const Selected = CompanionId.nullable()

export const companionMethods = {
  /** Paquetes válidos en `<datos>/companions/`, los que no lo son (con el motivo) y el elegido. */
  'companion.list': {
    params: z.strictObject({}),
    result: z.strictObject({
      companions: z.array(CompanionSummary).max(LIMITS.maxCompanions),
      invalid: z
        .array(z.strictObject({ id: lineText(64), reason: lineText(256) }))
        .max(LIMITS.maxCompanions),
      selected: Selected,
    }),
  },
  'companion.get': {
    params: z.strictObject({ id: CompanionId }),
    result: z.strictObject({ companion: CompanionDetail }),
  },
  /** Elige el compañero (se guarda) o `null` para «sin mascota». `NOT_FOUND` si no existe o no es válido. */
  'companion.select': {
    params: z.strictObject({ id: Selected }),
    result: z.strictObject({ selected: Selected }),
  },
  /**
   * Un recurso del paquete: sus bytes en base64 (hasta `maxCompanionAssetBytes`, una sola respuesta) y su tipo,
   * ya comprobado por los bytes. SVG se valida (sin scripts ni referencias externas) pero el cliente debe
   * dibujarlo siempre como imagen (`<img>` con un `Blob`/`data:`), nunca incrustado ni en `<object>`.
   */
  'companion.asset': {
    params: z.strictObject({ id: CompanionId, path: CompanionAssetPath }),
    result: z.strictObject({
      mime: CompanionMime,
      bytes: z.int().nonnegative().max(LIMITS.maxCompanionAssetBytes),
      data: z.string().max(Math.ceil(LIMITS.maxCompanionAssetBytes / 3) * 4),
    }),
  },
  'companion.state': {
    params: z.strictObject({}),
    result: CompanionStateView,
  },
} as const

export type CompanionMethodName = keyof typeof companionMethods
export const COMPANION_METHOD_NAMES = Object.keys(companionMethods) as CompanionMethodName[]
