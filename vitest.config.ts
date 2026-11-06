import { defineConfig } from 'vitest/config'

// PM_SHIFT_CLOCK=1：把「现在」平移三年跑全量（见 tests/shift-clock.setup.ts），发版前手动跑一次，不进 CI
const shiftClock = process.env.PM_SHIFT_CLOCK === '1' ? ['tests/shift-clock.setup.ts'] : []

export default defineConfig({
  test: {
    // 超过 1 秒的用例在默认 reporter 里标出来，慢文件一眼可见
    slowTestThreshold: 1000,
    // 两个项目：服务端 tests/ 跑 Node；浏览器半侧 client/ 的组件测试跑 jsdom（spec「Testing Decisions」第 1 层）。
    projects: [
      { extends: true, test: { name: 'node', include: ['tests/**/*.spec.ts'], setupFiles: shiftClock } },
      {
        extends: true,
        test: { name: 'client', include: ['client/**/*.spec.{ts,tsx}'], environment: 'jsdom', setupFiles: [...shiftClock, 'client/test-setup.ts'] },
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
