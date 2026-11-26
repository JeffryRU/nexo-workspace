import { defineConfig } from 'vitest/config'

// Solo las pruebas reales (NEXO_LIVE_MEMORY_OLLAMA=1, NEXO_LIVE_MEMORY_PROVIDER=<id>); el proyecto normal excluye *.live.test.ts.
export default defineConfig({
  test: { include: ['src/**/*.live.test.ts'], environment: 'node', testTimeout: 300000 },
})
