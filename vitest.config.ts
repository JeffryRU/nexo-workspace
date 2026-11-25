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
      project('client', './packages/client'),
      project('daemon', './apps/daemon', 30000),
      project('cli', './apps/cli'),
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
      ],
      exclude: ['**/*.test.ts', '**/index.ts', '**/ports/**'],
      thresholds: {
        'packages/contracts/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/core/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/adapters/*/src/**': { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
    },
  },
})
