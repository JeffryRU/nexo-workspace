import { runMemoryStoreConformance } from '@nexo/testkit/conformance'
import { FsMemoryStore } from '../src/index.ts'
import { tempStateDir } from './helpers.ts'

const MAX = 64 * 1024

runMemoryStoreConformance('FsMemoryStore', async () => {
  const { dir, cleanup } = await tempStateDir()
  return {
    store: new FsMemoryStore({ stateDir: dir, maxProjectBytes: MAX }),
    maxBytes: MAX,
    cleanup,
  }
})
