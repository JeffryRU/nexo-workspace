import { runAgentProviderConformance } from '@nexo/testkit/conformance'
import { createClaudeProvider } from '../src/provider.ts'
import { FakeTransport, tempDir } from './helpers.ts'

runAgentProviderConformance('provider-claude (transporte falso)', () => {
  const dir = tempDir()
  const transport = new FakeTransport()
  return {
    provider: createClaudeProvider({ transport, env: {}, interruptTimeoutMs: 500 }),
    open: { cwd: dir.path, permissionMode: 'ask' },
    prompts: { simple: 'simple', long: 'long', permission: 'permission' },
    cleanup: () => dir.remove(),
  }
})
