import { registerSettleTests } from './confirm-executor.test.ts'

// 用例在 confirm-executor.test.ts。这个入口留着，是因为它在 vitest.config.ts 的无 SQLite 名单里，两个测试项目都要跑它。
registerSettleTests()
