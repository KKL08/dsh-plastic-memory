/**
 * 侧表读改写的双进程用例子进程脚本（tests/sidecar-read-modify-write.spec.ts 起两份）。存储按接线层的方式搭：
 * 一把真写锁注入文件表、侧表、待决账本，写锁外面套屏障装饰器（lock-barrier.ts）。
 * 用法：node sidecar-rmw-worker.ts <memoryRoot> <信号目录> <标签>
 * 协议：就绪后 stdout 打 `ready`；stdin 每行一条命令，命令之间不互相等待，做完各回一行：
 *   arm               下一次 run 拿到锁后停住（等 `<标签>.<n>.go`），回 `armed <n>`
 *   peek              不停，只回下一次 run 的序号 `next <n>`
 *   recall <id> <k>   依次记 k 次召回，回 `recalled`
 *   redact <id>       所有快照里脱敏这条记录（密钥硬删那一步），回 `redacted`
 *   purge <id>        所有快照里清除这条记录（彻底删除那一步），回 `purged`
 *   resolve <待决项 id> <裁决>  走 memory_confirm 的 resolve，回一行 JSON { kind, code, isHardDeleted }
 *   update <id> <名字>          锁外定位、锁内改名，回 `updated` 或 `not-found`
 * stdin 关闭后进程自然退出。
 */
import { createInterface } from 'node:readline'
import { FileTable } from '../../src/storage/file-table.ts'
import { SidecarStore } from '../../src/storage/sidecar.ts'
import { createRootLock } from '../../src/storage/root-lock.ts'
import { MemoryStore } from '../../src/store.ts'
import { SnapshotStore } from '../../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../../src/governance/decisions.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../../src/governance/schema.ts'
import { executeConfirm } from '../../src/tools/confirm.ts'
import { goneCopies } from '../../src/tools/workspace-gate.ts'
import { RecordNotFoundError } from '../../src/errors.ts'
import type { RootLock } from '../../src/root-lock.ts'
import { barrierLock } from './lock-barrier.ts'
import { noInstructions } from './instructions.ts'

const [root, signalDir, tag] = process.argv.slice(2)
if (root === undefined || signalDir === undefined || tag === undefined) throw new Error('usage: sidecar-rmw-worker.ts <root> <signalDir> <tag>')

const toStderr = (message: string) => { process.stderr.write(`${message}\n`) }
const log = { info: () => {}, warn: toStderr, error: toStderr }
let pauseAt = 0
let runs = 0
const barrier = barrierLock(createRootLock({ root, log }), { dir: signalDir, name: tag, pause: n => n === pauseAt })
// 屏障按 run 的调用次数编号，这里同步数一遍，arm / peek 才知道下一次是第几次
const lock: RootLock = { run: fn => { runs++; return barrier.run(fn) } }

const sidecar = new SidecarStore({
  root, lock, log, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
})
const store = new MemoryStore(new FileTable({ root, lock, stats: sidecar.recallStats, log }), log, sidecar.recallStats)
const snapshots = new SnapshotStore(sidecar.snapshots, { findGone: goneCopies(store) })
const decisions = new PendingDecisionsStore(sidecar.pending, lock)
const say = (line: string) => { process.stdout.write(`${line}\n`) }

async function handle(line: string): Promise<string> {
  const [cmd, a, b] = line.split(' ')
  switch (cmd) {
    case 'arm':
      pauseAt = runs + 1
      return `armed ${pauseAt}`
    case 'peek':
      return `next ${runs + 1}`
    case 'recall':
      for (let i = 0; i < Number(b); i++) await store.markRecalled([a!])
      return 'recalled'
    case 'redact':
      await snapshots.redact(new Set([a!]))
      return 'redacted'
    case 'purge':
      await snapshots.purge(r => r.id === a)
      return 'purged'
    case 'resolve': {
      const r = await executeConfirm({ action: 'resolve', decisionId: a!, verdict: b as 'keep-left' }, { workspacePath: undefined },
        { store, decisions, snapshots, log, instructions: noInstructions })
      return JSON.stringify({ kind: r.kind, code: 'code' in r ? r.code : undefined, isHardDeleted: 'isHardDeleted' in r ? r.isHardDeleted : undefined })
    }
    case 'update': {
      const current = await store.get(a!)
      if (current === undefined) return 'not-found'
      try {
        await store.update(current, r => ({ ...r, name: b!, updatedAt: Date.now() }))
        return 'updated'
      } catch (err) {
        if (err instanceof RecordNotFoundError) return 'not-found'
        throw err
      }
    }
    default:
      throw new Error(`未知命令：${line}`)
  }
}

// 先过侧表的旧 KV 导入屏障（第一次访问侧表），之后的 run 序号只数命令里的
await sidecar.snapshots.list()
createInterface({ input: process.stdin }).on('line', line => { void handle(line).then(say) })
say('ready')
