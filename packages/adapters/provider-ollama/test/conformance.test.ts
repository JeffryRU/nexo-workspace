import { runAgentProviderConformance } from '@nexo/testkit/conformance'
import { afterAll, beforeAll } from 'vitest'
import { createOllamaProvider } from '../src/provider.ts'
import { FakeOllama } from './fake-ollama.ts'

const fake = new FakeOllama()
beforeAll(async () => {
  await fake.start()
})
afterAll(() => fake.stop())

runAgentProviderConformance('provider-ollama (servidor HTTP falso)', () => ({
  provider: createOllamaProvider({ baseUrl: fake.url, probeCacheMs: 0 }),
  open: { cwd: '/tmp', permissionMode: 'ask' },
  prompts: { simple: 'simple', long: 'long' },
}))
