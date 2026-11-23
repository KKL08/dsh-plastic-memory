import { defineConfig } from 'vitest/config'

// PM_SHIFT_CLOCK=1：把「现在」平移三年跑全量（见 tests/shift-clock.setup.ts），发版前手动跑一次，不进 CI
const shiftClock = process.env.PM_SHIFT_CLOCK === '1' ? ['tests/shift-clock.setup.ts'] : []
// 服务端用例的 DSH_HOME 指到临时目录：本机状态目录不落进真实家目录
const isolateHome = ['tests/dsh-home.setup.ts']

// 写锁不可用（node:sqlite 加载不到）时再跑一遍的用例：快照的改写、恢复、硬删与侧表读改写，都只在本进程里、不起子进程。
// 写锁退回进程内保护后，这些保护不能比有锁时差。no-sqlite.spec.ts 核对这一档确实没有锁，只在这一档跑。
const noSqlite = [
  'tests/no-sqlite.spec.ts',
  'tests/sidecar.spec.ts',
  'tests/sidecar-rmw-in-process.spec.ts',
  'tests/snapshot-restore-purge-race.spec.ts',
  'tests/secret-hard-delete.spec.ts',
  'tests/undo.spec.ts',
  'tests/undo-entry-race.spec.ts',
  'tests/hand-edit-restore.spec.ts',
  'tests/confirm-settle.spec.ts',
  'tests/gui-commands.spec.ts',
  'tests/write-interleaving-regressions.spec.ts',
  'tests/write-interleavings-sidecar.spec.ts',
  'tests/write-interleavings-secrets.spec.ts',
]

export default defineConfig({
  test: {
    // 超过 1 秒的用例在默认 reporter 里标出来，慢文件一眼可见
    slowTestThreshold: 1000,
    // 三个项目：服务端 tests/ 跑 Node；同一批快照相关用例在写锁不可用时再跑一遍；浏览器半侧 client/ 的组件测试跑 jsdom（spec「Testing Decisions」第 1 层）。
    projects: [
      { extends: true, test: { name: 'node', include: ['tests/**/*.spec.ts'], exclude: ['tests/no-sqlite.spec.ts'], setupFiles: [...shiftClock, ...isolateHome] } },
      { extends: true, test: { name: 'node-no-sqlite', include: noSqlite, setupFiles: [...shiftClock, ...isolateHome, 'tests/no-sqlite.setup.ts'] } },
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
