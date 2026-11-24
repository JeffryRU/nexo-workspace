import { defineConfig } from 'vitest/config'

const project = (name: string, root: string) => ({
  test: { name, root, include: ['src/**/*.test.ts', 'test/**/*.test.ts'], environment: 'node' },
})

export default defineConfig({
  test: {
    projects: [
      project('contracts', './packages/contracts'),
      project('core', './packages/core'),
      project('testkit', './packages/testkit'),
      project('client', './packages/client'),
      project('daemon', './apps/daemon'),
      project('cli', './apps/cli'),
      project('mcp', './apps/mcp'),
      project('web', './apps/web'),
      project('tools', './tools'),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: ['packages/contracts/src/**/*.ts', 'packages/core/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/ports/**'],
      thresholds: {
        'packages/contracts/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/core/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
})
