import { tmpdir } from 'node:os'
import { runAgentProviderConformance } from '@nexo/testkit/conformance'
import { createAcpProvider } from '../src/index.ts'
import { AGENT } from './helpers.ts'

runAgentProviderConformance('provider-acp (agente ACP falso)', () => ({
  provider: createAcpProvider({
    agent: AGENT,
    env: { ...process.env },
    probeCacheMs: 0,
    limits: { interruptGraceMs: 1500 },
  }),
  open: { cwd: tmpdir(), permissionMode: 'ask' },
  prompts: { simple: 'simple', long: 'long', permission: 'permiso' },
}))
