import type { FsApi } from '@nexo/client'
import type { FileType } from '@nexo/contracts'

/** Tipos que el visor sabe mostrar; el resto (`binary`) solo informa. */
export type ViewableType = Exclude<FileType, 'binary'>

/** Tipos que se muestran como `<img>` (el SVG también: llega como datos y nunca se inserta en el DOM). */
export function isImageType(type: FileType): boolean {
  return type === 'png' || type === 'jpeg' || type === 'gif' || type === 'webp' || type === 'svg'
}

export type ViewerLoad =
  | {
      status: 'ok'
      path: string
      type: ViewableType
      mime: string
      size: number
      mtimeMs: number
      bytes: Uint8Array
      /** El archivo creció mientras se leía y se paró en el tope. */
      truncated: boolean
    }
  | { status: 'directory'; path: string }
  | { status: 'too-large'; path: string; size: number; max: number }
  | { status: 'binary'; path: string; size: number; mime: string }

type Reader = Pick<FsApi, 'stat' | 'readAll'>

const READ_ATTEMPTS = 3

/**
 * Lee un archivo para el visor: `fs.stat` primero (así un directorio, un binario o un archivo por encima del tope
 * no se descargan) y luego `fs.read` por trozos. Un archivo que cambia durante la lectura (`CONFLICT`, que sale de
 * `expectMtimeMs`) se vuelve a leer entero unas pocas veces.
 */
export async function loadViewerFile(
  fs: Reader,
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<ViewerLoad> {
  const signal = options.signal === undefined ? undefined : { signal: options.signal }
  const st = await fs.stat(path, signal)
  if (st.kind === 'directory') return { status: 'directory', path: st.path }
  if (st.tooLarge === true && st.maxBytes !== undefined) {
    return { status: 'too-large', path: st.path, size: st.size, max: st.maxBytes }
  }
  if (st.type === 'binary') {
    return { status: 'binary', path: st.path, size: st.size, mime: st.mime ?? '' }
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const file = await fs.readAll(path, {
        ...(st.maxBytes === undefined ? {} : { maxBytes: st.maxBytes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (file.type === 'binary') {
        return { status: 'binary', path: file.path, size: file.size, mime: file.mime }
      }
      return {
        status: 'ok',
        path: file.path,
        type: file.type,
        mime: file.mime,
        size: file.size,
        mtimeMs: file.mtimeMs,
        bytes: file.bytes,
        truncated: file.truncated,
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code !== 'CONFLICT' || attempt >= READ_ATTEMPTS || options.signal?.aborted === true) {
        throw error
      }
    }
  }
}

/** Tipos MIME de imagen que se pasan al `Blob`; cualquier otro se entrega como binario genérico. */
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/

export function imageBlobType(mime: string): string {
  return IMAGE_MIME.test(mime) ? mime : 'application/octet-stream'
}

/** Más texto que esto no se pinta (un `<pre>` de varios MiB congela la página). */
export const MAX_TEXT_CHARS = 1_000_000

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}
