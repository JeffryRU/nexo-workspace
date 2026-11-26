import { defineConfig } from 'vitest/config'

// Solo la prueba real (NEXO_LIVE_ACP=1); el proyecto normal excluye *.live.test.ts.
export default defineConfig({
  test: { include: ['test/**/*.live.test.ts'], environment: 'node', testTimeout: 180000 },
})
