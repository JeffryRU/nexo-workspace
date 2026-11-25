import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectToDaemon, DiscoveryError, discoverDaemon, resolveStateDir } from '@nexo/client/node'
import type { Deps } from './context.ts'
import { unavailableError, usageError } from './errors.ts'

type Env = Readonly<Record<string, string | undefined>>

const LOG_NAME = 'daemon.log'
const MAX_LOG_BYTES = 2 * 1024 * 1024
const DEFAULT_START_TIMEOUT_MS = 10_000

/** `NEXO_DAEMON_ENTRY` o `apps/daemon/src/main.ts` relativo a este paquete. */
export function resolveDaemonEntry(env: Env, baseUrl: string = import.meta.url): string {
  const override = env.NEXO_DAEMON_ENTRY
  if (override !== undefined && override !== '') return override
  return fileURLToPath(new URL('../../daemon/src/main.ts', baseUrl))
}

export function startTimeoutMs(env: Env): number {
  const raw = env.NEXO_START_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_START_TIMEOUT_MS
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1 || Number(raw) > 300_000) {
    throw usageError('NEXO_START_TIMEOUT_MS debe ser un entero de 1 a 300000')
  }
  return Number(raw)
}

export type StartOptions = {
  entry: string
  stateDir: string
  env: Env
  spawnFn?: typeof spawn
}

/**
 * Arranca el daemon desacoplado (sobrevive a la CLI). Su salida va a `daemon.log` en el directorio
 * de estado (sin el token: el daemon ya lo redacta). Devuelve lo que se sepa de fallos de arranque.
 */
export function startDaemonDetached(options: StartOptions): {
  spawnError: () => string | undefined
} {
  if (!existsSync(options.entry)) {
    throw unavailableError(
      `no se encontró el daemon en "${options.entry}"; define NEXO_DAEMON_ENTRY con la ruta de apps/daemon/src/main.ts`,
    )
  }
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
  const logPath = join(options.stateDir, LOG_NAME)
  try {
    if (statSync(logPath).size > MAX_LOG_BYTES) renameSync(logPath, `${logPath}.1`)
  } catch {
    // sin registro previo
  }
  const fd = openSync(logPath, 'a', 0o600)
  let failure: string | undefined
  try {
    const child = (options.spawnFn ?? spawn)(process.execPath, [options.entry], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
    })
    child.on('error', (error) => {
      failure = (error as NodeJS.ErrnoException).code ?? 'error de arranque'
    })
    child.unref()
  } finally {
    closeSync(fd)
  }
  return { spawnError: () => failure }
}

/** Conexión real: descubre el daemon y, con `autostart`, lo arranca si no corre. */
export function makeConnect(env: Env): Deps['connect'] {
  return async ({ autostart }) => {
    const timeoutMs = startTimeoutMs(env)
    let started: ReturnType<typeof startDaemonDetached> | undefined
    try {
      return await connectToDaemon({
        discovery: { env },
        ...(autostart
          ? {
              ensure: {
                timeoutMs,
                start: () => {
                  started = startDaemonDetached({
                    entry: resolveDaemonEntry(env),
                    stateDir: resolveStateDir({ env }),
                    env,
                  })
                },
              },
            }
          : {}),
        client: { reconnect: false, callTimeoutMs: 15_000 },
      })
    } catch (error) {
      if (error instanceof DiscoveryError && error.code === 'START_TIMEOUT') {
        const why = started?.spawnError()
        throw unavailableError(
          `el daemon no respondió en ${Math.round(timeoutMs / 1000)} s${why === undefined ? '' : ` (${why})`}; revisa \`nexo daemon log\``,
        )
      }
      throw error
    }
  }
}

export function makeDaemonControl(env: Env): Deps['daemon'] {
  return {
    stateDir: () => resolveStateDir({ env }),
    locate: async () => {
      const found = await discoverDaemon({ env })
      return { port: found.port, pid: found.pid }
    },
    readLog: async (maxBytes) => {
      const path = join(resolveStateDir({ env }), LOG_NAME)
      try {
        const info = await stat(path)
        const handle = await open(path, 'r')
        try {
          const length = Math.min(info.size, maxBytes)
          const buffer = Buffer.alloc(length)
          await handle.read(buffer, 0, length, info.size - length)
          return buffer.toString('utf8')
        } finally {
          await handle.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
  }
}
