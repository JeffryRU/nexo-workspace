import type { FsReadParams, FsReadResult, FsStat } from '@nexo/contracts'

export type FileSystemErrorCode =
  /** Ruta mal formada (relativa, con `..`, bytes nulos, rutas de Windows hostiles...). */
  | 'INVALID_PATH'
  /** Fuera de las carpetas permitidas o en una ruta sensible bloqueada. */
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  /** `offset` fuera del archivo o en medio de un carácter UTF-8. */
  | 'INVALID_RANGE'
  /** No es un archivo regular (directorio, FIFO, dispositivo...) o el tipo no admite la codificación pedida. */
  | 'NOT_A_FILE'
  | 'TOO_LARGE'
  /** El archivo cambió entre dos lecturas (`expectMtimeMs`) o mientras se leía. */
  | 'CONFLICT'
  | 'IO'

export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode

  constructor(code: FileSystemErrorCode, message: string) {
    super(message)
    this.name = 'FileSystemError'
    this.code = code
  }
}

/**
 * Lectura de archivos acotada (F4.1). Solo lectura y siempre dentro de un conjunto de carpetas permitidas;
 * la implementación real es `@nexo/adapter-fs-sandbox`. Toda ruta es absoluta. Los errores son `FileSystemError`.
 */
export interface FileSystemPort {
  stat(path: string): Promise<FsStat>
  read(request: FsReadParams): Promise<FsReadResult>
}
