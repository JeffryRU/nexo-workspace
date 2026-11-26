import { statSync } from 'node:fs'
import {
  type ModelInfo,
  type PermissionMode,
  type ProviderCapabilities,
  ProviderSessionToken,
  Token,
} from '@nexo/contracts'
import {
  type AgentOpenOptions,
  AgentProviderError,
  type AgentProviderPort,
  type AgentProviderSession,
} from '@nexo/core'
import { parseModels } from './models.ts'
import { type AgyLauncher, runAgy, spawnAgyProcess } from './process.ts'
import { AGY_VERIFIED_VERSION } from './protocol.ts'
import { createSecretRedactor } from './redact.ts'
import { type AgyCommand, type ResolveFs, resolveAgyCommand } from './resolve.ts'
import {
  AgySession,
  DEFAULT_LIMITS,
  type LogEntry,
  PERMISSION_FLAGS,
  type SessionLimits,
} from './session.ts'
import { line } from './text.ts'

/** Esfuerzos de `--effort` en `agy` 1.2.0 (`agy --help`: low|medium|high). */
export const AGY_EFFORTS = ['low', 'medium', 'high'] as const

/** Ids de conversación de Antigravity: UUID (supuesto no verificado; la prueba en vivo lo comprueba). */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AntigravityProviderOptions = {
  /** Entorno con el que se lanza `agy` (el daemon pasa el suyo sin las variables `NEXO_*`). */
  env: Readonly<Record<string, string | undefined>>
  log?: (entry: LogEntry) => void
  /** Ruta o nombre del ejecutable (`NEXO_AGY_EXECUTABLE`); por omisión `agy` en el PATH. */
  executable?: string
  /** Lanzador del proceso (pruebas); por omisión `spawn` sin shell. */
  launcher?: AgyLauncher
  platform?: NodeJS.Platform
  resolveFs?: ResolveFs
  /** Plazo de la comprobación de disponibilidad (`agy models`). */
  probeTimeoutMs?: number
  /** Cuánto se reutiliza una comprobación correcta; una fallida, como mucho 3 s. */
  probeCacheMs?: number
  limits?: Partial<SessionLimits>
  /** Tope de una línea JSON de `agy`, en caracteres. */
  maxLineLength?: number
  now?: () => number
}

type Probe = {
  at: number
  available: boolean
  reason: string | undefined
  command: AgyCommand | undefined
  models: ModelInfo[]
  defaultModel: string | undefined
}

const NONE: Omit<Probe, 'at'> = {
  available: false,
  reason: undefined,
  command: undefined,
  models: [],
  defaultModel: undefined,
}

const NOT_INSTALLED =
  'Instala la CLI de Antigravity («agy») e inicia sesión con ella (o fija NEXO_AGY_EXECUTABLE a su ruta).'
const NOT_LOGGED_IN =
  'Antigravity no tiene la sesión iniciada: ejecuta «agy» en una terminal e inicia sesión. Nexo no inicia sesión por ti.'
const LOGIN_HINT =
  /unauthenticated|unauthori[sz]ed|\b401\b|not (?:logged|signed) in|sign[- ]?in|log[- ]?in|credential|oauth/i

/** Fábrica del proveedor Antigravity. No lanza nada hasta que se consulta la disponibilidad o se abre una sesión. */
export function createAntigravityProvider(options: AntigravityProviderOptions): AgentProviderPort {
  return new AntigravityProvider(options)
}

class AntigravityProvider implements AgentProviderPort {
  readonly id = 'antigravity'
  readonly displayName = 'Antigravity'
  readonly #o: AntigravityProviderOptions
  readonly #log: (entry: LogEntry) => void
  readonly #redactor: ReturnType<typeof createSecretRedactor>
  readonly #limits: SessionLimits
  readonly #launcher: AgyLauncher
  #probe: Probe | undefined
  #inFlight: Promise<Probe> | undefined

  constructor(options: AntigravityProviderOptions) {
    this.#o = options
    this.#log = options.log ?? (() => {})
    this.#redactor = createSecretRedactor(options.env)
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.#launcher = options.launcher ?? spawnAgyProcess
  }

  async isAvailable(): Promise<boolean> {
    return (await this.#probeNow()).available
  }

  unavailableReason(): string | undefined {
    return this.#probe?.available === false ? this.#probe.reason : undefined
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const probe = await this.#probeNow()
    return {
      models: probe.models,
      ...(probe.defaultModel === undefined ? {} : { defaultModel: probe.defaultModel }),
      efforts: [...AGY_EFFORTS],
      permissionModes: ['ask', 'accept-edits', 'plan', 'bypass'],
      resume: true,
      warmup: false,
      streaming: true,
    }
  }

  async open(open: AgentOpenOptions): Promise<AgentProviderSession> {
    const invalid = (message: string) => new AgentProviderError('INVALID_OPTIONS', message)
    if (typeof open.cwd !== 'string' || open.cwd === '') throw invalid('cwd vacío')
    if (!isDirectory(open.cwd)) throw invalid(`la carpeta no existe: ${open.cwd}`)
    if (open.model !== undefined && !Token.safeParse(open.model).success) {
      throw invalid('modelo inválido')
    }
    if (
      open.permissionMode !== undefined &&
      !Object.hasOwn(PERMISSION_FLAGS, open.permissionMode)
    ) {
      throw invalid(`modo de permisos desconocido: ${open.permissionMode}`)
    }
    if (open.effort !== undefined && !(AGY_EFFORTS as readonly string[]).includes(open.effort)) {
      throw invalid(`esfuerzo desconocido: ${open.effort} (valen: ${AGY_EFFORTS.join(', ')})`)
    }
    if (
      open.resume !== undefined &&
      (!ProviderSessionToken.safeParse(open.resume).success || !CONVERSATION_ID.test(open.resume))
    ) {
      throw invalid('ficha de conversación inválida')
    }
    const probe = await this.#probeNow()
    if (!probe.available || probe.command === undefined) {
      throw new AgentProviderError('UNAVAILABLE', probe.reason ?? 'Antigravity no está disponible')
    }
    const mode: PermissionMode = open.permissionMode ?? 'ask'
    return new AgySession({
      launcher: this.#launcher,
      command: probe.command,
      env: this.#o.env,
      cwd: open.cwd,
      resume: open.resume,
      model: open.model,
      effort: open.effort,
      permissionMode: mode,
      limits: this.#limits,
      log: this.#log,
      redactor: this.#redactor,
      maxLineLength: this.#o.maxLineLength ?? 8 * 1024 * 1024,
    })
  }

  #probeNow(): Promise<Probe> {
    const now = (this.#o.now ?? Date.now)()
    const cached = this.#probe
    if (cached !== undefined) {
      const ttl = this.#o.probeCacheMs ?? 30_000
      if (now - cached.at < (cached.available ? ttl : Math.min(ttl, 3000))) {
        return Promise.resolve(cached)
      }
    }
    this.#inFlight ??= this.#runProbe().finally(() => {
      this.#inFlight = undefined
    })
    return this.#inFlight
  }

  async #runProbe(): Promise<Probe> {
    const result = await this.#probeOnce()
    this.#probe = { ...result, at: (this.#o.now ?? Date.now)() }
    if (!result.available) {
      this.#log({ level: 'debug', message: result.reason ?? 'Antigravity no disponible' })
    }
    return this.#probe
  }

  /**
   * `agy models --output-format json`: sirve a la vez de comprobación de sesión (sin sesión falla) y de lista
   * de modelos. Nexo no lee credenciales ni inicia sesión; la salida solo se usa para sacar los ids de modelo.
   */
  async #probeOnce(): Promise<Omit<Probe, 'at'>> {
    const resolved = resolveAgyCommand({
      executable: this.#o.executable,
      env: this.#o.env,
      ...(this.#o.platform === undefined ? {} : { platform: this.#o.platform }),
      ...(this.#o.resolveFs === undefined ? {} : { fs: this.#o.resolveFs }),
    })
    if ('error' in resolved) {
      return { ...NONE, reason: `No se encontró Antigravity: ${resolved.error}. ${NOT_INSTALLED}` }
    }
    const timeoutMs = this.#o.probeTimeoutMs ?? 20_000
    const run = await runAgy({
      launcher: this.#launcher,
      command: resolved,
      args: ['models', '--output-format', 'json'],
      cwd: process.cwd(),
      env: this.#o.env,
      timeoutMs,
      maxChars: 1024 * 1024,
    })
    const tail = this.#redactor.redact(`${run.stderr}\n${run.stdout.slice(0, 500)}`).trim()
    if (run.error !== undefined) {
      return {
        ...NONE,
        reason: line(`No se pudo lanzar «agy»: ${this.#redactor.redact(run.error.message)}`, 500),
      }
    }
    if (run.timedOut) {
      return {
        ...NONE,
        command: resolved,
        reason: `«agy models» no respondió en ${(timeoutMs / 1000).toFixed(0)} s (¿sin red o sin sesión iniciada?). ${NOT_LOGGED_IN}`,
      }
    }
    if (run.exitCode !== 0) {
      if (LOGIN_HINT.test(tail)) return { ...NONE, command: resolved, reason: NOT_LOGGED_IN }
      return {
        ...NONE,
        command: resolved,
        reason: line(
          `«agy models» falló (código ${run.exitCode ?? 'ninguno'}; formato verificado con agy ${AGY_VERIFIED_VERSION})${tail === '' ? '' : `: ${tail.slice(-200)}`}`,
          500,
        ),
      }
    }
    const { models, defaultModel } = parseModels(run.stdout)
    return { available: true, reason: undefined, command: resolved, models, defaultModel }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
