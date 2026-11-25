import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export type DiscoveryErrorCode = 'NOT_RUNNING' | 'STALE' | 'CORRUPT' | 'START_TIMEOUT'

export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode
  constructor(code: DiscoveryErrorCode, message: string) {
    super(message)
    this.name = 'DiscoveryError'
    this.code = code
  }
}

/** Forma que escribe el daemon. Los campos desconocidos se ignoran (compatibilidad hacia adelante); la URL siempre usa 127.0.0.1. */
export const DaemonFile = z.object({
  version: z.string().min(1).max(64),
  port: z.int().min(1).max(65535),
  pid: z.int().positive(),
  startedAt: z.string().max(40),
})
export type DaemonFile = z.infer<typeof DaemonFile>

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/
const MAX_DAEMON_FILE_BYTES = 4096
const MAX_TOKEN_FILE_BYTES = 1024

export type DiscoveryOptions = {
  /** Directorio de estado; por omisión NEXO_STATE_DIR o el de la plataforma (igual que el daemon). */
  stateDir?: string
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  home?: string
  /** Tiempo máximo de la comprobación de /health (ms). */
  healthTimeoutMs?: number
}

export type DaemonLocation = { url: string; token: string; port: number; pid: number }

/** NEXO_STATE_DIR; Linux $XDG_STATE_HOME/nexo o ~/.local/state/nexo; Windows %LOCALAPPDATA%\Nexo. */
export function resolveStateDir(options: DiscoveryOptions = {}): string {
  if (options.stateDir !== undefined) return options.stateDir
  const env = options.env ?? process.env
  const override = env.NEXO_STATE_DIR
  if (override !== undefined && override !== '') return override
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA
    return join(base !== undefined && base !== '' ? base : join(home, 'AppData', 'Local'), 'Nexo')
  }
  const xdg = env.XDG_STATE_HOME
  return join(xdg?.startsWith('/') ? xdg : join(home, '.local', 'state'), 'nexo')
}

/** Lee un archivo regular pequeño: rechaza enlaces simbólicos, no regulares y tamaños excesivos. */
async function readSmallFile(path: string, maxBytes: number): Promise<string | 'missing'> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw new DiscoveryError('CORRUPT', 'no se pudo leer el directorio de estado')
  }
  if (!info.isFile()) throw new DiscoveryError('CORRUPT', 'se esperaba un archivo regular')
  if (info.size > maxBytes) throw new DiscoveryError('CORRUPT', 'el archivo es demasiado grande')
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0)
      if (bytesRead > maxBytes)
        throw new DiscoveryError('CORRUPT', 'el archivo es demasiado grande')
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof DiscoveryError) throw error
    throw new DiscoveryError('CORRUPT', 'no se pudo leer el archivo')
  }
}

/** Responde /health con la cabecera X-Nexo-Daemon: 1 en el loopback? */
export async function checkHealth(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
    if (response.status !== 200 || response.headers.get('x-nexo-daemon') !== '1') {
      await response.body?.cancel()
      return false
    }
    const reader = response.body?.getReader()
    if (reader === undefined) return false
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 4096) {
        await reader.cancel()
        return false
      }
      chunks.push(value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof body === 'object' && body !== null && Reflect.get(body, 'ok') === true
  } catch {
    return false
  }
}

/**
 * Localiza un daemon vivo. Errores: NOT_RUNNING (no hay daemon.json), STALE (existe pero no
 * responde), CORRUPT (archivos ilegibles, enormes, enlaces simbólicos o con contenido no válido).
 */
export async function discoverDaemon(options: DiscoveryOptions = {}): Promise<DaemonLocation> {
  const dir = resolveStateDir(options)
  const raw = await readSmallFile(join(dir, 'daemon.json'), MAX_DAEMON_FILE_BYTES)
  if (raw === 'missing') throw new DiscoveryError('NOT_RUNNING', 'Nexo no está corriendo')
  let file: DaemonFile
  try {
    file = DaemonFile.parse(JSON.parse(raw))
  } catch {
    throw new DiscoveryError('CORRUPT', 'daemon.json no es válido')
  }
  const tokenRaw = await readSmallFile(join(dir, 'token'), MAX_TOKEN_FILE_BYTES)
  if (tokenRaw === 'missing') throw new DiscoveryError('STALE', 'falta el token del daemon')
  const token = tokenRaw.trim()
  if (!TOKEN_PATTERN.test(token)) throw new DiscoveryError('CORRUPT', 'el token no es válido')
  if (!(await checkHealth(file.port, options.healthTimeoutMs))) {
    throw new DiscoveryError('STALE', 'daemon.json existe pero el daemon no responde')
  }
  return { url: `ws://127.0.0.1:${file.port}/`, token, port: file.port, pid: file.pid }
}

export type EnsureDaemonOptions = DiscoveryOptions & {
  /** Arranca el daemon (la CLI lo inyecta; debe lanzarlo con spawn(cmd, args[])). */
  start: () => void | Promise<void>
  /** Tiempo máximo de espera tras arrancar (ms). 10 s por omisión. */
  timeoutMs?: number
  pollMs?: number
}

/** Devuelve el daemon vivo; si no hay, lo arranca con start y espera a que /health responda. */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonLocation> {
  try {
    return await discoverDaemon(options)
  } catch (error) {
    if (!(error instanceof DiscoveryError)) throw error
  }
  await options.start()
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  const pollMs = options.pollMs ?? 100
  let last: DiscoveryError | undefined
  for (;;) {
    try {
      return await discoverDaemon(options)
    } catch (error) {
      if (!(error instanceof DiscoveryError)) throw error
      last = error
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new DiscoveryError(
    'START_TIMEOUT',
    `el daemon no respondió a tiempo (${last?.code ?? 'desconocido'})`,
  )
}
