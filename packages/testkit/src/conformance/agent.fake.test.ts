import { FakeAgentProvider } from '../fake-agent.ts'
import { runAgentProviderConformance } from './agent.ts'

runAgentProviderConformance('FakeAgentProvider', () => ({
  provider: new FakeAgentProvider('fake'),
  open: { cwd: '/work', permissionMode: 'ask' },
  prompts: { simple: 'hola', long: 'long', permission: 'permission' },
}))
