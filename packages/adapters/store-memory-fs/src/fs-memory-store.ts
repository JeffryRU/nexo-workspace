import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectMemory } from '@nexo/contracts'
import {
  type ClockPort,
  emptyProjectMemory,
  type LoggerPort,
  MemoryStoreError,
  type MemoryStorePort,
  normalizeProjectPath,
  type ProjectMemorySummary,
} from '@nexo/core'

const IS_WINDOWS = process.platform === 'win32'

/** Tope por omisión del archivo de un proyecto. */
export const DEFAULT_MAX_PROJECT_BYTES = 4 * 1024 * 1024
/** Apartados que se conservan; los más viejos se borran. */
const MAX_QUARANTINED = 20
const FILE_NAME = /^[0-9a-f]{32}\.json$/

export type FsMemoryStoreOptions = {
  /** Directorio de estado del usuario (el mismo del daemon); la memoria vive en `<stateDir>/memory`. */
  stateDir: string
  /** Tope de bytes del archivo de un proyecto (4 MiB por omisión). */
  maxProjectBytes?: number
  logger?: LoggerPort
  clock?: ClockPort
}

type ReadOutcome =
  | { status: 'missing' }
  | { status: 'ok'; memory: ProjectMemory; bytes: number }
  | { status: 'bad'; reason: 'corrupt' | 'future' | 'too-large' | 'mismatch' }

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Almacén de memoria en disco: un archivo JSON por proyecto en `<stateDir>/memory/<hash>.json`.
 *
 * - El nombre es el SHA-256 (32 hex) de la carpeta normalizada con `normalizeProjectPath`; así no hay
 *   caracteres ilegales, nombres reservados de Windows ni recorridos de ruta, y `C:\Work` = `c:/work/`.
 * - Escritura atómica: archivo temporal en el mismo directorio y `rename`.
 * - Un archivo ilegible (JSON roto, esquema inválido, versión futura, pasado de tamaño o de otro proyecto)
 *   se aparta a `memory/quarantine/` y se registra con `warn`; el proyecto sigue como vacío. Nunca lanza.
 * - Las operaciones de un mismo proyecto van en serie dentro del proceso.
 */
export class FsMemoryStore implements MemoryStorePort {
  readonly #dir: string
  readonly #quarantine: string
  readonly #maxBytes: number
  readonly #logger: LoggerPort | undefined
  readonly #clock: ClockPort | undefined
  readonly #chains = new Map<string, Promise<unknown>>()

  constructor(options: FsMemoryStoreOptions) {
    this.#dir = join(options.stateDir, 'memory')
    this.#quarantine = join(this.#dir, 'quarantine')
    this.#maxBytes = options.maxProjectBytes ?? DEFAULT_MAX_PROJECT_BYTES
    this.#logger = options.logger
    this.#clock = options.clock
  }

  load(project: string): Promise<ProjectMemory> {
    const key = normalizeProjectPath(project)
    return this.#serial(key, () => this.#load(key))
  }

  update(
    project: string,
    change: (current: ProjectMemory) => ProjectMemory | Promise<ProjectMemory>,
  ): Promise<ProjectMemory> {
    const key = normalizeProjectPath(project)
    return this.#serial(key, async () => {
      const next = await change(await this.#load(key))
      const parsed = ProjectMemory.safeParse(next)
      if (!parsed.success || parsed.data.project !== key) {
        throw new MemoryStoreError('INVALID', 'el registro no es válido o cambia de proyecto')
      }
      const raw = `${JSON.stringify(parsed.data)}\n`
      if (Buffer.byteLength(raw) > this.#maxBytes) {
        throw new MemoryStoreError(
          'TOO_LARGE',
          `el registro pasa del tope de ${this.#maxBytes} bytes por proyecto`,
        )
      }
      try {
        await this.#ensureDir()
        await this.#writeAtomic(this.#file(key), raw)
      } catch (error) {
        throw new MemoryStoreError('IO', 'no se pudo escribir la memoria', { cause: error })
      }
      return parsed.data
    })
  }

  remove(project: string): Promise<void> {
    const key = normalizeProjectPath(project)
    return this.#serial(key, async () => {
      try {
        await rm(this.#file(key), { force: true })
      } catch (error) {
        throw new MemoryStoreError('IO', 'no se pudo borrar la memoria', { cause: error })
      }
    })
  }

  async list(): Promise<ProjectMemorySummary[]> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch {
      return []
    }
    const out: ProjectMemorySummary[] = []
    for (const name of names) {
      if (!FILE_NAME.test(name)) continue
      const outcome = await this.#read(join(this.#dir, name)).catch(() => undefined)
      if (outcome?.status !== 'ok') continue
      const m = outcome.memory
      out.push({
        project: m.project,
        updatedAt: m.updatedAt,
        observations: m.observations.length,
        bytes: outcome.bytes,
      })
    }
    return out
  }

  // ---- internos ----

  #file(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32)
    return join(this.#dir, `${hash}.json`)
  }

  #now(): number {
    return this.#clock?.now() ?? Date.now()
  }

  #serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (this.#chains.get(key) ?? Promise.resolve()).then(run, run)
    const tail = result.catch(() => {})
    this.#chains.set(key, tail)
    // Sin esto el mapa crecería con cada proyecto tocado.
    void tail.then(() => {
      if (this.#chains.get(key) === tail) this.#chains.delete(key)
    })
    return result
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#dir, { recursive: true, ...(IS_WINDOWS ? {} : { mode: 0o700 }) })
    if (!IS_WINDOWS) await chmod(this.#dir, 0o700)
  }

  async #read(file: string): Promise<ReadOutcome> {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
      throw error
    }
    // Un archivo mucho mayor que el tope no se lee entero: no es nuestro.
    if (!info.isFile() || info.size > this.#maxBytes * 2)
      return { status: 'bad', reason: 'too-large' }
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
      throw error
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      // SyntaxError, o RangeError por anidado excesivo: en cualquier caso, no es un registro nuestro.
      return { status: 'bad', reason: 'corrupt' }
    }
    const version = (json as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version > 1) return { status: 'bad', reason: 'future' }
    const parsed = ProjectMemory.safeParse(json)
    if (!parsed.success) return { status: 'bad', reason: 'corrupt' }
    return { status: 'ok', memory: parsed.data, bytes: info.size }
  }

  async #load(key: string): Promise<ProjectMemory> {
    const file = this.#file(key)
    let outcome: ReadOutcome
    try {
      outcome = await this.#read(file)
    } catch (error) {
      throw new MemoryStoreError('IO', 'no se pudo leer la memoria', { cause: error })
    }
    if (outcome.status === 'ok') {
      if (outcome.memory.project === key) return outcome.memory
      outcome = { status: 'bad', reason: 'mismatch' }
    }
    if (outcome.status === 'bad') await this.#setAside(file, outcome.reason)
    return emptyProjectMemory(key, this.#now())
  }

  /** Aparta un archivo ilegible a `quarantine/` y lo registra; los fallos al apartarlo no se propagan. */
  async #setAside(file: string, reason: string): Promise<void> {
    const base = file.slice(this.#dir.length + 1, -'.json'.length)
    const target = join(
      this.#quarantine,
      `${base}.${reason}.${this.#now()}.${randomBytes(3).toString('hex')}.json`,
    )
    try {
      await mkdir(this.#quarantine, { recursive: true, ...(IS_WINDOWS ? {} : { mode: 0o700 }) })
      await rename(file, target)
      this.#logger?.warn('memoria ilegible apartada', { file: `${base}.json`, reason, target })
      await this.#pruneQuarantine()
    } catch (error) {
      this.#logger?.warn('no se pudo apartar la memoria ilegible', {
        file: `${base}.json`,
        reason,
        error: error instanceof Error ? error.message : String(error),
      })
      await rm(file, { force: true }).catch(() => {})
    }
  }

  async #pruneQuarantine(): Promise<void> {
    const names = (await readdir(this.#quarantine)).filter((n) => n.endsWith('.json'))
    if (names.length <= MAX_QUARANTINED) return
    const dated = await Promise.all(
      names.map(async (n) => ({
        n,
        t: await stat(join(this.#quarantine, n)).then(
          (s) => s.mtimeMs,
          () => 0,
        ),
      })),
    )
    dated.sort((a, b) => a.t - b.t)
    for (const { n } of dated.slice(0, dated.length - MAX_QUARANTINED)) {
      await rm(join(this.#quarantine, n), { force: true })
    }
  }

  async #writeAtomic(path: string, content: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmp, content, IS_WINDOWS ? {} : { mode: 0o600 })
      // En Windows el rename sobre un archivo recién leído puede fallar un instante (antivirus, indexador).
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(tmp, path)
          return
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES'))
            throw error
          await wait(15 * (attempt + 1))
        }
      }
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }
}
