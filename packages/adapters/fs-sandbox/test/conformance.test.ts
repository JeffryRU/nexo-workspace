import { runFileSystemConformance } from '@nexo/testkit/conformance'
import { makeRig } from './helpers.ts'

runFileSystemConformance('FsSandbox', async () => {
  const rig = await makeRig()
  return {
    fs: rig.sandbox,
    inside: rig.inside,
    outside: rig.outside,
    put: rig.put,
    cleanup: rig.cleanup,
  }
})
