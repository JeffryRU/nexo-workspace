import { defineConfig, devices } from '@playwright/test'

const ci = process.env.CI !== undefined && process.env.CI !== ''

// Dos proyectos: `e2e` (extremo a extremo, `pnpm e2e`) y `perf` (rendimiento, `pnpm perf`). Van de a un
// archivo y un worker: cada prueba levanta su propio daemon y los tiempos no deben competir entre sí.
export default defineConfig({
  testDir: '.',
  workers: 1,
  fullyParallel: false,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: ci ? [['list'], ['html', { open: 'never', outputFolder: 'report' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'e2e',
      testMatch: ['e2e.spec.ts', 'adversarial.spec.ts', 'agent.spec.ts', 'memory.spec.ts'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'perf',
      testMatch: ['perf.spec.ts'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'node ../tools/e2e-web.mjs',
    url: 'http://localhost:5173',
    reuseExistingServer: !ci,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
