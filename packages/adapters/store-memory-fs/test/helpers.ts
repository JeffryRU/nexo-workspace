import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeProjectPath } from '@nexo/core'

export async function tempStateDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nexo-memory-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Ruta del archivo de un proyecto, calculada de forma independiente a la implementación. */
export function fileFor(stateDir: string, project: string): string {
  const hash = createHash('sha256').update(normalizeProjectPath(project)).digest('hex').slice(0, 32)
  return join(stateDir, 'memory', `${hash}.json`)
}
