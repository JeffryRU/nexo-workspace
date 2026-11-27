import { createFakeCompanions } from '../fake-companion.ts'
import { runCompanionConformance } from './companion.ts'

runCompanionConformance('FakeCompanionPort', () => {
  const { port, source } = createFakeCompanions()
  return { port, put: async (id, files) => source.put(id, files) }
})
