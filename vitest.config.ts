import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // Coverage stays opt-in (`pnpm test:coverage`); the plain `test` run never
    // writes to coverage/. lcov/html embed absolute paths, so the reports dir is
    // gitignored and excluded from publish.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**'],
    },
  },
})
