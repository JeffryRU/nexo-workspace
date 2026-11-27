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
  'apps/cli/src/agent.integration.test.ts',
  'apps/cli/src/memory.integration.test.ts',
  'apps/daemon/src/daemon.integration.test.ts',
  'apps/daemon/src/agents.integration.test.ts',
  'apps/daemon/src/memory.integration.test.ts',
  'apps/daemon/src/daemon.adversarial.test.ts',
  'packages/client/src/node/daemon.integration.test.ts',
  'packages/client/src/node/discovery.adversarial.test.ts',
  'apps/mcp/src/mcp.integration.test.ts',
  'apps/mcp/src/main.adversarial.test.ts',
]

// Máquinas lentas o compartidas (p. ej. un VPS con otras cargas): NEXO_TEST_TIMEOUT_SCALE=3 triplica los plazos
// de las pruebas. Vale 1 por omisión; el CI no lo usa. Ver AGENTS.md.
const parsedScale = Number(process.env.NEXO_TEST_TIMEOUT_SCALE ?? '1')
const scale = Number.isFinite(parsedScale) && parsedScale >= 1 ? Math.min(parsedScale, 20) : 1

const heavyProject = (name: string, include: string[]) => ({
  test: {
    name,
    root: '.',
    include,
    environment: 'node' as const,
    testTimeout: 30000 * scale,
    hookTimeout: 30000 * scale,
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
    // Las pruebas *.live.test.ts usan el SDK y credenciales reales: solo corren a mano (ver docs).
    exclude: ['**/node_modules/**', '**/*.live.test.ts', ...heavyWithin(root)],
    environment: 'node',
    testTimeout: testTimeout * scale,
    hookTimeout: testTimeout * scale,
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
      project('adapter-provider-claude', './packages/adapters/provider-claude', 15000),
      project('adapter-provider-ollama', './packages/adapters/provider-ollama', 15000),
      project('adapter-provider-codex', './packages/adapters/provider-codex', 15000),
      project('adapter-provider-acp', './packages/adapters/provider-acp', 15000),
      project('adapter-provider-antigravity', './packages/adapters/provider-antigravity', 15000),
      project('adapter-fs-sandbox', './packages/adapters/fs-sandbox', 15000),
      project('adapter-store-memory-fs', './packages/adapters/store-memory-fs', 15000),
      project('adapter-summarizer-ollama', './packages/adapters/summarizer-ollama', 15000),
      project('jsonrpc', './packages/jsonrpc'),
      project('client', './packages/client', 30000),
      project('daemon', './apps/daemon', 30000),
      project('cli', './apps/cli', 30000),
      project('mcp', './apps/mcp', 15000),
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
        'packages/jsonrpc/src/**/*.ts',
        'packages/adapters/*/src/**/*.ts',
        'packages/client/src/**/*.ts',
        'apps/cli/src/**/*.ts',
        'apps/mcp/src/**/*.ts',
        'apps/web/src/**/*.{ts,tsx}',
      ],
      // main.ts de la CLI es solo composición: lo ejercitan las pruebas de integración (proceso hijo).
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/ports/**',
        '**/test-helpers.ts',
        'apps/cli/src/main.ts',
        // Igual que la CLI: composición del proceso (lo ejercitan las pruebas con proceso hijo) y ayudas de integración.
        'apps/mcp/src/main.ts',
        'apps/mcp/src/integration-helpers.ts',
        // Composición del proceso pty host (corre en un hijo); su lógica está en host-handler.ts.
        'packages/adapters/pty-host/src/host.ts',
        '**/*.test.tsx',
        'apps/web/src/main.tsx',
        'apps/web/src/vite-env.d.ts',
        'apps/web/src/test-*.{ts,tsx}',
      ],
      thresholds: {
        'packages/contracts/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/core/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/jsonrpc/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'packages/client/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'apps/cli/src/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
        'apps/mcp/src/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
        'apps/web/src/**': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'packages/adapters/*/src/**': { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
    },
  },
})
