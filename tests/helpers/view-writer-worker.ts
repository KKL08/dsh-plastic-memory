/**
 * 视图写入接锁的双进程子进程脚本（tests/root-lock-wiring.spec.ts 的 RL-11 起两份，模拟同开的两个 dsh 进程各自的视图写入器）。
 * 存储按接线层的方式搭：一把真写锁注入文件表、侧表；视图写入器拿的是同一把锁外面套的屏障装饰器（lock-barrier.ts），
 * 所以屏障只数视图写入的 run。
 * 用法：node view-writer-worker.ts <memoryRoot> <信号目录> <标签> <nowMs> <要停住的 run 序号，逗号分隔；- 表示都不停>
 * nowMs 是本进程收集视图的时刻（即视图的 generatedAt）；写入器自己的时钟晚它一分钟，晚于两个进程的收集时刻。
 * 收集全局视图时，收集完先发 `<标签>.collect.<k>.done`，等 `<标签>.collect.<k>.go` 再交给写入器（k 从 1 数）：
 * 测试拿它让「早收集」和「晚写」分开。
 * 协议：就绪后 stdout 打 `ready`；stdin 每行一条命令，命令之间不互相等待，做完回一行：
 *   library        请求重写记忆库视图；回 `wrote library`
 *   workspace <p>  记一笔会话归属 p → p；回 `wrote workspace <p>`
 * 日志写 stderr。stdin 关闭后进程自然退出。
 */
import { createInterface } from 'node:readline'
import { FileTable } from '../../src/storage/file-table.ts'
import { SidecarStore } from '../../src/storage/sidecar.ts'
import { createRootLock } from '../../src/storage/root-lock.ts'
import { MemoryStore } from '../../src/store.ts'
import { buildTypeRegistry } from '../../src/type-registry.ts'
import { PendingDecisionsStore } from '../../src/governance/decisions.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../../src/governance/schema.ts'
import { ViewWriter, collectGlobalViews } from '../../src/gui/view-writer.ts'
import { barrierLock } from './lock-barrier.ts'
import { signal, waitForSignal } from './signal-files.ts'

const [root, signalDir, tag, nowArg, pauseArg] = process.argv.slice(2)
if (root === undefined || signalDir === undefined || tag === undefined || nowArg === undefined || pauseArg === undefined) {
  throw new Error('usage: view-writer-worker.ts <root> <signalDir> <tag> <nowMs> <pauseRuns|->')
}
const nowMs = Number(nowArg)
const now = () => nowMs
const pauseRuns = new Set(pauseArg === '-' ? [] : pauseArg.split(',').map(Number))

const toStderr = (message: string) => { process.stderr.write(`${message}\n`) }
const log = { info: toStderr, warn: toStderr, error: toStderr }
const lock = createRootLock({ root, log })
const sidecar = new SidecarStore({
  root, lock, log, now, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
})
const store = new MemoryStore(new FileTable({ root, lock, stats: sidecar.recallStats, log, now }), log, sidecar.recallStats)
const decisions = new PendingDecisionsStore(sidecar.pending, lock)
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let collects = 0
const views = new ViewWriter({
  memoryRoot: root, log, now: () => nowMs + 60_000, sleep: async () => {},
  lock: barrierLock(lock, { dir: signalDir, name: tag, pause: n => pauseRuns.has(n) }),
  collect: async () => {
    const k = ++collects
    const collected = await collectGlobalViews({ store, decisions, cache: sidecar.scanCache, registry, memoryRoot: root, now, log })
    await signal(signalDir, `${tag}.collect.${k}.done`)
    await waitForSignal(signalDir, `${tag}.collect.${k}.go`)
    return collected
  },
})

const say = (line: string) => { process.stdout.write(`${line}\n`) }
createInterface({ input: process.stdin }).on('line', line => {
  const [cmd, arg] = line.split(' ')
  if (cmd === 'library') void views.request(['library']).then(() => { say('wrote library') })
  else if (cmd === 'workspace' && arg !== undefined) void views.requestWorkspace(arg, arg).then(() => { say(`wrote workspace ${arg}`) })
  else throw new Error(`未知命令：${line}`)
})
say('ready')
