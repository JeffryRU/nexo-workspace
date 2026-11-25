import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const IS_WINDOWS = process.platform === 'win32'

export const DaemonFile = z.strictObject({
  version: z.string().min(1).max(64),
  port: z.int().min(1).max(65535),
  pid: z.int().positive(),
  startedAt: z.string().max(40),
})
export type DaemonFile = z.infer<typeof DaemonFile>

/** Linux `$XDG_STATE_HOME/nexo` o `~/.local/state/nexo`; Windows `%LOCALAPPDATA%\Nexo`. */
export function defaultStateDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA
    return join(base !== undefined && base !== '' ? base : join(home, 'AppData', 'Local'), 'Nexo')
  }
  const xdg = env.XDG_STATE_HOME
  return join(xdg?.startsWith('/') ? xdg : join(home, '.local', 'state'), 'nexo')
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: existe pero es de otro usuario.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type StatePaths = { dir: string; token: string; daemon: string; lock: string }

export function statePaths(dir: string): StatePaths {
  return {
    dir,
    token: join(dir, 'token'),
    daemon: join(dir, 'daemon.json'),
    lock: join(dir, 'daemon.lock'),
  }
}

export async function ensureStateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, ...(IS_WINDOWS ? {} : { mode: 0o700 }) })
  if (!IS_WINDOWS) await chmod(dir, 0o700)
}

/** Escritura atómica: archivo temporal en el mismo directorio y `rename`. */
export async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, content, { ...(mode === undefined || IS_WINDOWS ? {} : { mode }) })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** Lee `daemon.json`; devuelve `undefined` si falta, está corrupto o no cumple el esquema. */
export async function readDaemonFile(paths: StatePaths): Promise<DaemonFile | undefined> {
  try {
    const parsed = DaemonFile.safeParse(JSON.parse(await readFile(paths.daemon, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export async function writeDiscovery(
  paths: StatePaths,
  token: string,
  info: DaemonFile,
): Promise<void> {
  await writeAtomic(paths.token, token, 0o600)
  await writeAtomic(paths.daemon, `${JSON.stringify(info)}\n`, 0o600)
}

export async function removeDiscovery(paths: StatePaths, pid = process.pid): Promise<void> {
  const current = await readDaemonFile(paths)
  // No borrar el descubrimiento de otro daemon que haya tomado el directorio.
  if (current !== undefined && current.pid !== pid) return
  await rm(paths.daemon, { force: true })
  await rm(paths.token, { force: true })
}

export type LockResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; holderPid: number }

/**
 * Cerrojo del directorio de estado (`wx`): un solo daemon por directorio aunque arranquen a la vez.
 * El contenido es `pid:nonce`, así dos daemons del mismo proceso (pruebas) también se distinguen.
 * Un cerrojo cuyo dueño ya no vive (o es ilegible) se reemplaza.
 */
export async function acquireLock(
  paths: StatePaths,
  isHolderRunning: (pid: number) => Promise<boolean>,
  pid = process.pid,
): Promise<LockResult> {
  const mine = `${pid}:${randomBytes(6).toString('hex')}`
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const handle = await open(paths.lock, 'wx', 0o600)
      await handle.writeFile(mine)
      await handle.close()
      return {
        acquired: true,
        release: async () => {
          if ((await readFile(paths.lock, 'utf8').catch(() => '')) === mine) {
            await rm(paths.lock, { force: true })
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const holder = Number.parseInt(await readFile(paths.lock, 'utf8').catch(() => ''), 10)
    if (Number.isNaN(holder) && attempt < 3) {
      // El dueño acaba de crear el archivo y aún no escribió su pid.
      await new Promise((r) => setTimeout(r, 40))
      continue
    }
    if (Number.isInteger(holder) && (await isHolderRunning(holder))) {
      return { acquired: false, holderPid: holder }
    }
    await rm(paths.lock, { force: true })
  }
  throw new Error('no se pudo tomar el cerrojo del directorio de estado')
}
