import {
  type FsReadParams,
  type FsReadResult,
  type FsStat,
  LIMITS,
  maxBytesForFileType,
  TEXT_FILE_TYPES,
} from '@nexo/contracts'
import { detectFileType, SNIFF_BYTES, startsOnBoundary, utf8SafeLength } from './file-rules.ts'
import { FileSystemError } from './ports/file-system.ts'

/** Un archivo regular ya resuelto y abierto por el adaptador (o por el falso): solo falta leerlo. */
export type FileSource = {
  /** Ruta resuelta (la que se informa al cliente). */
  path: string
  /** Nombre del archivo, para la extensión. */
  name: string
  size: number
  mtimeMs: number
  /** Lee hasta `length` bytes desde `offset`; devuelve menos solo si el archivo se acortó. */
  read(offset: number, length: number): Promise<Uint8Array>
}

/** Codificadores de la plataforma (core no tiene `Buffer` ni `TextDecoder`). */
export type FileCodec = {
  utf8(bytes: Uint8Array): string
  base64(bytes: Uint8Array): string
}

async function sniff(src: FileSource) {
  const sample =
    src.size === 0 ? new Uint8Array(0) : await src.read(0, Math.min(src.size, SNIFF_BYTES))
  return detectFileType(sample, src.name, src.size <= SNIFF_BYTES)
}

/** `fs.stat` de un archivo regular. */
export async function statFile(src: FileSource): Promise<FsStat> {
  const { type, mime } = await sniff(src)
  const maxBytes = maxBytesForFileType(type)
  return {
    path: src.path,
    kind: 'file',
    size: src.size,
    mtimeMs: src.mtimeMs,
    type,
    mime,
    maxBytes,
    tooLarge: src.size > maxBytes,
  }
}

/** `fs.read` de un trozo: tope por tipo, codificación, límite de carácter UTF-8 y comprobación de cambios. */
export async function readFileChunk(
  src: FileSource,
  params: FsReadParams,
  codec: FileCodec,
): Promise<FsReadResult> {
  const { type, mime } = await sniff(src)
  if (src.size > maxBytesForFileType(type)) {
    throw new FileSystemError('TOO_LARGE', 'el archivo supera el tope de su tipo')
  }
  if (params.expectMtimeMs !== undefined && params.expectMtimeMs !== src.mtimeMs) {
    throw new FileSystemError('CONFLICT', 'el archivo cambió desde la lectura anterior')
  }
  const isText = TEXT_FILE_TYPES.includes(type)
  const encoding = params.encoding ?? (isText ? 'utf8' : 'base64')
  if (encoding === 'utf8' && !isText) {
    throw new FileSystemError('NOT_A_FILE', 'el archivo no es texto: pídelo en base64')
  }
  const offset = params.offset ?? 0
  if (offset > src.size) throw new FileSystemError('INVALID_RANGE', 'offset fuera del archivo')
  const cap = encoding === 'utf8' ? LIMITS.maxFsTextChunkBytes : LIMITS.maxFsChunkBytes
  // Un trozo UTF-8 de menos de 4 bytes podría no contener ni un carácter entero.
  const want = Math.max(Math.min(params.length ?? cap, cap), encoding === 'utf8' ? 4 : 1)
  const count = Math.min(want, src.size - offset)
  const bytes = count === 0 ? new Uint8Array(0) : await src.read(offset, count)
  if (bytes.length < count) throw new FileSystemError('CONFLICT', 'el archivo se acortó al leerlo')
  const first = bytes[0]
  if (encoding === 'utf8' && first !== undefined && !startsOnBoundary(first)) {
    throw new FileSystemError('INVALID_RANGE', 'offset en medio de un carácter UTF-8')
  }
  const keep =
    encoding === 'utf8' ? utf8SafeLength(bytes, offset + bytes.length >= src.size) : bytes.length
  const body = keep === bytes.length ? bytes : bytes.subarray(0, keep)
  return {
    path: src.path,
    size: src.size,
    mtimeMs: src.mtimeMs,
    type,
    mime,
    offset,
    length: keep,
    encoding,
    data: encoding === 'utf8' ? codec.utf8(body) : codec.base64(body),
    eof: offset + keep >= src.size,
  }
}
