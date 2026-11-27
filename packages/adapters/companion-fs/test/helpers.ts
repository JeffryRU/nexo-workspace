import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createFsCompanionPort } from '../src/index.ts'

export type Rig = {
  /** `<datos>/companions` (ya resuelta). */
  dir: string
  /** Carpeta hermana, fuera de los paquetes. */
  outside: string
  port: ReturnType<typeof createFsCompanionPort>
  put(id: string, files: Record<string, Uint8Array>): Promise<void>
  cleanup(): Promise<void>
}

export async function makeRig(): Promise<Rig> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nexo-companion-')))
  const dir = join(base, 'companions')
  const outside = join(base, 'elsewhere')
  await mkdir(dir)
  await mkdir(outside)
  return {
    dir,
    outside,
    port: createFsCompanionPort({ dir }),
    put: async (id, files) => {
      for (const [rel, bytes] of Object.entries(files)) {
        const target = join(dir, id, ...rel.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes)
      }
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}
