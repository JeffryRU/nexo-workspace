import { lstatSync, statSync } from 'node:fs'
import { isAbsolute, posix, win32 } from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

export type ShellChoice = {
  cmd: string
  /** Aviso para el log (p. ej. `NEXO_SHELL` apuntaba a algo que no existe). */
  warning?: string
}

export type ShellProbe = {
  env: Env
  platform: NodeJS.Platform
  /** ¿Existe este archivo? (inyectable para pruebas). */
  isFile?: (path: string) => boolean
}

/**
 * Existe y no es un directorio. Los alias de ejecución de Windows (`WindowsAppspwsh.exe`) son puntos de
 * reanálisis que `statSync` no puede seguir (EACCES) pero `lstatSync` sí ve, por eso el respaldo.
 */
function defaultIsFile(path: string): boolean {
  try {
    return !statSync(path).isDirectory()
  } catch {
    try {
      return !lstatSync(path).isDirectory()
    } catch {
      return false
    }
  }
}

/** ¿Hay un ejecutable `name` en el PATH? */
export function findOnPath(
  name: string,
  env: Env,
  platform: NodeJS.Platform,
  isFile: (path: string) => boolean = defaultIsFile,
): boolean {
  const pathVar = platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH
  if (pathVar === undefined || pathVar === '') return false
  const path = platform === 'win32' ? win32 : posix
  for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
    if (dir !== '' && isFile(path.join(dir, name))) return true
  }
  return false
}

function resolvable(cmd: string, probe: ShellProbe, isFile: (p: string) => boolean): boolean {
  const abs = probe.platform === 'win32' ? win32.isAbsolute(cmd) : isAbsolute(cmd)
  if (abs) return isFile(cmd)
  if (cmd.includes('/') || cmd.includes('\\')) return false
  return findOnPath(cmd, probe.env, probe.platform, isFile)
}

/**
 * Shell por omisión del daemon (único lugar donde se decide).
 * `NEXO_SHELL` manda si existe (se toma entero como ejecutable: no se separan argumentos, así
 * una ruta con espacios funciona); si no existe o está vacío se cae al shell del sistema:
 * Windows `pwsh.exe` si está en el PATH, si no `powershell.exe`; Linux `$SHELL` o `/bin/sh`.
 */
export function resolveDefaultShell(probe: ShellProbe): ShellChoice {
  const isFile = probe.isFile ?? defaultIsFile
  const override = probe.env.NEXO_SHELL?.trim()
  let warning: string | undefined
  if (override !== undefined && override !== '') {
    if (resolvable(override, probe, isFile)) return { cmd: override }
    warning = `NEXO_SHELL="${override}" no es un ejecutable existente; se usa el shell del sistema`
  }
  const system = systemShell(probe, isFile)
  return warning === undefined ? { cmd: system } : { cmd: system, warning }
}

function systemShell(probe: ShellProbe, isFile: (p: string) => boolean): string {
  if (probe.platform === 'win32') {
    return findOnPath('pwsh.exe', probe.env, 'win32', isFile) ? 'pwsh.exe' : 'powershell.exe'
  }
  const shell = probe.env.SHELL?.trim()
  return shell !== undefined && shell !== '' && posix.isAbsolute(shell) && isFile(shell)
    ? shell
    : '/bin/sh'
}
