import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 两个项目：服务端 tests/ 跑 Node；浏览器半侧 client/ 的组件测试跑 jsdom（spec「Testing Decisions」第 1 层）。
    projects: [
      { extends: true, test: { name: 'node', include: ['tests/**/*.spec.ts'] } },
      {
        extends: true,
        test: { name: 'client', include: ['client/**/*.spec.{ts,tsx}'], environment: 'jsdom', setupFiles: ['client/test-setup.ts'] },
      },
    ],
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
