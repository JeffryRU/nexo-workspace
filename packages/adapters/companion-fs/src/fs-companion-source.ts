import { type BigIntStats, constants, type Dirent, realpath } from 'node:fs'
import { type FileHandle, lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CompanionAssetPath, CompanionId } from '@nexo/contracts'
import { CompanionError, type CompanionFileSource, isWindowsDeviceName } from '@nexo/core'

export type FsCompanionSourceOptions = {
  /** Carpeta `<datos>/companions`; cada paquete es una subcarpeta `<id>/`. Si no existe, no hay compañeros. */
  dir: string
  /** Solo para pruebas; por omisión, la plataforma real. */
  platform?: NodeJS.Platform
}

const realpathNative = promisify(realpath.native)
const MANIFEST = 'companion.json'
/** Entradas de la carpeta que se miran como mucho (una carpeta enorme no frena al daemon). */
const MAX_ENTRIES = 1024

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code
const stripVerbatim = (p: string): string => (/^\\\\\?\\[A-Za-z]:\\/.test(p) ? p.slice(4) : p)

/**
 * `CompanionFileSource` real (F5.2). Solo lectura y solo de lo que declara un manifiesto. Defensa por capas: la
 * ruta relativa pasa por el esquema (sin `..`, absolutas, UNC, `C:`, flujos alternos, nombres de dispositivo de
 * Windows); cada tramo se comprueba con `lstat` (nada de enlaces simbólicos ni uniones); el archivo ha de ser
 * regular y sin enlaces duros; se abre con `O_NOFOLLOW`, se comprueba el descriptor (`fstat`: mismo `dev`/`ino`)
 * y que la ruta siga resolviendo igual, y la lectura tiene tope (también si el archivo crece).
 */
export class FsCompanionSource implements CompanionFileSource {
  readonly #dir: string
  readonly #fold: boolean

  constructor(options: FsCompanionSourceOptions) {
    this.#dir = options.dir
    const platform = options.platform ?? process.platform
    this.#fold = platform === 'win32' || platform === 'darwin'
  }

  async packages(): Promise<{ id: string; problem?: string }[]> {
    let base: string
    try {
      base = await this.#base()
    } catch {
      return []
    }
    let entries: Dirent[]
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      return []
    }
    const out: { id: string; problem?: string }[] = []
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) {
        out.push({ id: entry.name, problem: 'es un enlace simbólico: no se sigue' })
      } else if (entry.isDirectory()) {
        out.push({ id: entry.name })
      }
    }
    return out
  }

  async size(id: string, path: string): Promise<number> {
    const { info } = await this.#locate(id, path)
    return Number(info.size)
  }

  async read(id: string, path: string, maxBytes: number): Promise<Uint8Array> {
    const { full, info } = await this.#locate(id, path)
    if (Number(info.size) > maxBytes)
      throw new CompanionError('TOO_LARGE', 'el archivo pasa del tope')
    let handle: FileHandle | undefined
    try {
      // O_NONBLOCK: un FIFO que se colara tras la comprobación no debe colgar el daemon.
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      try {
        handle = await open(full, flags)
      } catch (error) {
        const code = errno(error)
        if (code === 'ELOOP') throw new CompanionError('INVALID', 'enlace simbólico: no se sigue')
        if (code === 'ENOENT') throw new CompanionError('NOT_FOUND', 'no existe')
        throw new CompanionError('IO', 'no se pudo abrir')
      }
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile()) throw new CompanionError('INVALID', 'no es un archivo regular')
      if (opened.ino !== 0n && (opened.ino !== info.ino || opened.dev !== info.dev)) {
        throw new CompanionError('IO', 'el archivo cambió mientras se abría')
      }
      // Un tramo intermedio pudo pasar a enlace entre `lstat` y `open`.
      let again: string
      try {
        again = stripVerbatim(await realpathNative(full))
      } catch {
        throw new CompanionError('IO', 'el archivo cambió mientras se abría')
      }
      if (this.#norm(again) !== this.#norm(full)) {
        throw new CompanionError('INVALID', 'la ruta resuelve fuera del paquete')
      }
      const buffer = Buffer.allocUnsafe(maxBytes + 1)
      let filled = 0
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      if (filled > maxBytes) throw new CompanionError('TOO_LARGE', 'el archivo pasa del tope')
      const after = await handle.stat({ bigint: true })
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
        throw new CompanionError('IO', 'el archivo cambió mientras se leía')
      }
      return Uint8Array.from(buffer.subarray(0, filled))
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  #norm(p: string): string {
    return this.#fold ? p.toLowerCase() : p
  }

  /** Carpeta de los paquetes, ya resuelta (la ruta del usuario puede ser un enlace: es suya, no del paquete). */
  async #base(): Promise<string> {
    return stripVerbatim(await realpathNative(this.#dir))
  }

  /** Comprueba tramo a tramo que `path` es un archivo regular propio del paquete `id`. */
  async #locate(id: string, path: string): Promise<{ full: string; info: BigIntStats }> {
    if (!CompanionId.safeParse(id).success || isWindowsDeviceName(id)) {
      throw new CompanionError('NOT_FOUND', 'no existe ese compañero')
    }
    if (path !== MANIFEST) {
      if (!CompanionAssetPath.safeParse(path).success) {
        throw new CompanionError('INVALID', 'ruta de recurso no válida')
      }
      if (path.split('/').some((s) => isWindowsDeviceName(s))) {
        throw new CompanionError('INVALID', 'nombre reservado de Windows')
      }
    }
    let current: string
    try {
      current = join(await this.#base(), id)
    } catch {
      throw new CompanionError('NOT_FOUND', 'no existe ese compañero')
    }
    const segments = path.split('/')
    const walk = [...segments]
    const last = walk.pop() as string
    for (const part of ['', ...walk]) {
      if (part !== '') current = join(current, part)
      const dir = await this.#lstat(current)
      if (dir.isSymbolicLink()) throw new CompanionError('INVALID', 'enlace simbólico: no se sigue')
      if (!dir.isDirectory()) throw new CompanionError('INVALID', 'se esperaba una carpeta')
    }
    const full = join(current, last)
    const info = await this.#lstat(full)
    if (info.isSymbolicLink()) throw new CompanionError('INVALID', 'enlace simbólico: no se sigue')
    if (!info.isFile()) throw new CompanionError('INVALID', 'no es un archivo regular')
    if (info.nlink > 1n) throw new CompanionError('INVALID', 'enlace duro: no se admite')
    return { full, info }
  }

  async #lstat(path: string): Promise<BigIntStats> {
    try {
      return await lstat(path, { bigint: true })
    } catch (error) {
      const code = errno(error)
      if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new CompanionError('NOT_FOUND', 'no existe')
      throw new CompanionError('IO', 'no se pudo leer la ruta')
    }
  }
}
