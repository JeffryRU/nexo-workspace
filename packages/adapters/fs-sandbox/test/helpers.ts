import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FsSandbox } from '../src/index.ts'

export type Rig = {
  /** Carpeta permitida (ya resuelta). */
  root: string
  /** Carpeta hermana, fuera de la raíz. */
  outsideDir: string
  sandbox: FsSandbox
  /** Roots que ve el sandbox; se puede cambiar. */
  roots: string[]
  inside(rel: string): string
  outside(rel: string): string
  put(path: string, content: string | Uint8Array): Promise<void>
  cleanup(): Promise<void>
}

export async function makeRig(): Promise<Rig> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nexo-fs-')))
  const root = join(base, 'work')
  const outsideDir = join(base, 'elsewhere')
  await mkdir(root)
  await mkdir(outsideDir)
  const roots = [root]
  const sandbox = new FsSandbox({ roots: () => roots })
  const at = (dir: string, rel: string) => join(dir, ...rel.split('/'))
  return {
    root,
    outsideDir,
    sandbox,
    roots,
    inside: (rel) => at(root, rel),
    outside: (rel) => at(outsideDir, rel),
    put: async (path, content) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}
