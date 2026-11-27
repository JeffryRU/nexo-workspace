import { runCompanionConformance } from '@nexo/testkit/conformance'
import { makeRig } from './helpers.ts'

runCompanionConformance('FsCompanionPort', async () => {
  const rig = await makeRig()
  return { port: rig.port, put: rig.put, cleanup: rig.cleanup }
})
