import { lstatSync, readFileSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** Comando listo para `spawn(command, args)`, sin shell. */
export type AgentCommand = { command: string; args: string[] }

export type ResolveFs = {
  /** `true` si `path` es un archivo (no un directorio). */
  isFile(path: string): boolean
  /** Contenido de un archivo pequeño (un shim `.cmd` de npm); `undefined` si no se puede leer. */
  readText(path: string): string | undefined
}

export type ResolveOptions = {
  /** Nombre o ruta del ejecutable del agente (`command` de su configuración). */
  command: string
  /** Argumentos del agente (`args`), que van después de los que pida el lanzamiento (p. ej. el `.js`). */
  args?: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  cwd?: string
  /** Ruta de `node`, para lanzar un `.js`; por omisión el Node que ejecuta el daemon. */
  nodePath?: string
  fs?: ResolveFs
}

const MAX_SHIM_BYTES = 64 * 1024

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
  readText(path) {
    try {
      const text = readFileSync(path, 'utf8')
      return text.length > MAX_SHIM_BYTES ? undefined : text
    } catch {
      return undefined
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

/** El `.js` que invoca un shim `.cmd` de npm (`"%dp0%\node_modules\...\bin.js"`), si está y existe. */
function shimScript(
  text: string,
  shim: string,
  fs: ResolveFs,
  path: typeof win32 | typeof posix,
): string | undefined {
  const match = /%dp0%\\(node_modules\\[^"\r\n%]+?\.(?:c|m)?js)"/i.exec(text)
  if (match?.[1] === undefined) return undefined
  const dir = path.dirname(shim)
  const script = path.join(dir, ...match[1].split('\\'))
  // Nunca fuera de la carpeta del shim (ni con `..`).
  if (path.relative(dir, script).startsWith('..')) return undefined
  return fs.isFile(script) ? script : undefined
}

/**
 * Resuelve cómo lanzar un agente ACP **sin shell**.
 *
 * - Un `.exe` o un binario se lanza tal cual.
 * - Un `.js`/`.mjs`/`.cjs` se lanza con Node.
 * - En Windows, `spawn` sin shell no puede ejecutar los `.cmd`/`.bat` que crea npm (`gemini.cmd`): se lee el
 *   shim, se busca el `.js` que invoca (junto a él, en `node_modules`) y se lanza con Node. Si no se
 *   encuentra, devuelve un error que pide poner en la configuración la ruta del `.exe` o del `.js`.
 * - En Windows se prueban primero `.exe`/`.com` y después `.cmd`/`.bat`; el archivo sin extensión que npm
 *   deja (un script de `sh`) nunca se elige.
 */
export function resolveAgentCommand(options: ResolveOptions): AgentCommand | { error: string } {
  const platform = options.platform ?? process.platform
  const windows = platform === 'win32'
  // Las reglas de rutas son las de la plataforma pedida (no las del sistema que ejecuta), para poder probarlas.
  const path = windows ? win32 : posix
  const fs = options.fs ?? nodeResolveFs
  const cwd = options.cwd ?? process.cwd()
  const name = options.command
  const rest = [...(options.args ?? [])]
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
        ? `no existe el ejecutable: ${name}`
        : `no se encontró «${name}» en el PATH`,
    }
  }

  const node = options.nodePath ?? process.execPath
  if (/\.(c|m)?js$/i.test(found)) return { command: node, args: [found, ...rest] }
  if (windows && /\.(cmd|bat)$/i.test(found)) {
    const text = fs.readText(found)
    const script = text === undefined ? undefined : shimScript(text, found, fs, path)
    if (script !== undefined) return { command: node, args: [script, ...rest] }
    return {
      error: `«${found}» es un script de npm que no se puede lanzar sin shell; pon en «command» la ruta del .exe o del .js del agente`,
    }
  }
  return { command: found, args: rest }
}
