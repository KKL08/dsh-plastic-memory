import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// 挂整个插件的用例会在 DSH_HOME 下建本机状态目录：每个测试文件指到自己的临时目录，不碰真实家目录。
// 要测「没设 DSH_HOME」的用例自己 vi.stubEnv 成 undefined（只算路径，不落盘）。
const home = mkdtempSync(join(tmpdir(), 'pm-test-home-'))
process.env.DSH_HOME = home
afterAll(() => { rmSync(home, { recursive: true, force: true }) })
