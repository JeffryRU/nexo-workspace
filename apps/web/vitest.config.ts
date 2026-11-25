import solid from 'vite-plugin-solid'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ['browser'] },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    server: {
      deps: { inline: [/solid-js/, /@solidjs\/testing-library/, /@tanstack\/solid-query/] },
    },
  },
})
