import { lstatSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** Comando listo para `spawn(command, args)`, sin shell. */
export type CodexCommand = { command: string; args: string[] }

export type ResolveFs = {
  /** `true` si `path` es un archivo (no un directorio). */
  isFile(path: string): boolean
}

export type ResolveOptions = {
  /** Ruta o nombre del ejecutable (`NEXO_CODEX_EXECUTABLE`); por omisión `codex`. */
  executable?: string | undefined
  env: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  cwd?: string
  /** Ruta de `node`, para lanzar un `codex.js`; por omisión el Node que ejecuta el daemon. */
  nodePath?: string
  fs?: ResolveFs
}

/** Existe y no es un directorio; en Windows también los alias de ejecución (`WindowsApps`), que `stat` no sigue. */
export const nodeResolveFs: ResolveFs = {
  isFile(path) {
    try {
      return statSync(path).isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        try {
          return !lstatSync(path).isDirectory()
        } catch {
          return false
        }
      }
      return false
    }
  },
}

function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/**
 * Resuelve cómo lanzar `codex app-server` **sin shell**.
 *
 * - Un `.exe` o un binario se lanza tal cual.
 * - Un `.js`/`.mjs`/`.cjs` se lanza con Node.
 * - En Windows, `spawn` sin shell no puede ejecutar los `.cmd`/`.bat` que crea npm (`codex.cmd`): se busca
 *   el `codex.js` que ese shim invoca (`node_modules/@openai/codex/bin/codex.js`, junto al shim) y se
 *   lanza con Node. Si no está, devuelve un error que pide apuntar `NEXO_CODEX_EXECUTABLE` a `codex.exe`.
 * - En Windows se prueban primero `.exe`/`.com` y después `.cmd`/`.bat`; el archivo sin extensión que npm
 *   deja (un script de `sh`) nunca se elige.
 */
export function resolveCodexCommand(options: ResolveOptions): CodexCommand | { error: string } {
  const platform = options.platform ?? process.platform
  const windows = platform === 'win32'
  // Las reglas de rutas son las de la plataforma pedida (no las del sistema que ejecuta), para poder probarlas.
  const path = windows ? win32 : posix
  const fs = options.fs ?? nodeResolveFs
  const cwd = options.cwd ?? process.cwd()
  const name = options.executable ?? 'codex'
  const hasSeparator = name.includes('/') || (windows && name.includes('\\'))
  const hasExtension = /\.[A-Za-z0-9]+$/.test(name)

  let names: string[]
  if (!windows) names = [name]
  else if (hasExtension) names = [name]
  else {
    const pathext = (readEnv(options.env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter((e) => e !== '')
    const rank = (e: string) => (/^\.(exe|com)$/i.test(e) ? 0 : 1)
    names = [...pathext].sort((a, b) => rank(a) - rank(b)).map((ext) => name + ext)
  }
  const dirs = hasSeparator
    ? ['']
    : (readEnv(options.env, 'PATH', platform) ?? '').split(path.delimiter).filter((d) => d !== '')

  let found: string | undefined
  search: for (const dir of dirs) {
    for (const candidate of names) {
      const file = hasSeparator
        ? path.resolve(cwd, candidate)
        : path.join(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), candidate)
      if (fs.isFile(file)) {
        found = file
        break search
      }
    }
  }
  if (found === undefined) {
    return {
      error: hasSeparator
        ? `no existe el ejecutable de Codex: ${name}`
        : 'no se encontró «codex» en el PATH',
    }
  }

  const node = options.nodePath ?? process.execPath
  if (/\.(c|m)?js$/i.test(found)) return { command: node, args: [found] }
  if (windows && /\.(cmd|bat)$/i.test(found)) {
    // npm deja junto al shim el script que este invoca.
    const script = path.join(
      path.dirname(found),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    )
    if (fs.isFile(script)) return { command: node, args: [script] }
    return {
      error: `«${found}» es un script de npm que no se puede lanzar sin shell; apunta NEXO_CODEX_EXECUTABLE a codex.exe o a codex.js`,
    }
  }
  return { command: found, args: [] }
}
