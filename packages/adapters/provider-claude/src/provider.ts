import { stat } from 'node:fs/promises'
import {
  type ModelInfo,
  type PermissionMode,
  type ProviderCapabilities,
  Token,
} from '@nexo/contracts'
import {
  type AgentOpenOptions,
  AgentProviderError,
  type AgentProviderPort,
  type AgentProviderSession,
  checkPreparedMemory,
} from '@nexo/core'
import { ClaudeHistory } from './history.ts'
import { ClaudeMemoryInjection } from './memory-injection.ts'
import { createSecretRedactor, type SecretRedactor } from './redact.ts'
import { createSdkTransport } from './sdk-transport.ts'
import { ClaudeSession, type LogEntry } from './session.ts'
import { line } from './text.ts'
import { ClaudeTranslator } from './translator.ts'
import {
  type ClaudePermissionMode,
  type ClaudeTransport,
  TransportError,
  type TransportModel,
} from './transport.ts'

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Lista estática de respaldo (alias que acepta Claude Code). `capabilities()` la sustituye por la que
 * expone el SDK (`Query.supportedModels()`) cuando se puede consultar.
 */
export const STATIC_MODELS: readonly ModelInfo[] = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
]

const MODES: Readonly<Record<PermissionMode, ClaudePermissionMode>> = {
  ask: 'default',
  'accept-edits': 'acceptEdits',
  plan: 'plan',
  bypass: 'bypassPermissions',
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODELS_RETRY_MS = 60_000

const UNAVAILABLE_MESSAGE =
  'Claude Code no está disponible: falta @anthropic-ai/claude-agent-sdk o su ejecutable ' +
  '(configura pathToClaudeCodeExecutable).'

export type ClaudeProviderOptions = {
  /** Transporte del SDK; por omisión el real (`@anthropic-ai/claude-agent-sdk`). */
  transport?: ClaudeTransport
  /** Entorno del daemon: de él sale la autenticación (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`). */
  env?: Readonly<Record<string, string | undefined>>
  /** Ejecutable de Claude Code; por omisión el que trae el SDK. */
  pathToClaudeCodeExecutable?: string
  /** Registro de diagnóstico; el texto ya llega redactado. */
  log?: (entry: LogEntry) => void
  interruptTimeoutMs?: number
  /** Comprueba que `cwd` sea un directorio al abrir (por omisión sí). */
  checkCwd?: boolean
  now?: () => number
}

/** Fábrica del proveedor Claude. No arranca nada hasta `open` (o `warmUp`). */
export function createClaudeProvider(options: ClaudeProviderOptions = {}): AgentProviderPort {
  return new ClaudeProvider(options)
}

class ClaudeProvider implements AgentProviderPort {
  readonly id = 'claude'
  readonly displayName = 'Claude Code'
  readonly memoryInjection = new ClaudeMemoryInjection()
  readonly history: ClaudeHistory
  readonly warmUp?: (options: { cwd: string }) => Promise<void>
  readonly #transport: ClaudeTransport
  readonly #options: ClaudeProviderOptions
  readonly #redactor: SecretRedactor
  #models: { at: number; models: readonly ModelInfo[]; fromSdk: boolean } | undefined
  #modelsInFlight: Promise<void> | undefined

  constructor(options: ClaudeProviderOptions) {
    this.#options = options
    const env = options.env ?? process.env
    this.#redactor = createSecretRedactor(env)
    this.#transport =
      options.transport ??
      createSdkTransport({
        env,
        ...(options.pathToClaudeCodeExecutable === undefined
          ? {}
          : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
      })
    this.history = new ClaudeHistory({
      transport: this.#transport,
      scrub: this.#redactor.scrub,
      redact: this.#redactor.redact,
    })
    const warm = this.#transport.warmUp?.bind(this.#transport)
    if (warm !== undefined) {
      this.warmUp = async ({ cwd }) => {
        await this.#checkCwd(cwd)
        await this.#guard(() => warm({ cwd }))
      }
    }
  }

  isAvailable(): Promise<boolean> {
    return this.#transport.isAvailable().catch(() => false)
  }

  async capabilities(): Promise<ProviderCapabilities> {
    await this.#refreshModels()
    const models = this.#models?.models ?? STATIC_MODELS
    return {
      models: [...models],
      efforts: [...CLAUDE_EFFORTS],
      permissionModes: ['ask', 'accept-edits', 'plan', 'bypass'],
      resume: true,
      warmup: this.warmUp !== undefined,
      streaming: true,
    }
  }

  async open(open: AgentOpenOptions): Promise<AgentProviderSession> {
    const invalid = (message: string) => new AgentProviderError('INVALID_OPTIONS', message)
    if (typeof open.cwd !== 'string' || open.cwd === '') throw invalid('cwd vacío')
    if (open.model !== undefined && !Token.safeParse(open.model).success) {
      throw invalid('modelo inválido')
    }
    if (open.effort !== undefined && !(CLAUDE_EFFORTS as readonly string[]).includes(open.effort)) {
      throw invalid(`esfuerzo desconocido: ${open.effort}`)
    }
    const mode = open.permissionMode ?? 'ask'
    if (!Object.hasOwn(MODES, mode)) throw invalid('modo de permisos desconocido')
    if (open.resume !== undefined && !SESSION_ID.test(open.resume)) {
      throw invalid('ficha de reanudar desconocida')
    }
    const memory = checkPreparedMemory(open.memory)
    await this.#checkCwd(open.cwd)
    if (!(await this.isAvailable()))
      throw new AgentProviderError('UNAVAILABLE', UNAVAILABLE_MESSAGE)

    let session: ClaudeSession | undefined
    const early: string[] = []
    const redact = this.#redactor.redact
    const translator = new ClaudeTranslator({
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      scrub: this.#redactor.scrub,
      redact,
    })
    const transport = await this.#guard(() =>
      this.#transport.start({
        cwd: open.cwd,
        ...(open.model === undefined ? {} : { model: open.model }),
        ...(open.effort === undefined ? {} : { effort: open.effort }),
        permissionMode: MODES[mode],
        ...(open.resume === undefined ? {} : { resume: open.resume }),
        ...(memory === undefined ? {} : { memory }),
        canUseTool: (ask) =>
          session === undefined
            ? Promise.resolve({ behavior: 'deny', message: 'La sesión aún no está lista.' })
            : session.ask(ask),
        onStderr: (data) => {
          const text = redact(data)
          if (session === undefined) early.push(text)
          else session.noteStderr(text)
          this.#options.log?.({ level: 'debug', message: text.slice(0, 2048) })
        },
      }),
    )
    session = new ClaudeSession({
      transport,
      translator,
      redact,
      ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
      interruptTimeoutMs: this.#options.interruptTimeoutMs ?? 3000,
    })
    for (const text of early) session.noteStderr(text)
    session.start()
    return session
  }

  async #checkCwd(cwd: string): Promise<void> {
    if (cwd === '') throw new AgentProviderError('INVALID_OPTIONS', 'cwd vacío')
    if (this.#options.checkCwd === false) return
    const info = await stat(cwd).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      throw new AgentProviderError('INVALID_OPTIONS', 'la carpeta de trabajo no existe')
    }
  }

  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof AgentProviderError) throw error
      if (error instanceof TransportError && error.code === 'UNKNOWN_SESSION') {
        throw new AgentProviderError('INVALID_OPTIONS', 'ficha de reanudar desconocida', {
          cause: error,
        })
      }
      const detail = this.#redactor.redact(error instanceof Error ? error.message : String(error))
      throw new AgentProviderError(
        'UNAVAILABLE',
        `${UNAVAILABLE_MESSAGE} (${detail.slice(0, 300)})`,
        { cause: error },
      )
    }
  }

  async #refreshModels(): Promise<void> {
    const now = Date.now()
    const cached = this.#models
    if (cached !== undefined && (cached.fromSdk || now - cached.at < MODELS_RETRY_MS)) return
    const list = this.#transport.listModels?.bind(this.#transport)
    if (list === undefined) {
      this.#models = { at: now, models: STATIC_MODELS, fromSdk: false }
      return
    }
    this.#modelsInFlight ??= (async () => {
      try {
        if (!(await this.isAvailable())) throw new Error('no disponible')
        const found = (await list({ cwd: process.cwd() })).flatMap(toModelInfo)
        this.#models =
          found.length > 0
            ? { at: Date.now(), models: found.slice(0, 128), fromSdk: true }
            : { at: Date.now(), models: STATIC_MODELS, fromSdk: false }
      } catch {
        this.#models = { at: Date.now(), models: STATIC_MODELS, fromSdk: false }
      } finally {
        this.#modelsInFlight = undefined
      }
    })()
    await this.#modelsInFlight
  }
}

function toModelInfo(m: TransportModel): ModelInfo[] {
  const id = Token.safeParse(m.id)
  if (!id.success) return []
  const efforts = (m.efforts ?? []).filter((e) => Token.safeParse(e).success).slice(0, 8)
  const label = line(m.label ?? '', 256)
  return [
    {
      id: id.data,
      ...(label === '' ? {} : { label }),
      ...(efforts.length === 0 ? {} : { efforts }),
    },
  ]
}
