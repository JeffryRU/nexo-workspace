import { tmpdir } from 'node:os'
import { runAgentProviderConformance } from '@nexo/testkit/conformance'
import { createAntigravityProvider } from '../src/index.ts'
import { FAKE } from './helpers.ts'

// `agy` no pide permisos en modo no interactivo: se omite el grupo de permisos de la suite.
runAgentProviderConformance('provider-antigravity (agy falso)', () => ({
  provider: createAntigravityProvider({
    env: { ...process.env },
    executable: FAKE,
    probeCacheMs: 0,
    limits: { interruptGraceMs: 1500 },
  }),
  open: { cwd: tmpdir(), permissionMode: 'ask' },
  prompts: { simple: 'simple', long: 'long' },
}))
