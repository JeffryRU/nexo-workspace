import { defineConfig } from 'vitest/config'

const project = (name: string, root: string, testTimeout = 5000) => ({
  test: {
    name,
    root,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout,
    hookTimeout: testTimeout,
  },
})

export default defineConfig({
  test: {
    projects: [
      project('contracts', './packages/contracts'),
      project('core', './packages/core'),
      project('testkit', './packages/testkit'),
      project('adapter-pty-node', './packages/adapters/pty-node', 30000),
      project('client', './packages/client', 30000),
      project('daemon', './apps/daemon', 30000),
      project('cli', './apps/cli', 30000),
      project('mcp', './apps/mcp'),
      project('web', './apps/web'),
      project('tools', './tools'),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: [
        'packages/contracts/src/**/*.ts',
        'packages/core/src/**/*.ts',
        'packages/adapters/*/src/**/*.ts',
        'packages/client/src/**/*.ts',
        'apps/cli/src/**/*.ts',
      ],
      // main.ts de la CLI es solo composición: lo ejercitan las pruebas de integración (proceso hijo).
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/ports/**',
        '**/test-helpers.ts',
        'apps/cli/src/main.ts',
      ],
      thresholds: {
        'packages/contracts/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/core/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/client/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'apps/cli/src/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
        'packages/adapters/*/src/**': { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
    },
  },
})
