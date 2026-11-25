import process from 'node:process'
import { parseEnv } from './config.ts'
import { DaemonAlreadyRunningError, startDaemon } from './daemon.ts'

async function main(): Promise<number> {
  let env: ReturnType<typeof parseEnv>
  try {
    env = parseEnv(process.env)
  } catch (error) {
    console.error(`nexo-daemon: ${(error as Error).message}`)
    return 1
  }
  try {
    const daemon = await startDaemon({
      port: env.port,
      dev: env.dev,
      logLevel: env.logLevel,
      server: { maxConnections: env.maxConnections, authTimeoutMs: env.authTimeoutMs },
      ...(env.stateDir === undefined ? {} : { stateDir: env.stateDir }),
    })
    const shutdown = (signal: string) => {
      daemon.logger.info('apagando', { signal })
      void daemon.stop().finally(() => process.exit(0))
    }
    // SIGHUP/SIGBREAK cubren el cierre de la consola en Windows.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
      process.on(signal, () => shutdown(signal))
    }
    process.on('beforeExit', () => void daemon.stop())
    return -1
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      console.error(`nexo-daemon: ${error.message}`)
      return 0
    }
    console.error(`nexo-daemon: ${(error as Error).message}`)
    return 1
  }
}

const code = await main()
if (code >= 0) process.exit(code)
