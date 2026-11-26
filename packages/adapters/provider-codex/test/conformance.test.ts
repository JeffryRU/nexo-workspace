import { tmpdir } from 'node:os'
import { runAgentProviderConformance } from '@nexo/testkit/conformance'
import { createCodexProvider } from '../src/index.ts'
import { FAKE } from './helpers.ts'

runAgentProviderConformance('provider-codex (proceso app-server falso)', () => ({
  provider: createCodexProvider({
    env: { ...process.env },
    executable: FAKE,
    probeCacheMs: 0,
    limits: { interruptGraceMs: 1500 },
  }),
  open: { cwd: tmpdir(), permissionMode: 'ask' },
  prompts: { simple: 'simple', long: 'long', permission: 'permiso' },
}))
