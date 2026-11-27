import { CompanionAssetPath } from '@nexo/contracts'
import {
  CompanionError,
  type CompanionFileSource,
  CompanionLoader,
  type CompanionSelectionStore,
  isWindowsDeviceName,
} from '@nexo/core'
import type { CompanionFiles } from './companion-package.ts'

/** Origen de archivos en memoria: aplica las mismas comprobaciones de ruta que `companion-fs`. */
export class FakeCompanionSource implements CompanionFileSource {
  readonly entries = new Map<string, { files: CompanionFiles; problem?: string }>()

  put(id: string, files: CompanionFiles): void {
    this.entries.set(id, { files })
  }

  /** Una carpeta que no es normal (p. ej. un enlace simbólico): sale como no válida. */
  putProblem(id: string, problem = 'es un enlace simbólico: no se sigue'): void {
    this.entries.set(id, { files: {}, problem })
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  async packages(): Promise<{ id: string; problem?: string }[]> {
    return [...this.entries].map(([id, e]) => ({
      id,
      ...(e.problem === undefined ? {} : { problem: e.problem }),
    }))
  }

  async size(id: string, path: string): Promise<number> {
    return this.#file(id, path).length
  }

  async read(id: string, path: string, maxBytes: number): Promise<Uint8Array> {
    const bytes = this.#file(id, path)
    if (bytes.length > maxBytes) throw new CompanionError('TOO_LARGE', 'el archivo pasa del tope')
    return bytes.slice()
  }

  #file(id: string, path: string): Uint8Array {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new CompanionError('NOT_FOUND', 'no existe ese compañero')
    if (path !== 'companion.json') {
      if (!CompanionAssetPath.safeParse(path).success) {
        throw new CompanionError('INVALID', 'ruta de recurso no válida')
      }
      if (path.split('/').some((s) => isWindowsDeviceName(s))) {
        throw new CompanionError('INVALID', 'nombre reservado de Windows')
      }
    }
    const bytes = entry.files[path]
    if (bytes === undefined) throw new CompanionError('NOT_FOUND', 'no existe')
    return bytes
  }
}

/** Falso de `CompanionPort`: el cargador real de core sobre un origen en memoria (no miente sobre las reglas). */
export function createFakeCompanions(): { port: CompanionLoader; source: FakeCompanionSource } {
  const source = new FakeCompanionSource()
  return { port: new CompanionLoader(source), source }
}

/** Persistencia en memoria del compañero elegido; `failNext` simula un disco que falla. */
export class FakeCompanionSelectionStore implements CompanionSelectionStore {
  value: string | null
  saves: (string | null)[] = []
  failNext = false
  /** Si se pone, `save` espera a esta promesa (para probar carreras). */
  gate: Promise<void> | undefined

  constructor(initial: string | null = null) {
    this.value = initial
  }

  async load(): Promise<string | null> {
    return this.value
  }

  async save(id: string | null): Promise<void> {
    await this.gate
    if (this.failNext) {
      this.failNext = false
      throw new Error('disco lleno')
    }
    this.value = id
    this.saves.push(id)
  }
}
