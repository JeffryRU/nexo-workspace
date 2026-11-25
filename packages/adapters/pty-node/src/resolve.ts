import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

function isFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Valor de una variable de entorno; en Windows las claves no distinguen mayúsculas. */
export function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/**
 * Resuelve `cmd` a una ruta de archivo ejecutable (búsqueda en PATH como `execvp`; en Windows
 * prueba además las extensiones de PATHEXT). Devuelve `undefined` si no existe.
 */
export function resolveExecutable(
  cmd: string,
  options: {
    cwd: string
    env: Readonly<Record<string, string | undefined>>
    platform: NodeJS.Platform
  },
): string | undefined {
  const { cwd, env, platform } = options
  const windows = platform === 'win32'
  const hasSeparator = cmd.includes('/') || (windows && cmd.includes('\\'))
  const dirs = hasSeparator
    ? ['']
    : (readEnv(env, 'PATH', platform) ?? '').split(delimiter).filter((d) => d !== '')
  const extensions = windows
    ? (readEnv(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter((e) => e !== '')
    : []
  const names = windows ? [cmd, ...extensions.map((ext) => cmd + ext)] : [cmd]

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = hasSeparator
        ? resolve(cwd, name)
        : join(isAbsolute(dir) ? dir : resolve(cwd, dir), name)
      if (isFile(candidate, platform)) return candidate
    }
  }
  return undefined
}
