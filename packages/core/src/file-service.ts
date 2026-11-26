import type { MethodParams, MethodResult } from '@nexo/contracts'
import { DomainError } from './errors.ts'
import { FileSystemError, type FileSystemPort } from './ports/file-system.ts'

const MESSAGES = {
  INVALID_PATH: 'ruta no válida',
  INVALID_RANGE: 'rango no válido',
  FORBIDDEN: 'ruta no permitida: fuera de las carpetas de los espacios de trabajo o protegida',
  NOT_FOUND: 'no existe',
  NOT_A_FILE: 'no es un archivo legible de ese modo',
  TOO_LARGE: 'el archivo supera el tope de su tipo',
  CONFLICT: 'el archivo cambió mientras se leía',
} as const

/** Casos de uso `fs.stat` y `fs.read`: traduce los errores del puerto a los códigos del protocolo. */
export class FileService {
  readonly #fs: FileSystemPort

  constructor(fs: FileSystemPort) {
    this.#fs = fs
  }

  readonly handlers = {
    'fs.stat': (p: MethodParams<'fs.stat'>) => this.#guard(() => this.#fs.stat(p.path)),
    'fs.read': (p: MethodParams<'fs.read'>) => this.#guard(() => this.#fs.read(p)),
  } satisfies {
    'fs.stat': (p: MethodParams<'fs.stat'>) => Promise<MethodResult<'fs.stat'>>
    'fs.read': (p: MethodParams<'fs.read'>) => Promise<MethodResult<'fs.read'>>
  }

  async #guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (!(error instanceof FileSystemError)) throw error
      switch (error.code) {
        case 'INVALID_PATH':
          throw new DomainError('INVALID_PARAMS', MESSAGES.INVALID_PATH, { reason: error.code })
        case 'INVALID_RANGE':
          throw new DomainError('INVALID_PARAMS', MESSAGES.INVALID_RANGE, { reason: error.code })
        case 'NOT_A_FILE':
          throw new DomainError('INVALID_PARAMS', MESSAGES.NOT_A_FILE, { reason: error.code })
        case 'FORBIDDEN':
          throw new DomainError('FORBIDDEN', MESSAGES.FORBIDDEN, { reason: error.code })
        case 'NOT_FOUND':
          throw new DomainError('NOT_FOUND', MESSAGES.NOT_FOUND, { reason: error.code })
        case 'TOO_LARGE':
          throw new DomainError('PAYLOAD_TOO_LARGE', MESSAGES.TOO_LARGE, { reason: error.code })
        case 'CONFLICT':
          throw new DomainError('CONFLICT', MESSAGES.CONFLICT, { reason: error.code })
        default:
          // `IO` y lo desconocido: nada del mensaje original llega al cliente (puede traer rutas).
          throw error
      }
    }
  }
}

export type FileHandlers = FileService['handlers']
