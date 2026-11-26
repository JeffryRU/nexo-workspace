import { z } from 'zod'
import { LIMITS } from './limits.ts'

/**
 * Archivos del daemon (F4.1): `fs.stat` y `fs.read`, solo lectura y siempre dentro de las carpetas de los
 * espacios de trabajo abiertos (ver `docs/ARCHITECTURE.md`, «fs-sandbox»). Los métodos viven en `fsMethods`;
 * `methods.ts` los suma al registro del protocolo.
 */

const Path = z.string().min(1).max(LIMITS.maxPathLength)
const Millis = z.number().nonnegative().finite()
const Bytes = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Tipo detectado por firma (bytes iniciales) y extensión. `svg` es texto, pero se muestra como imagen. */
export const FILE_TYPES = [
  'markdown',
  'text',
  'png',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'pdf',
  'binary',
] as const
export const FileType = z.enum(FILE_TYPES)
export type FileType = z.infer<typeof FileType>

/** Tipos cuyo contenido se puede pedir como texto UTF-8. */
export const TEXT_FILE_TYPES: readonly FileType[] = ['markdown', 'text', 'svg']

export const FsEncoding = z.enum(['utf8', 'base64'])
export type FsEncoding = z.infer<typeof FsEncoding>

/** Tope de tamaño de un tipo de archivo (`fs.read` lo rechaza con `PAYLOAD_TOO_LARGE` si lo pasa). */
export function maxBytesForFileType(type: FileType): number {
  switch (type) {
    case 'markdown':
    case 'text':
      return LIMITS.maxFsTextBytes
    case 'svg':
      return LIMITS.maxFsSvgBytes
    case 'png':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return LIMITS.maxFsImageBytes
    case 'pdf':
      return LIMITS.maxFsPdfBytes
    case 'binary':
      return LIMITS.maxFsBinaryBytes
  }
}

export const FsStat = z.strictObject({
  /** Ruta resuelta (`realpath`): la que se lee de verdad, ya sin enlaces simbólicos. */
  path: Path,
  kind: z.enum(['file', 'directory']),
  size: Bytes,
  mtimeMs: Millis,
  /** Solo en archivos. */
  type: FileType.optional(),
  mime: z.string().min(1).max(128).optional(),
  /** Tope de tamaño del tipo; `tooLarge` si `size` lo pasa (entonces `fs.read` falla). */
  maxBytes: Bytes.optional(),
  tooLarge: z.boolean().optional(),
})
export type FsStat = z.infer<typeof FsStat>

export const FsReadParams = z.strictObject({
  path: Path,
  /** Byte desde el que leer (0 por omisión). Con `utf8` debe caer en un límite de carácter. */
  offset: Bytes.optional(),
  /** Bytes a leer, como máximo; se recorta al trozo permitido por la codificación. */
  length: z.int().min(1).max(LIMITS.maxFsChunkBytes).optional(),
  /** Por omisión `utf8` en markdown, text y svg, y `base64` en el resto (`utf8` en un binario es `INVALID_PARAMS`). */
  encoding: FsEncoding.optional(),
  /** Si el `mtimeMs` del archivo ya no es este (cambió entre trozos), `CONFLICT`. */
  expectMtimeMs: Millis.optional(),
})
export type FsReadParams = z.infer<typeof FsReadParams>

export const FsReadResult = z.strictObject({
  path: Path,
  size: Bytes,
  mtimeMs: Millis,
  type: FileType,
  mime: z.string().min(1).max(128),
  offset: Bytes,
  /** Bytes del archivo que cubre `data` (el siguiente `offset` es `offset + length`). */
  length: Bytes,
  encoding: FsEncoding,
  data: z.string().max(LIMITS.maxMessageBytes),
  /** `true` si `offset + length` llegó al final del archivo. */
  eof: z.boolean(),
})
export type FsReadResult = z.infer<typeof FsReadResult>

export const fsMethods = {
  'fs.stat': { params: z.strictObject({ path: Path }), result: FsStat },
  'fs.read': { params: FsReadParams, result: FsReadResult },
} as const

export type FsMethodName = keyof typeof fsMethods
