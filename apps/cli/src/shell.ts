import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** ¿Hay un ejecutable `name` en el PATH? (`exists` inyectable para pruebas). */
export function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const pathVar = platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH
  if (pathVar === undefined || pathVar === '') return false
  const path = platform === 'win32' ? win32 : posix
  for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
    if (dir !== '' && exists(path.join(dir, name))) return true
  }
  return false
}

/** Shell por omisión: NEXO_SHELL; en Windows pwsh.exe si existe, si no powershell.exe; en Linux $SHELL o /bin/sh. */
export function defaultShell(options: {
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  commandExists: (name: string) => boolean
}): string {
  const override = options.env.NEXO_SHELL
  if (override !== undefined && override !== '') return override
  if (options.platform === 'win32') {
    return options.commandExists('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe'
  }
  const shell = options.env.SHELL
  return shell !== undefined && shell !== '' ? shell : '/bin/sh'
}
