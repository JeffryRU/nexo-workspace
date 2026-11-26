import type { FsReadParams, FsReadResult, FsStat } from '@nexo/contracts'
import {
  checkPathSyntax,
  type FileCodec,
  type FileSource,
  FileSystemError,
  type FileSystemPort,
  isSensitivePath,
  isWithin,
  pathSegments,
  readFileChunk,
  statFile,
} from '@nexo/core'
import { decodeUtf8, encodeBase64, encodeUtf8 } from './bytes.ts'

const codec: FileCodec = { utf8: decodeUtf8, base64: encodeBase64 }

/**
 * Falso en memoria de `FileSystemPort` con rutas POSIX absolutas. Aplica las mismas reglas puras de core que
 * el adaptador real (sintaxis, rutas sensibles, raíces), pero no tiene enlaces simbólicos ni E/S.
 */
export class FakeFileSystem implements FileSystemPort {
  readonly files = new Map<string, { data: Uint8Array; mtimeMs: number }>()
  readonly dirs = new Set<string>()
  /** Carpetas permitidas; se pueden cambiar entre llamadas. */
  roots: string[]
  /** Todo cambio de archivo incrementa el reloj de modificación, como haría el disco. */
  #clock = 1000

  constructor(roots: string[] = []) {
    this.roots = roots
  }

  /** Crea o reemplaza un archivo (y sus carpetas). */
  setFile(path: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? encodeUtf8(content) : content
    this.files.set(path, { data, mtimeMs: this.#clock++ })
    this.mkdir(path.slice(0, path.lastIndexOf('/')))
  }

  mkdir(path: string): void {
    const parts = path.split('/').filter((p) => p !== '')
    for (let i = 1; i <= parts.length; i++) this.dirs.add(`/${parts.slice(0, i).join('/')}`)
  }

  async stat(path: string): Promise<FsStat> {
    const real = this.#resolve(path)
    if (this.dirs.has(real)) return { path: real, kind: 'directory', size: 0, mtimeMs: 0 }
    return statFile(this.#source(real))
  }

  async read(request: FsReadParams): Promise<FsReadResult> {
    const real = this.#resolve(request.path)
    if (this.dirs.has(real)) throw new FileSystemError('NOT_A_FILE', 'es una carpeta')
    return readFileChunk(this.#source(real), request, codec)
  }

  #source(real: string): FileSource {
    const file = this.files.get(real)
    if (file === undefined) throw new FileSystemError('NOT_FOUND', 'no existe')
    return {
      path: real,
      name: real.slice(real.lastIndexOf('/') + 1),
      size: file.data.length,
      mtimeMs: file.mtimeMs,
      read: async (offset, length) => file.data.subarray(offset, offset + length),
    }
  }

  #resolve(path: string): string {
    const reason = checkPathSyntax(path, 'posix')
    if (reason !== undefined) throw new FileSystemError('INVALID_PATH', reason)
    const segments = pathSegments(path, 'posix')
    if (isSensitivePath(segments)) throw new FileSystemError('FORBIDDEN', 'ruta protegida')
    const roots = this.roots
      .filter((r) => checkPathSyntax(r, 'posix') === undefined)
      .map((r) => pathSegments(r, 'posix'))
      .filter((r) => r.length > 0 && !isSensitivePath(r))
    if (!roots.some((r) => isWithin(r, segments, false))) {
      throw new FileSystemError('FORBIDDEN', 'fuera de las raíces')
    }
    const real = `/${segments.join('/')}`
    if (!this.files.has(real) && !this.dirs.has(real)) {
      throw new FileSystemError('NOT_FOUND', 'no existe')
    }
    return real
  }
}
