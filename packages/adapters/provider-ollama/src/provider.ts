import { randomUUID } from 'node:crypto'
import { LIMITS, type ModelInfo, type ProviderCapabilities, Token } from '@nexo/contracts'
import {
  type AgentOpenOptions,
  AgentProviderError,
  type AgentProviderPort,
  type AgentProviderSession,
} from '@nexo/core'
import { type FetchLike, OllamaClient, OllamaRequestError } from './client.ts'
import { DEFAULT_LIMITS, type LogEntry, OllamaSession, type SessionLimits } from './session.ts'

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

/** «Esfuerzo» de Ollama: si el modelo razona (`think`). Sin valor, decide el modelo. */
export const OLLAMA_EFFORTS = ['think', 'no-think'] as const

export type OllamaProviderOptions = {
  /** Base de la API de Ollama (solo http/https, sin credenciales). */
  baseUrl?: string
  /** `fetch` inyectable; por omisión el global. */
  fetch?: FetchLike
  /** Registro de diagnóstico. */
  log?: (entry: LogEntry) => void
  /** Plazo de `GET /api/tags` (comprobar disponibilidad y listar modelos). */
  probeTimeoutMs?: number
  /** Cuánto se reutiliza el resultado de la última comprobación. */
  probeCacheMs?: number
  limits?: Partial<SessionLimits>
  now?: () => number
}

/** Valida una URL base de Ollama; lanza `Error` con un mensaje legible si no sirve. */
export function parseOllamaUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('no es una URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('solo http o https')
  if (url.username !== '' || url.password !== '') throw new Error('no admite usuario ni contraseña')
  if (url.search !== '' || url.hash !== '') throw new Error('no admite parámetros ni fragmento')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

type Probe = { at: number; available: boolean; models: string[]; reason: string | undefined }

/** Fábrica del proveedor Ollama. No hace ninguna petición hasta que se consulta o se abre una sesión. */
export function createOllamaProvider(options: OllamaProviderOptions = {}): AgentProviderPort {
  return new OllamaProvider(options)
}

class OllamaProvider implements AgentProviderPort {
  readonly id = 'ollama'
  readonly displayName = 'Ollama'
  readonly #client: OllamaClient
  readonly #origin: string
  readonly #options: OllamaProviderOptions
  readonly #limits: SessionLimits
  #probe: Probe | undefined
  #inFlight: Promise<Probe> | undefined

  constructor(options: OllamaProviderOptions) {
    this.#options = options
    const baseUrl = parseOllamaUrl(options.baseUrl ?? DEFAULT_OLLAMA_URL)
    this.#origin = new URL(baseUrl).origin
    const fetchFn = options.fetch ?? ((input, init) => fetch(input, init))
    this.#client = new OllamaClient({ baseUrl, fetch: fetchFn })
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.#probeNow()).available
  }

  /** Por qué no está disponible, según la última comprobación (`undefined` si lo está o aún no se probó). */
  unavailableReason(): string | undefined {
    return this.#probe?.available === false ? this.#probe.reason : undefined
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const probe = await this.#probeNow()
    const models = toModels(probe.models)
    const first = models[0]
    return {
      models,
      ...(first === undefined ? {} : { defaultModel: first.id }),
      efforts: [...OLLAMA_EFFORTS],
      permissionModes: ['ask'],
      resume: false,
      warmup: false,
      streaming: true,
    }
  }

  async open(open: AgentOpenOptions): Promise<AgentProviderSession> {
    const invalid = (message: string) => new AgentProviderError('INVALID_OPTIONS', message)
    if (typeof open.cwd !== 'string' || open.cwd === '') throw invalid('cwd vacío')
    if (open.resume !== undefined) throw invalid('Ollama no guarda sesiones: no se puede reanudar')
    if (open.model !== undefined && !Token.safeParse(open.model).success) {
      throw invalid('modelo inválido')
    }
    if (open.effort !== undefined && !(OLLAMA_EFFORTS as readonly string[]).includes(open.effort)) {
      throw invalid(`esfuerzo desconocido: ${open.effort}`)
    }
    if (open.permissionMode !== undefined && open.permissionMode !== 'ask') {
      throw invalid('Ollama no usa herramientas: solo admite el modo de permisos «ask»')
    }
    const probe = await this.#probeNow()
    if (!probe.available) {
      throw new AgentProviderError('UNAVAILABLE', probe.reason ?? 'Ollama no está disponible')
    }
    const model = open.model ?? toModels(probe.models)[0]?.id
    if (model === undefined) {
      throw invalid('Ollama no tiene modelos instalados: instala uno con «ollama pull <modelo>»')
    }
    return new OllamaSession({
      id: `ollama-${randomUUID()}`,
      client: this.#client,
      model,
      ...(open.effort === undefined ? {} : { effort: open.effort }),
      ...(open.effort === undefined ? {} : { think: open.effort === 'think' }),
      limits: this.#limits,
      log: (entry) => this.#options.log?.(entry),
    })
  }

  #probeNow(): Promise<Probe> {
    const now = (this.#options.now ?? Date.now)()
    const cached = this.#probe
    if (cached !== undefined && now - cached.at < (this.#options.probeCacheMs ?? 2000)) {
      return Promise.resolve(cached)
    }
    this.#inFlight ??= this.#runProbe().finally(() => {
      this.#inFlight = undefined
    })
    return this.#inFlight
  }

  async #runProbe(): Promise<Probe> {
    const timeoutMs = this.#options.probeTimeoutMs ?? 1500
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new DOMException('plazo', 'TimeoutError')), timeoutMs)
    let result: Omit<Probe, 'at'>
    try {
      const models = await this.#client.listModels(ctrl.signal)
      result = { available: true, models, reason: undefined }
    } catch (error) {
      result = {
        available: false,
        models: [],
        reason: this.#reasonOf(error, ctrl.signal, timeoutMs),
      }
      this.#options.log?.({ level: 'debug', message: result.reason ?? 'Ollama no disponible' })
    } finally {
      clearTimeout(timer)
    }
    this.#probe = { ...result, at: (this.#options.now ?? Date.now)() }
    return this.#probe
  }

  #reasonOf(error: unknown, signal: AbortSignal, timeoutMs: number): string {
    const where = this.#origin
    if (signal.aborted) {
      return `Ollama no respondió en ${(timeoutMs / 1000).toFixed(1)} s en ${where}.`
    }
    if (error instanceof OllamaRequestError) {
      if (error.kind === 'http')
        return `Ollama respondió con el estado ${error.status ?? '?'} en ${where}.`
      if (error.kind === 'protocol') return `La respuesta de ${where} no parece de Ollama.`
    }
    return `Ollama no responde en ${where}: ¿está en marcha? Inicia el servicio con «ollama serve» o ajusta NEXO_OLLAMA_URL.`
  }
}

function toModels(names: readonly string[]): ModelInfo[] {
  const seen = new Set<string>()
  const models: ModelInfo[] = []
  for (const name of names) {
    if (seen.has(name) || !Token.safeParse(name).success) continue
    seen.add(name)
    models.push({
      id: name,
      label: name.length > LIMITS.maxTitleLength ? name.slice(0, LIMITS.maxTitleLength) : name,
    })
    if (models.length >= LIMITS.maxProviderModels) break
  }
  return models
}
