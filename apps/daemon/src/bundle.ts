import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
