// 由 vitest.config.ts 的 node-no-sqlite 项目挂上：这个 worker 里 node:sqlite 加载不到，每一把记忆根写锁都退回进程内保护。
// 快照、侧表读改写相关的用例在这一档再跑一遍：写锁不可用时，进程内的保护不能比有锁时差。
// 只替换进程边界（内置模块加载），自己的模块不动；tests/no-sqlite.spec.ts 核对这一档确实生效。
const original = process.getBuiltinModule.bind(process)
process.getBuiltinModule = ((id: string) => (id === 'node:sqlite' ? undefined : original(id))) as typeof process.getBuiltinModule
