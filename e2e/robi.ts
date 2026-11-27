import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** El paquete real de `examples/companions/robi` (ruta relativa -> bytes), para instalarlo en el daemon de prueba. */
export function robiPackage(): Record<string, Buffer> {
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'examples',
    'companions',
    'robi',
  )
  return Object.fromEntries(readdirSync(root).map((name) => [name, readFileSync(join(root, name))]))
}
