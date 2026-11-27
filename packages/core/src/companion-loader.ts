import {
  type CompanionAssetInfo,
  CompanionAssetPath,
  type CompanionDetail,
  CompanionId,
  type CompanionManifest,
  type CompanionMime,
  type CompanionSummary,
  LIMITS,
} from '@nexo/contracts'
import {
  type CompanionImage,
  checkSheetFits,
  inspectCompanionImage,
  manifestAssetPaths,
  manifestStates,
  parseCompanionManifestText,
} from './companion-rules.ts'
import { isValidUtf8, isWindowsDeviceName } from './file-rules.ts'
import { CompanionError, type CompanionPort } from './ports/companion.ts'

/**
 * Acceso de bajo nivel a los archivos de los paquetes (lo implementa el adaptador `companion-fs`; el falso del
 * testkit, un mapa). Debe rechazar, con `CompanionError`, todo lo que no sea un archivo regular propio del paquete:
 * enlaces simbólicos (en cualquier tramo), enlaces duros, rutas que salen de la carpeta, FIFO, dispositivos...
 */
export interface CompanionFileSource {
  /** Carpetas candidatas, de a lo sumo unas pocas decenas; `problem` si no es una carpeta normal (p. ej. un enlace). */
  packages(): Promise<{ id: string; problem?: string }[]>
  /** Tamaño de un archivo del paquete sin leerlo. `NOT_FOUND` si no existe. */
  size(id: string, path: string): Promise<number>
  /** Contenido de un archivo del paquete; `TOO_LARGE` si pasa de `maxBytes` (también si crece mientras se lee). */
  read(id: string, path: string, maxBytes: number): Promise<Uint8Array>
}

function decodeUtf8(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i] as number
    const len = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4
    let cp = len === 1 ? b : b & (0xff >> (len + 1))
    for (let k = 1; k < len; k++) cp = (cp << 6) | ((bytes[i + k] as number) & 63)
    out += String.fromCodePoint(cp)
    i += len
  }
  return out
}

/** Nombre de carpeta ajeno apto para mostrarlo: sin controles y acotado. */
const printable = (value: string, max: number): string =>
  [...value]
    .map((ch) => {
      const c = ch.codePointAt(0) as number
      return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? '?' : ch
    })
    .join('')
    .slice(0, max)

const validId = (id: string): boolean =>
  CompanionId.safeParse(id).success && !isWindowsDeviceName(id)

const MANIFEST = 'companion.json'

/**
 * `CompanionPort` sobre un `CompanionFileSource`: toda la validación (manifiesto, topes, bytes mágicos, SVG, hojas
 * de sprites) vive aquí, así que el adaptador real y el falso aplican exactamente las mismas reglas.
 */
export class CompanionLoader implements CompanionPort {
  readonly #source: CompanionFileSource

  constructor(source: CompanionFileSource) {
    this.#source = source
  }

  async list(): Promise<{
    companions: CompanionSummary[]
    invalid: { id: string; reason: string }[]
  }> {
    const companions: CompanionSummary[] = []
    const invalid: { id: string; reason: string }[] = []
    const entries = (await this.#source.packages()).slice(0, LIMITS.maxCompanions * 2)
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const entry of entries) {
      if (companions.length >= LIMITS.maxCompanions && invalid.length >= LIMITS.maxCompanions) break
      const reject = (reason: string): void => {
        if (invalid.length < LIMITS.maxCompanions) {
          invalid.push({ id: printable(entry.id, 64), reason: printable(reason, 256) })
        }
      }
      if (entry.problem !== undefined) {
        reject(entry.problem)
        continue
      }
      if (!validId(entry.id)) {
        reject('nombre de carpeta no válido como id (minúsculas, dígitos, - y _)')
        continue
      }
      if (companions.length >= LIMITS.maxCompanions) continue
      try {
        const manifest = await this.#manifest(entry.id)
        await this.#checkSizes(entry.id, manifest)
        companions.push(summaryOf(manifest))
      } catch (error) {
        reject(error instanceof CompanionError ? error.message : 'no se pudo leer el paquete')
      }
    }
    return { companions, invalid }
  }

  async get(id: string): Promise<CompanionDetail> {
    const manifest = await this.#open(id)
    const assets: CompanionAssetInfo[] = []
    let total = 0
    const seen = new Map<string, CompanionImage>()
    for (const [state, asset] of manifestStates(manifest)) {
      let image = seen.get(asset.src)
      if (image === undefined) {
        const bytes = await this.#source.read(id, asset.src, LIMITS.maxCompanionAssetBytes)
        const checked = inspectCompanionImage(bytes, asset.src)
        if (!checked.ok) throw new CompanionError('INVALID', `${state}: ${checked.reason}`)
        image = checked.value
        seen.set(asset.src, image)
        total += bytes.length
        if (total > LIMITS.maxCompanionPackageBytes) {
          throw new CompanionError('TOO_LARGE', 'el paquete pasa del tope de tamaño')
        }
        assets.push({ path: asset.src, mime: image.mime, bytes: bytes.length })
      }
      if (asset.sheet !== undefined) {
        const problem = checkSheetFits(asset.sheet, image)
        if (problem !== undefined) throw new CompanionError('INVALID', `${state}: ${problem}`)
      }
    }
    return { manifest, assets, totalBytes: total }
  }

  async readAsset(id: string, path: string): Promise<{ mime: CompanionMime; bytes: Uint8Array }> {
    const manifest = await this.#open(id)
    if (!CompanionAssetPath.safeParse(path).success) {
      throw new CompanionError('INVALID', 'ruta de recurso no válida')
    }
    if (!manifestAssetPaths(manifest).includes(path)) {
      throw new CompanionError('NOT_FOUND', 'el manifiesto no declara ese recurso')
    }
    const bytes = await this.#source.read(id, path, LIMITS.maxCompanionAssetBytes)
    const image = inspectCompanionImage(bytes, path)
    if (!image.ok) throw new CompanionError('INVALID', image.reason)
    return { mime: image.value.mime, bytes }
  }

  /** Comprueba que la carpeta existe y es normal, y lee su manifiesto. */
  async #open(id: string): Promise<CompanionManifest> {
    if (!validId(id)) throw new CompanionError('NOT_FOUND', 'no existe ese compañero')
    const entry = (await this.#source.packages()).find((e) => e.id === id)
    if (entry === undefined) throw new CompanionError('NOT_FOUND', 'no existe ese compañero')
    if (entry.problem !== undefined) throw new CompanionError('INVALID', entry.problem)
    return this.#manifest(id)
  }

  async #manifest(id: string): Promise<CompanionManifest> {
    let bytes: Uint8Array
    try {
      bytes = await this.#source.read(id, MANIFEST, LIMITS.maxCompanionManifestBytes)
    } catch (error) {
      if (error instanceof CompanionError && error.code === 'NOT_FOUND') {
        throw new CompanionError('INVALID', 'falta companion.json')
      }
      throw error
    }
    if (!isValidUtf8(bytes)) throw new CompanionError('INVALID', 'el manifiesto no es UTF-8 válido')
    const parsed = parseCompanionManifestText(decodeUtf8(bytes), id)
    if (!parsed.ok) throw new CompanionError('INVALID', parsed.reason)
    return parsed.value
  }

  async #checkSizes(id: string, manifest: CompanionManifest): Promise<void> {
    let total = 0
    for (const path of manifestAssetPaths(manifest)) {
      const size = await this.#source.size(id, path)
      if (size > LIMITS.maxCompanionAssetBytes) {
        throw new CompanionError('TOO_LARGE', 'un recurso pasa del tope de tamaño')
      }
      total += size
    }
    if (total > LIMITS.maxCompanionPackageBytes) {
      throw new CompanionError('TOO_LARGE', 'el paquete pasa del tope de tamaño')
    }
  }
}

function summaryOf(m: CompanionManifest): CompanionSummary {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    license: m.license,
    author: m.author.name,
    ...(m.description === undefined ? {} : { description: m.description }),
  }
}
