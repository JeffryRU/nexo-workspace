import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  LIMITS,
  type ModelInfo,
  PermissionMode,
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
import { AcpClient, AcpVersionError, type LogEntry } from './client.ts'
import type { AcpAgentConfig } from './config.ts'
import { AcpHistory } from './history.ts'
import { AcpMemoryInjection } from './memory-injection.ts'
import { type AgentLauncher, spawnAgentProcess } from './process.ts'
import {
  ACP_PROTOCOL_VERSION,
  ACP_SCHEMA_SOURCE,
  AcpErrorCodes,
  authMethodNames,
  LoadSessionResult,
  type NamedId,
  NewSessionResult,
  readSessionOptions,
  type SessionOptions,
} from './protocol.ts'
import { createSecretRedactor } from './redact.ts'
import { type AgentCommand, type ResolveFs, resolveAgentCommand } from './resolve.ts'
import { AcpSession, DEFAULT_LIMITS, type SessionLimits } from './session.ts'
import { line } from './text.ts'

/**
 * Modos de sesión del agente que corresponden a cada modo de permisos normalizado: se comparan el id y el
 * nombre del modo, en minúsculas y solo con letras y dígitos. Es parte del contrato del adaptador (tabla en
 * `docs/ARCHITECTURE.md`, «Proveedor ACP (F3.3)»). Un modo que no aparece aquí no se ofrece: `dontAsk` (Claude Code
 * deniega lo no preaprobado, no da acceso total) y `auto` (su alcance cambia de un agente a otro: aprueba además
 * comandos, o los revisa un clasificador) no equivalen a ningún modo normalizado y se dejan fuera a propósito.
 */
export const MODE_ALIASES: Record<PermissionMode, readonly string[]> = {
  ask: ['default', 'ask', 'normal', 'manual', 'askbeforeedits'],
  'accept-edits': ['acceptedits', 'autoedit', 'autoapproveedits', 'edit'],
  plan: ['plan', 'planning', 'readonly'],
  bypass: ['bypasspermissions', 'yolo', 'fullaccess', 'dangerfullaccess', 'bypass'],
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Modo normalizado de un modo de sesión del agente, por su id y, si no, por su nombre. */
export function classifyMode(mode: NamedId): PermissionMode | undefined {
  for (const key of [squash(mode.id), squash(mode.name)]) {
    for (const [normalized, aliases] of Object.entries(MODE_ALIASES)) {
      if (aliases.includes(key)) return normalized as PermissionMode
    }
  }
  return undefined
}

/** Para cada modo normalizado, el id del primer modo del agente que le corresponde. */
export function mapModes(available: readonly NamedId[]): Map<PermissionMode, string> {
  const out = new Map<PermissionMode, string>()
  for (const mode of available) {
    const normalized = classifyMode(mode)
    if (normalized !== undefined && !out.has(normalized)) out.set(normalized, mode.id)
  }
  return out
}

export type AcpProviderOptions = {
  /** El agente: cada agente ACP declarado es un proveedor distinto. */
  agent: AcpAgentConfig
  /** Entorno con el que se lanza el agente (el daemon pasa el suyo sin las variables `NEXO_*`). */
  env: Readonly<Record<string, string | undefined>>
  log?: (entry: LogEntry) => void
  /** Lanzador del proceso (pruebas); por omisión `spawn` sin shell. */
  launcher?: AgentLauncher
  platform?: NodeJS.Platform
  resolveFs?: ResolveFs
  /** Plazo de toda la comprobación de disponibilidad (arrancar, `initialize`, `session/new`). */
  probeTimeoutMs?: number
  /** Cuánto se reutiliza una comprobación correcta; una fallida, como mucho 3 s. */
  probeCacheMs?: number
  limits?: Partial<SessionLimits>
  /** Tope de una línea JSON-RPC del agente, en caracteres. */
  maxLineLength?: number
  now?: () => number
}

type Probe = {
  at: number
  available: boolean
  reason: string | undefined
  command: AgentCommand | undefined
  loadSession: boolean
  modes: PermissionMode[]
  models: ModelInfo[]
  defaultModel: string | undefined
}

const NONE: Omit<Probe, 'at'> = {
  available: false,
  reason: undefined,
  command: undefined,
  loadSession: false,
  modes: [],
  models: [],
  defaultModel: undefined,
}

const INSTALL_HINTS: Record<string, string> = {
  gemini:
    'Instala Gemini CLI con «npm i -g @google/gemini-cli» (o declara otro «command» para «gemini» en NEXO_ACP_AGENTS).',
}

const modelsOf = (
  options: SessionOptions,
): { models: ModelInfo[]; current: string | undefined } => {
  const models: ModelInfo[] = []
  for (const m of options.models?.available ?? []) {
    if (!Token.safeParse(m.id).success || models.some((x) => x.id === m.id)) continue
    if (models.length >= LIMITS.maxProviderModels) break
    models.push({
      id: m.id,
      ...(m.name === m.id ? {} : { label: line(m.name, LIMITS.maxTitleLength) }),
    })
  }
  const current = options.models?.current
  return {
    models,
    current: current !== undefined && Token.safeParse(current).success ? current : undefined,
  }
}

/** Fábrica del proveedor de un agente ACP. No lanza nada hasta que se consulta la disponibilidad o se abre una sesión. */
export function createAcpProvider(options: AcpProviderOptions): AgentProviderPort {
  return new AcpProvider(options)
}

class AcpProvider implements AgentProviderPort {
  readonly id: string
  readonly displayName: string
  readonly memoryInjection: AcpMemoryInjection
  readonly history: AcpHistory
  readonly #o: AcpProviderOptions
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #log: (entry: LogEntry) => void
  readonly #redactor: ReturnType<typeof createSecretRedactor>
  readonly #limits: SessionLimits
  readonly #launcher: AgentLauncher
  #probe: Probe | undefined
  #inFlight: Promise<Probe> | undefined

  constructor(options: AcpProviderOptions) {
    this.#o = options
    this.id = options.agent.id
    this.displayName = options.agent.name
    this.memoryInjection = new AcpMemoryInjection(this.id)
    this.#env = { ...options.env, ...options.agent.env }
    this.#log = options.log ?? (() => {})
    this.#redactor = createSecretRedactor(this.#env)
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.#launcher = options.launcher ?? spawnAgentProcess
    this.history = new AcpHistory({
      id: this.id,
      displayName: this.displayName,
      command: () =>
        resolveAgentCommand({
          command: options.agent.command,
          args: options.agent.args,
          env: this.#env,
          ...(options.platform === undefined ? {} : { platform: options.platform }),
          ...(options.resolveFs === undefined ? {} : { fs: options.resolveFs }),
        }),
      client: (command, cwd) => this.#client(command, cwd),
      requestTimeoutMs: this.#limits.requestTimeoutMs,
      redact: (text) => this.#redactor.redact(text),
    })
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
      efforts: [],
      permissionModes: this.#permissionModes(probe.modes),
      resume: probe.loadSession,
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
    if (
      open.permissionMode !== undefined &&
      !PermissionMode.safeParse(open.permissionMode).success
    ) {
      throw invalid(`modo de permisos desconocido: ${open.permissionMode}`)
    }
    if (open.resume !== undefined && !ProviderSessionToken.safeParse(open.resume).success) {
      throw invalid('ficha de sesión inválida')
    }
    if (open.effort !== undefined) throw invalid(`${this.displayName} no tiene niveles de esfuerzo`)
    const probe = await this.#probeNow()
    if (!probe.available || probe.command === undefined) {
      throw new AgentProviderError(
        'UNAVAILABLE',
        probe.reason ?? `${this.displayName} no está disponible`,
      )
    }
    if (open.resume !== undefined && !probe.loadSession) {
      throw invalid(`${this.displayName} no anuncia «loadSession»: no puede reanudar sesiones`)
    }
    if (open.model !== undefined) {
      if (probe.models.length === 0)
        throw invalid(`${this.displayName} no permite elegir el modelo`)
      if (!probe.models.some((m) => m.id === open.model)) {
        throw invalid(`modelo desconocido: ${open.model}`)
      }
    }
    const mode: PermissionMode = open.permissionMode ?? 'ask'
    if (!this.#permissionModes(probe.modes).includes(mode)) {
      throw invalid(`${this.displayName} no ofrece el modo de permisos «${mode}»`)
    }
    const cwd = resolve(open.cwd)
    const memory = checkPreparedMemory(open.memory)
    const client = this.#client(probe.command, cwd)
    try {
      const init = await client.handshake(this.#limits.startupTimeoutMs)
      let sessionId: string
      let sessionOptions: SessionOptions
      if (open.resume === undefined) {
        const created = await client.call(
          'session/new',
          { cwd, mcpServers: [] },
          NewSessionResult,
          this.#limits.startupTimeoutMs,
        )
        sessionId = created.sessionId
        sessionOptions = readSessionOptions(created)
      } else {
        if (init.agentCapabilities?.loadSession !== true) {
          throw invalid(`${this.displayName} no anuncia «loadSession»: no puede reanudar sesiones`)
        }
        // Mientras carga, el agente reproduce el historial con `session/update`: aún no hay atendedor y se descarta.
        const loaded = await client.call(
          'session/load',
          { sessionId: open.resume, cwd, mcpServers: [] },
          LoadSessionResult,
          this.#limits.startupTimeoutMs,
        )
        sessionId = open.resume
        sessionOptions = readSessionOptions(loaded)
      }
      if (!ProviderSessionToken.safeParse(sessionId).success) {
        throw new Error('el agente devolvió un id de sesión inválido')
      }
      const modeMap = mapModes(sessionOptions.modes?.available ?? [])
      const agentMode = modeMap.get(mode)
      if (agentMode !== undefined && sessionOptions.modes?.current !== agentMode) {
        await client.request(
          'session/set_mode',
          { sessionId, modeId: agentMode },
          this.#limits.requestTimeoutMs,
        )
      }
      const wanted = open.model
      if (wanted !== undefined && wanted !== sessionOptions.models?.current) {
        const config = sessionOptions.modelConfig
        await client.request(
          config === undefined ? 'session/set_model' : 'session/set_config_option',
          config === undefined
            ? { sessionId, modelId: wanted }
            : { sessionId, configId: config.configId, value: wanted },
          this.#limits.requestTimeoutMs,
        )
      }
      const current = sessionOptions.models?.current
      const model =
        wanted ?? (current !== undefined && Token.safeParse(current).success ? current : undefined)
      const reverse = new Map<string, PermissionMode>()
      for (const [normalized, id] of modeMap) reverse.set(id, normalized)
      return new AcpSession({
        client,
        sessionId,
        model,
        permissionMode: mode,
        mapMode: (id) => reverse.get(id),
        cwd: open.cwd,
        limits: this.#limits,
        log: this.#log,
        ...(this.#o.now === undefined ? {} : { now: this.#o.now }),
        label: this.displayName,
        ...(memory === undefined ? {} : { memory }),
      })
    } catch (error) {
      const tail = client.stderrTail()
      client.close()
      if (error instanceof AgentProviderError) throw error
      if (open.resume !== undefined && error instanceof RpcError) {
        throw invalid(`no se pudo reanudar la sesión: ${line(error.message, 300)}`)
      }
      if (error instanceof RpcError && error.code === AcpErrorCodes.authRequired) {
        throw new AgentProviderError('UNAVAILABLE', this.#authReason(client))
      }
      throw new AgentProviderError(
        'UNAVAILABLE',
        `No se pudo abrir la sesión de ${this.displayName}: ${this.#redactor.redact(error instanceof Error ? error.message : String(error))}${tail === '' ? '' : ` (${tail.slice(-300)})`}`,
      )
    }
  }

  /** `ask` siempre se ofrece (es lo que hace un agente que no anuncia modos); el resto, según los modos del agente. */
  #permissionModes(modes: readonly PermissionMode[]): PermissionMode[] {
    const out: PermissionMode[] = ['ask']
    for (const m of ['accept-edits', 'plan', 'bypass'] as const) if (modes.includes(m)) out.push(m)
    return out
  }

  #authReason(client: AcpClient): string {
    const names = client.initialized === undefined ? [] : authMethodNames(client.initialized)
    return line(
      `${this.displayName} pide autenticación${names.length > 0 ? ` (${names.join(', ')})` : ''}: inicia sesión con su CLI desde una terminal. Nexo no inicia sesión ni lee credenciales.`,
      500,
    )
  }

  #client(command: AgentCommand, cwd: string): AcpClient {
    return new AcpClient({
      launcher: this.#launcher,
      command,
      cwd,
      env: this.#env,
      log: this.#log,
      redactor: this.#redactor,
      requestTimeoutMs: this.#limits.requestTimeoutMs,
      maxLineLength: this.#o.maxLineLength ?? 32 * 1024 * 1024,
      clientVersion: '0.0.0',
      label: this.displayName,
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
      this.#log({ level: 'debug', message: result.reason ?? `${this.displayName} no disponible` })
    }
    return this.#probe
  }

  async #probeOnce(): Promise<Omit<Probe, 'at'>> {
    const agent = this.#o.agent
    const resolved = resolveAgentCommand({
      command: agent.command,
      args: agent.args,
      env: this.#env,
      ...(this.#o.platform === undefined ? {} : { platform: this.#o.platform }),
      ...(this.#o.resolveFs === undefined ? {} : { fs: this.#o.resolveFs }),
    })
    if ('error' in resolved) {
      const hint = INSTALL_HINTS[agent.id] ?? 'Revisa «command» de este agente en NEXO_ACP_AGENTS.'
      return {
        ...NONE,
        reason: line(`No se encontró ${this.displayName}: ${resolved.error}. ${hint}`, 500),
      }
    }
    const timeoutMs = this.#o.probeTimeoutMs ?? 30_000
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
      if (error instanceof RpcError && error.code === AcpErrorCodes.authRequired) {
        return { ...NONE, command: resolved, reason: this.#authReason(client) }
      }
      if (error instanceof AcpVersionError) {
        return {
          ...NONE,
          reason: line(`${this.displayName}: ${error.message}. Actualiza el agente o Nexo.`, 500),
        }
      }
      const detail = this.#redactor.redact(error instanceof Error ? error.message : String(error))
      return {
        ...NONE,
        reason: line(
          `No se pudo consultar a ${this.displayName} por ACP (versión ${ACP_PROTOCOL_VERSION} del protocolo, esquema ${ACP_SCHEMA_SOURCE}): ${detail}${tail === '' ? '' : ` — ${tail.slice(-200)}`}`,
          500,
        ),
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      client.close(500)
    }
  }

  /**
   * `initialize` y una `session/new` de prueba (sin enviar ningún mensaje): de ella salen los modos y modelos
   * del agente, y un agente sin sesión iniciada responde aquí «autenticación requerida» (-32000).
   */
  async #ask(
    client: AcpClient,
    command: AgentCommand,
    timeoutMs: number,
  ): Promise<Omit<Probe, 'at'>> {
    const init = await client.handshake(timeoutMs)
    const created = await client.call(
      'session/new',
      { cwd: process.cwd(), mcpServers: [] },
      NewSessionResult,
      timeoutMs,
    )
    const options = readSessionOptions(created)
    const { models, current } = modelsOf(options)
    return {
      available: true,
      reason: undefined,
      command,
      loadSession: init.agentCapabilities?.loadSession === true,
      modes: [...mapModes(options.modes?.available ?? []).keys()],
      models,
      defaultModel: current ?? models[0]?.id,
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
