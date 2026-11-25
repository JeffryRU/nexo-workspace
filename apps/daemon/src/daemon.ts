import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodePtyPort } from '@nexo/adapter-pty-node'
import {
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
import { SystemClock } from './adapters/system-clock.ts'
import { UuidIds } from './adapters/uuid-ids.ts'
import { generateToken } from './auth.ts'
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
  const terminals = new TerminalService({
    pty: options.pty ?? new NodePtyPort({ baseEnv: childBaseEnv() }),
    bus,
    clock,
    ids,
    panes: layout,
    config: { defaultCommand: { cmd: shell.cmd }, ...options.terminal },
  })
  const workspaces = new WorkspaceService({ layout, terminals })
  const identity = { version: DAEMON_VERSION, pid: process.pid, startedAt }

  const webRoot =
    options.webRoot === null
      ? undefined
      : (options.webRoot ??
        fileURLToPath(new URL(join('..', '..', 'web', 'dist'), import.meta.url)))

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
      terminals.shutdown()
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
    return { port, token, paths, bus, logger, stats: () => server.stats(), stop }
  } catch (error) {
    terminals.shutdown()
    await server.close().catch(() => {})
    await lock.release().catch(() => {})
    throw error
  }
}
