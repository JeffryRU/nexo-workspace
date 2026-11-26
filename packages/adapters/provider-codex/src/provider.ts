import { statSync } from 'node:fs'
import {
  LIMITS,
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
  checkPreparedMemory,
} from '@nexo/core'
import { RpcError } from '@nexo/jsonrpc'
import { CodexClient, type LogEntry } from './client.ts'
import { CodexMemoryInjection } from './memory-injection.ts'
import { type CodexLauncher, spawnCodexProcess } from './process.ts'
import { AccountResult, CODEX_PROTOCOL_VERSION, ModelListResult, ThreadResult } from './protocol.ts'
import { createSecretRedactor } from './redact.ts'
import { type CodexCommand, type ResolveFs, resolveCodexCommand } from './resolve.ts'
import { CodexSession, DEFAULT_LIMITS, type SessionLimits } from './session.ts'
import { line } from './text.ts'

/**
 * Modos de permiso normalizados → política de aprobación y sandbox de Codex (`thread/start`). Es parte del
 * contrato del adaptador (tabla en `docs/ARCHITECTURE.md`, «Proveedor Codex (F3.2)»).
 */
export const PERMISSION_POLICY: Record<
  PermissionMode,
  {
    approvalPolicy: 'untrusted' | 'on-request' | 'never'
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  }
> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  'accept-edits': { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  bypass: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
}

/** Esfuerzos que se ofrecen si Codex no lista ninguno (`model/list` falló). */
export const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

export type CodexProviderOptions = {
  /** Entorno con el que se lanza `codex` (el daemon pasa el suyo sin las variables `NEXO_*`). */
  env: Readonly<Record<string, string | undefined>>
  log?: (entry: LogEntry) => void
  /** Ruta o nombre del ejecutable (`NEXO_CODEX_EXECUTABLE`); por omisión `codex` en el PATH. */
  executable?: string
  /** Lanzador del proceso (pruebas); por omisión `spawn` sin shell. */
  launcher?: CodexLauncher
  platform?: NodeJS.Platform
  resolveFs?: ResolveFs
  /** Plazo de toda la comprobación de disponibilidad (arrancar, `account/read`, `model/list`). */
  probeTimeoutMs?: number
  /** Cuánto se reutiliza una comprobación correcta; una fallida, como mucho 3 s. */
  probeCacheMs?: number
  limits?: Partial<SessionLimits>
  /** Tope de una línea JSON-RPC de Codex, en caracteres. */
  maxLineLength?: number
  now?: () => number
}

type Probe = {
  at: number
  available: boolean
  reason: string | undefined
  command: CodexCommand | undefined
  models: ModelInfo[]
  defaultModel: string | undefined
  efforts: string[]
}

const NONE: Omit<Probe, 'at'> = {
  available: false,
  reason: undefined,
  command: undefined,
  models: [],
  defaultModel: undefined,
  efforts: [],
}

const NOT_INSTALLED =
  'Instala la CLI con «npm i -g @openai/codex» (o fija NEXO_CODEX_EXECUTABLE a su ruta).'
const NOT_LOGGED_IN =
  'Codex no tiene la sesión iniciada: ejecuta «codex login» en una terminal. Nexo no inicia sesión por ti.'

/** Fábrica del proveedor Codex. No lanza nada hasta que se consulta la disponibilidad o se abre una sesión. */
export function createCodexProvider(options: CodexProviderOptions): AgentProviderPort {
  return new CodexProvider(options)
}

class CodexProvider implements AgentProviderPort {
  readonly id = 'codex'
  readonly displayName = 'Codex'
  readonly memoryInjection = new CodexMemoryInjection()
  readonly #o: CodexProviderOptions
  readonly #log: (entry: LogEntry) => void
  readonly #redactor: ReturnType<typeof createSecretRedactor>
  readonly #limits: SessionLimits
  readonly #launcher: CodexLauncher
  #probe: Probe | undefined
  #inFlight: Promise<Probe> | undefined

  constructor(options: CodexProviderOptions) {
    this.#o = options
    this.#log = options.log ?? (() => {})
    this.#redactor = createSecretRedactor(options.env)
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.#launcher = options.launcher ?? spawnCodexProcess
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
      efforts: probe.efforts.length > 0 ? probe.efforts : [...FALLBACK_EFFORTS],
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
    if (open.model !== undefined && !Token.safeParse(open.model).success)
      throw invalid('modelo inválido')
    if (open.permissionMode !== undefined && !(open.permissionMode in PERMISSION_POLICY)) {
      throw invalid(`modo de permisos desconocido: ${open.permissionMode}`)
    }
    if (open.resume !== undefined && !ProviderSessionToken.safeParse(open.resume).success) {
      throw invalid('ficha de sesión inválida')
    }
    const memory = checkPreparedMemory(open.memory)
    const probe = await this.#probeNow()
    if (!probe.available || probe.command === undefined) {
      throw new AgentProviderError('UNAVAILABLE', probe.reason ?? 'Codex no está disponible')
    }
    const efforts = probe.efforts.length > 0 ? probe.efforts : [...FALLBACK_EFFORTS]
    if (open.effort !== undefined && !efforts.includes(open.effort)) {
      throw invalid(`esfuerzo desconocido: ${open.effort} (valen: ${efforts.join(', ')})`)
    }
    const mode: PermissionMode = open.permissionMode ?? 'ask'
    const policy = PERMISSION_POLICY[mode]
    const client = this.#client(probe.command, open.cwd)
    try {
      await client.handshake()
      const common = {
        cwd: open.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ...(open.model === undefined ? {} : { model: open.model }),
        ...(memory === undefined ? {} : { developerInstructions: memory }),
      }
      const started = await client.call(
        open.resume === undefined ? 'thread/start' : 'thread/resume',
        open.resume === undefined
          ? common
          : { threadId: open.resume, excludeTurns: true, ...common },
        ThreadResult,
        this.#limits.requestTimeoutMs,
      )
      const threadId = started.thread.id
      if (!ProviderSessionToken.safeParse(threadId).success) {
        throw new Error('Codex devolvió un id de hilo inválido')
      }
      const model = open.model ?? started.model ?? undefined
      return new CodexSession({
        client,
        threadId,
        model,
        effort: open.effort,
        permissionMode: mode,
        limits: this.#limits,
        log: this.#log,
      })
    } catch (error) {
      const tail = client.stderrTail()
      client.close()
      if (open.resume !== undefined && error instanceof RpcError) {
        throw invalid(`no se pudo reanudar el hilo: ${line(error.message, 300)}`)
      }
      throw new AgentProviderError(
        'UNAVAILABLE',
        `No se pudo abrir la sesión de Codex: ${this.#redactor.redact(error instanceof Error ? error.message : String(error))}${tail === '' ? '' : ` (${tail.slice(-300)})`}`,
      )
    }
  }

  #client(command: CodexCommand, cwd: string): CodexClient {
    return new CodexClient({
      launcher: this.#launcher,
      command,
      cwd,
      env: this.#o.env,
      log: this.#log,
      redactor: this.#redactor,
      requestTimeoutMs: this.#limits.requestTimeoutMs,
      maxLineLength: this.#o.maxLineLength ?? 32 * 1024 * 1024,
      clientVersion: '0.0.0',
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
      this.#log({ level: 'debug', message: result.reason ?? 'Codex no disponible' })
    }
    return this.#probe
  }

  async #probeOnce(): Promise<Omit<Probe, 'at'>> {
    const resolved = resolveCodexCommand({
      executable: this.#o.executable,
      env: this.#o.env,
      ...(this.#o.platform === undefined ? {} : { platform: this.#o.platform }),
      ...(this.#o.resolveFs === undefined ? {} : { fs: this.#o.resolveFs }),
    })
    if ('error' in resolved) {
      return { ...NONE, reason: `No se encontró Codex: ${resolved.error}. ${NOT_INSTALLED}` }
    }
    const timeoutMs = this.#o.probeTimeoutMs ?? 15_000
    const client = this.#client(resolved, process.cwd())
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.#ask(client, resolved, timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no respondió en ${(timeoutMs / 1000).toFixed(0)} s`)),
            timeoutMs,
          )
        }),
      ])
    } catch (error) {
      const tail = client.stderrTail()
      const detail = this.#redactor.redact(error instanceof Error ? error.message : String(error))
      return {
        ...NONE,
        reason: line(
          `No se pudo consultar a «codex app-server» (protocolo verificado con codex-cli ${CODEX_PROTOCOL_VERSION}): ${detail}${tail === '' ? '' : ` — ${tail.slice(-200)}`}`,
          500,
        ),
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      client.close(500)
    }
  }

  async #ask(
    client: CodexClient,
    command: CodexCommand,
    timeoutMs: number,
  ): Promise<Omit<Probe, 'at'>> {
    await client.handshake()
    const account = await client.call('account/read', {}, AccountResult, timeoutMs)
    const loggedOut =
      (account.account === null || account.account === undefined) &&
      account.requiresOpenaiAuth !== false
    if (loggedOut) return { ...NONE, command, reason: NOT_LOGGED_IN }
    const models: ModelInfo[] = []
    let defaultModel: string | undefined
    const efforts: string[] = []
    let cursor: string | undefined
    try {
      for (let page = 0; page < 5; page++) {
        const list = await client.call(
          'model/list',
          cursor === undefined ? {} : { cursor },
          ModelListResult,
          timeoutMs,
        )
        for (const m of list.data) {
          const id = m.model ?? m.id
          if (m.hidden === true || !Token.safeParse(id).success) continue
          if (models.some((x) => x.id === id) || models.length >= LIMITS.maxProviderModels) continue
          const own = (m.supportedReasoningEfforts ?? [])
            .map((e) => e.reasoningEffort)
            .filter((e) => Token.safeParse(e).success)
          for (const e of own) if (!efforts.includes(e) && efforts.length < 8) efforts.push(e)
          models.push({
            id,
            ...(m.displayName ? { label: line(m.displayName, LIMITS.maxTitleLength) } : {}),
            ...(own.length > 0 ? { efforts: own.slice(0, 8) } : {}),
          })
          if (m.isDefault === true && defaultModel === undefined) defaultModel = id
        }
        if (list.nextCursor === null || list.nextCursor === undefined) break
        cursor = list.nextCursor
      }
    } catch (error) {
      // Sin lista de modelos Codex sigue siendo usable: se elige el modelo por omisión de su configuración.
      this.#log({ level: 'debug', message: `model/list falló: ${String(error)}` })
    }
    return {
      available: true,
      reason: undefined,
      command,
      models,
      defaultModel: defaultModel ?? models[0]?.id,
      efforts,
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
