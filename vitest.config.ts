import { defineConfig } from 'vitest/config'

// Pruebas pesadas: procesos reales (daemon, CLI), PTY reales y E/S de archivos enormes. Corren en un único
// proyecto, un archivo a la vez, para que no compitan entre sí ni con el resto: en Windows, ConPTY y el
// arranque de procesos se ralentizan mucho bajo carga (timeouts al azar, issue #18) y dos suites con PTY
// reales a la vez llegaron a tumbar un worker.
const heavyFiles = [
  'packages/adapters/pty-node/test/**/*.test.ts',
  'packages/adapters/pty-host/test/**/*.test.ts',
  'apps/cli/src/cli.integration.test.ts',
  'apps/cli/src/cli.adversarial.test.ts',
  'apps/daemon/src/daemon.integration.test.ts',
  'apps/daemon/src/daemon.adversarial.test.ts',
  'packages/client/src/node/daemon.integration.test.ts',
  'packages/client/src/node/discovery.adversarial.test.ts',
]

const heavyProject = (name: string, include: string[]) => ({
  test: {
    name,
    root: '.',
    include,
    environment: 'node' as const,
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
})

/** Los patrones pesados que caen dentro de `root`, relativos a él, para excluirlos del proyecto ligero. */
const heavyWithin = (root: string) => {
  const prefix = `${root.replace(/^\.\//, '')}/`
  return heavyFiles.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
}

const project = (name: string, root: string, testTimeout = 5000) => ({
  test: {
    name,
    root,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', ...heavyWithin(root)],
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
      project('adapter-pty-host', './packages/adapters/pty-host', 30000),
      project('client', './packages/client', 30000),
      project('daemon', './apps/daemon', 30000),
      project('cli', './apps/cli', 30000),
      project('mcp', './apps/mcp'),
      './apps/web',
      project('tools', './tools'),
      heavyProject('heavy', heavyFiles),
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
        'apps/web/src/**/*.{ts,tsx}',
      ],
      // main.ts de la CLI es solo composición: lo ejercitan las pruebas de integración (proceso hijo).
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/ports/**',
        '**/test-helpers.ts',
        'apps/cli/src/main.ts',
        '**/*.test.tsx',
        'apps/web/src/main.tsx',
        'apps/web/src/vite-env.d.ts',
        'apps/web/src/test-*.{ts,tsx}',
      ],
      thresholds: {
        'packages/contracts/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/core/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/client/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'apps/cli/src/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
        'apps/web/src/**': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'packages/adapters/*/src/**': { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
    },
  },
})
