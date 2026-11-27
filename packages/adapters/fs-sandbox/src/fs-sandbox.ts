import { type BigIntStats, constants, realpath } from 'node:fs'
import { type FileHandle, lstat, open } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'
import type { FsReadParams, FsReadResult, FsStat } from '@nexo/contracts'
import {
  checkPathSyntax,
  type FileCodec,
  type FileSource,
  FileSystemError,
  type FileSystemPort,
  isSensitivePath,
  isWithin,
  type PathPlatform,
  pathSegments,
  readFileChunk,
  statFile,
} from '@nexo/core'

export type FsSandboxOptions = {
  /**
   * Carpetas permitidas, consultadas en cada llamada (los espacios de trabajo abiertos cambian). Se resuelven
   * con `realpath`; las que no existen, no son absolutas, son la raíz de una unidad o son sensibles se ignoran.
   */
  roots: () => readonly string[] | Promise<readonly string[]>
  /** Solo para pruebas; por omisión, la plataforma real. */
  platform?: NodeJS.Platform
  /**
   * Política de rutas sensibles; por omisión `isSensitivePath` de core. Otro uso del sandbox (p. ej. el historial
   * de los proveedores, F4.3) puede pasar una distinta, pero entonces debe documentarse en un ADR.
   */
  isSensitive?: (segments: readonly string[]) => boolean
}

/** `realpath` del sistema (en Windows expande nombres cortos 8.3 y uniones; la versión de JS no). */
const realpathNative = promisify(realpath.native)

const codec: FileCodec = {
  utf8: (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('utf8'),
  base64: (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64'),
}

/** Quita el prefijo `\\?\` que `realpath.native` puede devolver en Windows. */
const stripVerbatim = (p: string): string => (/^\\\\\?\\[A-Za-z]:\\/.test(p) ? p.slice(4) : p)

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code

/**
 * `FileSystemPort` real (F4.1): solo lectura, dentro de las carpetas de los espacios de trabajo. Ver
 * `docs/ARCHITECTURE.md`, «fs-sandbox». Orden de defensa: sintaxis de la ruta, `realpath`, contención en una
 * raíz (también ya resuelta), rutas sensibles, y por último abrir con `O_NOFOLLOW` y comprobar el descriptor
 * (`fstat`: archivo regular, mismo `dev`/`ino` que lo comprobado, y que la ruta siga resolviendo igual).
 */
export class FsSandbox implements FileSystemPort {
  readonly #roots: FsSandboxOptions['roots']
  readonly #platform: PathPlatform
  readonly #fold: boolean
  readonly #sensitive: (segments: readonly string[]) => boolean

  constructor(options: FsSandboxOptions) {
    const platform = options.platform ?? process.platform
    this.#roots = options.roots
    this.#platform = platform === 'win32' ? 'win32' : 'posix'
    this.#fold = platform === 'win32' || platform === 'darwin'
    this.#sensitive = options.isSensitive ?? isSensitivePath
  }

  async stat(path: string): Promise<FsStat> {
    const real = await this.#resolve(path)
    const info = await this.#lstat(real)
    if (info.isDirectory()) {
      return { path: real, kind: 'directory', size: 0, mtimeMs: Number(info.mtimeNs) / 1e6 }
    }
    return this.#withFile(real, (source) => statFile(source))
  }

  async read(request: FsReadParams): Promise<FsReadResult> {
    const real = await this.#resolve(request.path)
    const info = await this.#lstat(real)
    if (!info.isFile()) throw new FileSystemError('NOT_A_FILE', 'no es un archivo regular')
    return this.#withFile(real, (source) => readFileChunk(source, request, codec))
  }

  async #allowedRoots(): Promise<string[][]> {
    const out: string[][] = []
    for (const root of await this.#roots()) {
      if (checkPathSyntax(root, this.#platform) !== undefined) continue
      let real: string
      try {
        real = stripVerbatim(await realpathNative(root))
      } catch {
        continue
      }
      const segments = pathSegments(real, this.#platform)
      // La raíz de una unidad abriría todo el disco; una carpeta sensible, sus secretos.
      if (segments.length === 0 || this.#sensitive(segments)) continue
      out.push(segments)
    }
    return out
  }

  #inside(roots: string[][], segments: string[]): boolean {
    return roots.some((r) => isWithin(r, segments, this.#fold))
  }

  /** Ruta real (sin enlaces) de `path`, ya comprobada contra las raíces y la política de rutas sensibles. */
  async #resolve(path: string): Promise<string> {
    const reason = checkPathSyntax(path, this.#platform)
    if (reason !== undefined) throw new FileSystemError('INVALID_PATH', reason)
    const lexical = pathSegments(path, this.#platform)
    if (this.#sensitive(lexical)) throw new FileSystemError('FORBIDDEN', 'ruta protegida')
    const roots = await this.#allowedRoots()
    let real: string
    try {
      real = stripVerbatim(await realpathNative(path))
    } catch (error) {
      const code = errno(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // No revela si existe algo fuera de las raíces.
        const probable = await this.#probableReal(path, lexical)
        if (!this.#inside(roots, probable) || this.#sensitive(probable)) {
          throw new FileSystemError('FORBIDDEN', 'fuera de las raíces')
        }
        throw new FileSystemError('NOT_FOUND', 'no existe')
      }
      if (code === 'ELOOP') throw new FileSystemError('INVALID_PATH', 'enlaces simbólicos en bucle')
      if (code === 'EACCES' || code === 'EPERM') {
        throw new FileSystemError('FORBIDDEN', 'sin permiso')
      }
      throw new FileSystemError('IO', 'no se pudo resolver la ruta')
    }
    const segments = pathSegments(real, this.#platform)
    if (!this.#inside(roots, segments) || this.#sensitive(segments)) {
      throw new FileSystemError('FORBIDDEN', 'fuera de las raíces o protegida')
    }
    return real
  }

  /**
   * Segmentos de dónde caería una ruta inexistente: el ancestro más cercano que existe, resuelto con `realpath`
   * (en Windows expande nombres cortos 8.3), más lo que falta. Así se compara con las raíces ya resueltas.
   */
  async #probableReal(path: string, lexical: string[]): Promise<string[]> {
    let current = path
    const missing: string[] = []
    for (let depth = 0; depth < 4096; depth++) {
      const parent = dirname(current)
      missing.unshift(basename(current))
      if (parent === current) break
      current = parent
      try {
        const real = stripVerbatim(await realpathNative(current))
        return [...pathSegments(real, this.#platform), ...missing]
      } catch {
        // sigue subiendo
      }
    }
    return lexical
  }

  async #lstat(real: string): Promise<BigIntStats> {
    let info: BigIntStats
    try {
      info = await lstat(real, { bigint: true })
    } catch (error) {
      const code = errno(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new FileSystemError('NOT_FOUND', 'no existe')
      }
      throw new FileSystemError('IO', 'no se pudo leer la ruta')
    }
    if (!info.isFile() && !info.isDirectory()) {
      throw new FileSystemError('NOT_A_FILE', 'no es un archivo regular ni una carpeta')
    }
    return info
  }

  /** Abre `real` comprobando el descriptor y cierra siempre. Cambios durante `use` son `CONFLICT`. */
  async #withFile<T>(real: string, use: (source: FileSource) => Promise<T>): Promise<T> {
    const before = await this.#lstat(real)
    let handle: FileHandle | undefined
    try {
      // O_NONBLOCK: abrir un FIFO que se coló tras la comprobación no debe colgar el daemon.
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      try {
        handle = await open(real, flags)
      } catch (error) {
        const code = errno(error)
        if (code === 'ELOOP') {
          throw new FileSystemError('FORBIDDEN', 'el destino pasó a ser un enlace')
        }
        if (code === 'ENOENT') throw new FileSystemError('NOT_FOUND', 'no existe')
        if (code === 'EACCES' || code === 'EPERM') {
          throw new FileSystemError('FORBIDDEN', 'sin permiso')
        }
        throw new FileSystemError('IO', 'no se pudo abrir')
      }
      const fd = handle
      const opened = await fd.stat({ bigint: true })
      if (!opened.isFile()) throw new FileSystemError('NOT_A_FILE', 'no es un archivo regular')
      // Windows puede dar `ino` 0: entonces solo cuenta el tipo.
      if (opened.ino !== 0n && (opened.ino !== before.ino || opened.dev !== before.dev)) {
        throw new FileSystemError('CONFLICT', 'el archivo cambió mientras se abría')
      }
      // Un tramo intermedio pudo pasar a enlace entre `realpath` y `open`.
      let again: string
      try {
        again = stripVerbatim(await realpathNative(real))
      } catch {
        throw new FileSystemError('CONFLICT', 'el archivo cambió mientras se abría')
      }
      if (again !== real) throw new FileSystemError('CONFLICT', 'la ruta cambió mientras se abría')
      const source: FileSource = {
        path: real,
        name: basename(real),
        size: Number(opened.size),
        mtimeMs: Number(opened.mtimeNs) / 1e6,
        async read(offset, length) {
          const buffer = Buffer.allocUnsafe(length)
          let filled = 0
          while (filled < length) {
            const { bytesRead } = await fd.read(buffer, filled, length - filled, offset + filled)
            if (bytesRead === 0) break
            filled += bytesRead
          }
          return buffer.subarray(0, filled)
        },
      }
      const result = await use(source)
      const after = await fd.stat({ bigint: true })
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
        throw new FileSystemError('CONFLICT', 'el archivo cambió mientras se leía')
      }
      return result
    } finally {
      await handle?.close().catch(() => {})
    }
  }
}
