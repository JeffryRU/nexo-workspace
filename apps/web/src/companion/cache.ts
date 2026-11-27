import type {
  CompanionManifest,
  CompanionSheet,
  CompanionState,
  MethodParams,
  MethodResult,
} from '@nexo/contracts'
import { COMPANION_STATES } from '@nexo/contracts'
import { type DrawableAsset, decodeBase64, isCompanionMime, manifestPaths } from './view.ts'

/** Lo mínimo del cliente que usa el caché (así las pruebas lo suplen sin red). */
export type CompanionSource = {
  get(
    p: MethodParams<'companion.get'>,
    o?: { timeoutMs?: number },
  ): Promise<MethodResult<'companion.get'>>
  asset(
    p: MethodParams<'companion.asset'>,
    o?: { timeoutMs?: number },
  ): Promise<MethodResult<'companion.asset'>>
}

/** Un compañero cargado: su manifiesto y una URL de objeto por cada imagen que se pudo traer. */
export type LoadedCompanion = {
  id: string
  manifest: CompanionManifest
  /** Imagen lista por estado declarado (los estados cuyo recurso falló no están). */
  assets: Partial<Record<CompanionState, DrawableAsset>>
  /** Rutas del manifiesto que no se pudieron traer. */
  failed: string[]
}

export type CacheOptions = {
  /** Compañeros que se guardan a la vez (el elegido nunca se expulsa). */
  maxPackages?: number
  timeoutMs?: number
  createUrl?: (blob: Blob) => string
  revokeUrl?: (url: string) => void
}

type Entry = {
  promise: Promise<LoadedCompanion>
  loaded: LoadedCompanion | undefined
  urls: string[]
  disposed: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Caché de compañeros por id (F5.3). Pide `companion.get` una vez y `companion.asset` por cada imagen del
 * manifiesto, y con los bytes crea un `Blob` y una URL de objeto para un `<img>` (nunca se incrusta un SVG).
 *
 * - Las cargas en curso se comparten (dos `load` del mismo id piden una vez).
 * - Una carga que falla no se guarda; si el compañero se descarta (`forget`, expulsión, `disposeAll`) mientras
 *   se carga, **no llega a crear ninguna URL**: así no hay fugas ni se dibuja un compañero que ya no toca.
 * - Toda URL creada se revoca al expulsar o descartar; `liveUrls` cuenta las que siguen vivas.
 */
export class CompanionAssetCache {
  readonly #source: CompanionSource
  readonly #max: number
  readonly #timeoutMs: number
  readonly #createUrl: (blob: Blob) => string
  readonly #revokeUrl: (url: string) => void
  readonly #entries = new Map<string, Entry>()
  #current: string | null = null
  #live = 0

  constructor(source: CompanionSource, options: CacheOptions = {}) {
    this.#source = source
    this.#max = Math.max(1, options.maxPackages ?? 3)
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#createUrl = options.createUrl ?? ((blob) => URL.createObjectURL(blob))
    this.#revokeUrl = options.revokeUrl ?? ((url) => URL.revokeObjectURL(url))
  }

  /** URLs de objeto creadas y aún sin revocar. */
  get liveUrls(): number {
    return this.#live
  }

  get size(): number {
    return this.#entries.size
  }

  /** El compañero que se está mostrando: no se expulsa. */
  setCurrent(id: string | null): void {
    this.#current = id
  }

  peek(id: string): LoadedCompanion | undefined {
    return this.#entries.get(id)?.loaded
  }

  load(id: string): Promise<LoadedCompanion> {
    const existing = this.#entries.get(id)
    if (existing !== undefined) {
      // Recién usado: pasa al final del orden de expulsión.
      this.#entries.delete(id)
      this.#entries.set(id, existing)
      return existing.promise
    }
    const entry: Entry = {
      promise: undefined as unknown as Promise<LoadedCompanion>,
      loaded: undefined,
      urls: [],
      disposed: false,
    }
    entry.promise = this.#run(id, entry)
    this.#entries.set(id, entry)
    entry.promise.catch(() => {
      if (this.#entries.get(id) === entry) this.#entries.delete(id)
    })
    return entry.promise
  }

  /** Olvida un compañero (cambió o ya no existe): revoca sus URL y la próxima vez se pide de nuevo. */
  forget(id: string): void {
    const entry = this.#entries.get(id)
    if (entry === undefined) return
    this.#entries.delete(id)
    this.#dispose(entry)
  }

  /** Olvida los que ya no coinciden con la versión que anuncia `companion.list`. */
  invalidateStale(summaries: readonly { id: string; version: string }[]): string[] {
    const stale: string[] = []
    for (const [id, entry] of this.#entries) {
      const now = summaries.find((s) => s.id === id)
      if (
        entry.loaded !== undefined &&
        now !== undefined &&
        now.version !== entry.loaded.manifest.version
      ) {
        stale.push(id)
      }
    }
    for (const id of stale) this.forget(id)
    return stale
  }

  disposeAll(): void {
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    for (const entry of entries) this.#dispose(entry)
  }

  #dispose(entry: Entry): void {
    entry.disposed = true
    for (const url of entry.urls) {
      this.#live--
      this.#revokeUrl(url)
    }
    entry.urls = []
    entry.loaded = undefined
  }

  async #run(id: string, entry: Entry): Promise<LoadedCompanion> {
    const detail = await this.#source.get({ id }, { timeoutMs: this.#timeoutMs })
    const manifest = detail.companion.manifest
    if (manifest.id !== id) throw new Error('el manifiesto no es del compañero pedido')
    const paths = manifestPaths(manifest)
    const fetched = await Promise.all(paths.map((path) => this.#fetchBlob(id, path)))
    if (entry.disposed) throw new Error('compañero descartado')

    const urlByPath = new Map<string, string>()
    const failed: string[] = []
    paths.forEach((path, i) => {
      const blob = fetched[i]
      if (blob === undefined) {
        failed.push(path)
        return
      }
      const url = this.#createUrl(blob)
      this.#live++
      entry.urls.push(url)
      urlByPath.set(path, url)
    })
    const assets: Partial<Record<CompanionState, DrawableAsset>> = {}
    for (const state of COMPANION_STATES) {
      const decl = manifest.states[state]
      const url = decl === undefined ? undefined : urlByPath.get(decl.src)
      if (decl !== undefined && url !== undefined) {
        assets[state] = { url, sheet: decl.sheet as CompanionSheet | undefined }
      }
    }
    if (Object.keys(assets).length === 0)
      throw new Error('ninguna imagen del compañero se pudo leer')
    const loaded: LoadedCompanion = { id, manifest, assets, failed }
    entry.loaded = loaded
    this.#evict()
    return loaded
  }

  /** Trae un recurso y lo convierte en `Blob`; cualquier fallo (red, mime raro, base64 corrupto) es `undefined`. */
  async #fetchBlob(id: string, path: string): Promise<Blob | undefined> {
    try {
      const r = await this.#source.asset({ id, path }, { timeoutMs: this.#timeoutMs })
      if (!isCompanionMime(r.mime)) return undefined
      const bytes = decodeBase64(r.data, r.bytes)
      if (bytes === undefined || bytes.length === 0) return undefined
      return new Blob([bytes as BlobPart], { type: r.mime })
    } catch {
      return undefined
    }
  }

  #evict(): void {
    for (const [id, entry] of this.#entries) {
      if (this.#entries.size <= this.#max) return
      if (id === this.#current || entry.loaded === undefined) continue
      this.#entries.delete(id)
      this.#dispose(entry)
    }
  }
}
