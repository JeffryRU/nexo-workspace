import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AcpAgentConfig,
  createAcpProvider,
  effectiveAcpAgents,
} from '@nexo/adapter-provider-acp'
import { createClaudeProvider } from '@nexo/adapter-provider-claude'
import { createCodexProvider } from '@nexo/adapter-provider-codex'
import { createOllamaProvider } from '@nexo/adapter-provider-ollama'
import { PtyHostPort } from '@nexo/adapter-pty-host'
import { NodePtyPort } from '@nexo/adapter-pty-node'
import {
  type AgentProviderPort,
  AgentService,
  type AgentServiceConfig,
  createDispatcher,
  type EventBusPort,
  LayoutService,
  type LoggerPort,
  type PtyPort,
  SnapshotService,
  TerminalService,
  type TerminalServiceConfig,
  WorkspaceService,
} from '@nexo/core'
import { MemoryEventBus } from './adapters/event-bus.ts'
import { JsonLogger, type LogLevel } from './adapters/logger.ts'
import { ScriptedAgentProvider } from './adapters/scripted-agent-provider.ts'
import { SystemClock } from './adapters/system-clock.ts'
import { UuidIds } from './adapters/uuid-ids.ts'
import { watchAgentPanes } from './agent-warmup.ts'
import { generateToken } from './auth.ts'
import type { AgentProviderName } from './config.ts'
import { probeDaemon } from './probe.ts'
import { createRedactor } from './redact.ts'
import { DaemonServer, type ServerOptions, type ServerStats } from './server.ts'
import { resolveDefaultShell } from './shell.ts'
import {
  acquireLock,
  defaultStateDir,
  ensureStateDir,
  isPidAlive,
  readDaemonFile,
  removeDiscovery,
  type StatePaths,
  statePaths,
  writeDiscovery,
} from './state-dir.ts'
import { DAEMON_VERSION } from './version.ts'

export class DaemonAlreadyRunningError extends Error {
  readonly pid: number
  readonly port: number | undefined
  constructor(pid: number, port?: number) {
    super(`Nexo ya está corriendo (pid ${pid}${port === undefined ? '' : `, puerto ${port}`})`)
    this.name = 'DaemonAlreadyRunningError'
    this.pid = pid
    this.port = port
  }
}

export class PortInUseError extends Error {
  readonly port: number
  constructor(port: number) {
    super(
      `el puerto ${port} está ocupado por otro programa que no es Nexo; libéralo o usa NEXO_PORT`,
    )
    this.name = 'PortInUseError'
    this.port = port
  }
}

export type DaemonOptions = {
  /** 0 = puerto efímero. */
  port?: number
  stateDir?: string
  dev?: boolean
  logLevel?: LogLevel
  /** Destino de los logs ya redactados (stderr por omisión). */
  logSink?: (line: string) => void
  /** `apps/web/dist` por omisión; `null` desactiva la web. */
  webRoot?: string | null
  pty?: PtyPort
  /**
   * Dónde viven los PTY cuando no se inyecta `pty`: `host` los aísla en un proceso hijo (un crash nativo de
   * ConPTY no tumba el daemon); `direct` los crea en el propio daemon. Por omisión: `host` en Windows.
   */
  ptyMode?: 'host' | 'direct'
  /**
   * Proveedores de agente. Por omisión se registra solo `claude`. Una lista de nombres (`NEXO_AGENT_PROVIDERS`)
   * elige entre los incluidos (`claude`, `codex`, `ollama`, `fake`) y los agentes ACP (`acpAgents`); también se pueden inyectar puertos ya construidos.
   * El primero es el que se precalienta. Una lista vacía deja el daemon sin agentes.
   */
  agentProviders?: readonly (AgentProviderName | AgentProviderPort)[]
  /** Ejecutable de Claude Code (por omisión, el del SDK). */
  claudeExecutable?: string
  /** Ejecutable de Codex (por omisión, `codex` en el PATH). */
  codexExecutable?: string
  /**
   * Agentes ACP que se pueden registrar por nombre (cada uno es un proveedor): los declarados en `NEXO_ACP_AGENTS`.
   * Por omisión solo existe `gemini`.
   */
  acpAgents?: readonly AcpAgentConfig[]
  /** URL base de Ollama (por omisión `http://127.0.0.1:11434`). */
  ollamaUrl?: string
  agents?: AgentServiceConfig
  /** Se llama (tras responder) cuando un cliente pide `daemon.shutdown`; por omisión detiene el daemon. */
  onShutdownRequested?: (stop: () => Promise<void>) => void
  terminal?: TerminalServiceConfig
  server?: Partial<
    Pick<
      ServerOptions,
      | 'maxConnections'
      | 'maxMessageBytes'
      | 'authTimeoutMs'
      | 'rate'
      | 'softBufferBytes'
      | 'hardBufferBytes'
      | 'resyncAckMs'
      | 'maxStrikes'
    >
  >
}

export type RunningDaemon = {
  readonly port: number
  readonly token: string
  readonly paths: StatePaths
  readonly bus: EventBusPort
  readonly logger: LoggerPort
  stats(): ServerStats
  /** PID del proceso pty host (solo con `ptyMode: 'host'`); para diagnóstico y pruebas. */
  ptyHostPid(): number | undefined
  /** Mata las terminales, cierra conexiones y borra el descubrimiento. Idempotente. */
  stop(): Promise<void>
}

/** Las terminales no heredan las variables internas de Nexo. */
function childBaseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('NEXO_')) env[k] = v
  return env
}

export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const redactor = createRedactor()
  const logger = new JsonLogger({
    redactor,
    level: options.logLevel ?? 'info',
    ...(options.logSink === undefined ? {} : { sink: options.logSink }),
  })
  const paths = statePaths(options.stateDir ?? defaultStateDir())
  await ensureStateDir(paths.dir)

  const lock = await acquireLock(paths, async (pid) => {
    if (!isPidAlive(pid)) return false
    const file = await readDaemonFile(paths)
    // Sin `daemon.json` del dueño, está arrancando; con él, se comprueba que responda.
    if (file === undefined || file.pid !== pid) return true
    return probeDaemon(file.port)
  })
  if (!lock.acquired) {
    const file = await readDaemonFile(paths)
    throw new DaemonAlreadyRunningError(lock.holderPid, file?.port)
  }

  const token = generateToken()
  redactor.addSecret(token)
  const startedAt = new Date().toISOString()
  const bus = new MemoryEventBus((error) =>
    logger.error('fallo en un suscriptor del bus', { error }),
  )
  const ids = new UuidIds()
  const clock = new SystemClock()
  const layout = new LayoutService({ ids, bus })
  const shell = resolveDefaultShell({ env: process.env, platform: process.platform })
  if (shell.warning !== undefined) logger.warn(shell.warning)
  const ptyMode = options.ptyMode ?? (process.platform === 'win32' ? 'host' : 'direct')
  const hostPort =
    options.pty === undefined && ptyMode === 'host'
      ? new PtyHostPort({ baseEnv: childBaseEnv(), logger })
      : undefined
  const pty = options.pty ?? hostPort ?? new NodePtyPort({ baseEnv: childBaseEnv() })
  logger.info('terminales (PTY)', { mode: options.pty === undefined ? ptyMode : 'inyectado' })
  const terminals = new TerminalService({
    pty,
    bus,
    clock,
    ids,
    panes: layout,
    config: { defaultCommand: { cmd: shell.cmd }, ...options.terminal },
  })
  const acpAgents = new Map(
    effectiveAcpAgents(options.acpAgents ?? []).map((a) => [a.id, a] as const),
  )

  const providers = (options.agentProviders ?? ['claude']).map((p) =>
    typeof p === 'string' ? createProvider(p) : p,
  )
  if (providers.some((p) => p.id === 'fake')) {
    logger.warn('proveedor de agente de prueba activo (fake): no es para uso normal')
  }
  const agentService =
    providers.length === 0
      ? undefined
      : new AgentService({
          providers,
          bus,
          clock,
          ids,
          panes: layout,
          logger,
          ...(options.agents === undefined ? {} : { config: options.agents }),
        })
  const stopWarmup = watchAgentPanes({ bus, panes: layout, provider: providers[0], logger })
  const workspaces = new WorkspaceService({
    layout,
    terminals,
    ...(agentService === undefined ? {} : { agents: agentService }),
  })
  const identity = { version: DAEMON_VERSION, pid: process.pid, startedAt }

  const webRoot =
    options.webRoot === null
      ? undefined
      : (options.webRoot ??
        fileURLToPath(new URL(join('..', '..', 'web', 'dist'), import.meta.url)))

  function createProvider(name: AgentProviderName): AgentProviderPort {
    if (name === 'fake') return new ScriptedAgentProvider()
    const acp = acpAgents.get(name)
    if (acp !== undefined) {
      return createAcpProvider({
        agent: acp,
        env: childBaseEnv(),
        log: (entry) => logger[entry.level](`${acp.id}: ${entry.message}`),
      })
    }
    if (name === 'codex') {
      return createCodexProvider({
        env: childBaseEnv(),
        log: (entry) => logger[entry.level](`codex: ${entry.message}`),
        ...(options.codexExecutable === undefined ? {} : { executable: options.codexExecutable }),
      })
    }
    if (name === 'ollama') {
      return createOllamaProvider({
        ...(options.ollamaUrl === undefined ? {} : { baseUrl: options.ollamaUrl }),
        log: (entry) => logger[entry.level](`ollama: ${entry.message}`),
      })
    }
    if (name !== 'claude') throw new Error(`proveedor de agente desconocido: ${name}`)
    return createClaudeProvider({
      env: childBaseEnv(),
      log: (entry) => logger[entry.level](`claude: ${entry.message}`),
      ...(options.claudeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: options.claudeExecutable }),
    })
  }

  const server = new DaemonServer({
    port: options.port ?? 4317,
    token,
    version: DAEMON_VERSION,
    dev: options.dev ?? false,
    webRoot,
    logger,
    bus,
    createDispatcher: (hooks) =>
      createDispatcher({
        workspaces,
        terminals,
        ...(agentService === undefined ? {} : { agents: agentService.handlers }),
        snapshot: new SnapshotService({ layout, identity, currentSeq: hooks.currentSeq }),
        subscribe: hooks.subscribe,
        shutdown: () => {
          // Un respiro para que la respuesta salga antes de cerrar las conexiones.
          const timer = setTimeout(
            () => (options.onShutdownRequested ?? ((s) => void s()))(stop),
            50,
          )
          timer.unref()
        },
      }),
    ...options.server,
  })

  let stopped: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      stopWarmup()
      terminals.shutdown()
      await agentService
        ?.closeAll()
        .catch((error: unknown) =>
          logger.error('fallo al cerrar las sesiones de agente', { error }),
        )
      hostPort?.dispose()
      await server.close()
      await removeDiscovery(paths).catch(() => {})
      await lock.release().catch(() => {})
      logger.info('daemon detenido')
    })()
    return stopped
  }

  try {
    const requested = options.port ?? 4317
    const port = await server.listen().catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        if (requested !== 0 && (await probeDaemon(requested))) {
          throw new DaemonAlreadyRunningError((await readDaemonFile(paths))?.pid ?? 0, requested)
        }
        throw new PortInUseError(requested)
      }
      throw error
    })
    await writeDiscovery(paths, token, {
      version: DAEMON_VERSION,
      port,
      pid: process.pid,
      startedAt,
    })
    logger.info('daemon escuchando', { port, stateDir: paths.dir })
    return {
      port,
      token,
      paths,
      bus,
      logger,
      stats: () => server.stats(),
      ptyHostPid: () => hostPort?.hostPid,
      stop,
    }
  } catch (error) {
    stopWarmup()
    terminals.shutdown()
    await agentService?.closeAll().catch(() => {})
    hostPort?.dispose()
    await server.close().catch(() => {})
    await lock.release().catch(() => {})
    throw error
  }
}
