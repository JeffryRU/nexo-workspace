import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Rutas relativas al módulo en ejecución. En desarrollo el daemon corre como `apps/daemon/src/*.ts`; en el
 * paquete (F6.1, `tools/package`) es `daemon/daemon.mjs` con `web/` y `vendor/` como hermanos de `daemon/`.
 */
export function isBundled(moduleUrl: string): boolean {
  return !moduleUrl.endsWith('.ts')
}

/** Carpeta con la web: `apps/web/dist` en el repositorio o `web/` en el paquete. */
export function defaultWebRoot(moduleUrl: string): string {
  const relative = isBundled(moduleUrl) ? '../web' : '../../web/dist'
  return fileURLToPath(new URL(relative, moduleUrl))
}

/** `vendor/claude[.exe]` del paquete (solo si se construyó con `--with-claude`); `undefined` si no existe. */
export function bundledClaudeExecutable(
  moduleUrl: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!isBundled(moduleUrl)) return undefined
  const dir = fileURLToPath(new URL('../vendor/', moduleUrl))
  const path = join(dir, platform === 'win32' ? 'claude.exe' : 'claude')
  return exists(path) ? path : undefined
}

/** Lo que hace falta del sistema de archivos para buscar un ejecutable (inyectable en las pruebas). */
export type ExecutableFs = {
  /** `true` si es un archivo normal (no un directorio) y el usuario puede ejecutarlo. */
  isExecutable(path: string): boolean
}

export const nodeExecutableFs: ExecutableFs = {
  isExecutable(path) {
    try {
      if (!statSync(path).isFile()) return false
      if (process.platform !== 'win32') accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
}

const MAX_PATH_ENTRIES = 256
const MAX_ENTRY_LENGTH = 4096

/**
 * Busca `claude` como ejecutable en el PATH del usuario (su propia instalación de Claude Code) y, si no está,
 * en `~/.local/bin`, donde lo deja su instalador nativo. Solo comprueba que el archivo exista y sea ejecutable: no
 * lo lee, no entra en `~/.claude` y no toca credenciales. Se descartan entradas vacías, relativas, con NUL o
 * enormes (un PATH con `.` haría ejecutar lo que haya en el directorio de trabajo) y los directorios llamados
 * `claude`. En Windows solo vale `claude.exe`: `spawn` sin shell no ejecuta los `.cmd` que crea npm.
 */
export function findClaudeOnPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  fs: ExecutableFs = nodeExecutableFs,
): string | undefined {
  const windows = platform === 'win32'
  const path = windows ? win32 : posix
  const read = (name: string): string | undefined => {
    if (!windows) return env[name]
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key === undefined ? undefined : env[key]
  }
  const file = windows ? 'claude.exe' : 'claude'
  const dirs = (read('PATH') ?? '').split(path.delimiter)
  const home = windows ? read('USERPROFILE') : read('HOME')
  if (home !== undefined && home !== '') dirs.push(path.join(home, '.local', 'bin'))
  let seen = 0
  for (const dir of dirs) {
    if (dir === '' || dir.length > MAX_ENTRY_LENGTH || dir.includes('\0')) continue
    if (!path.isAbsolute(dir)) continue
    if (++seen > MAX_PATH_ENTRIES) break
    const candidate = path.join(dir, file)
    if (fs.isExecutable(candidate)) return candidate
  }
  return undefined
}
