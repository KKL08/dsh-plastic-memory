/**
 * 双进程侧表测试的子进程脚本（tests/sidecar-two-process.spec.ts 起两份）。
 * 用法：node sidecar-worker.ts <memoryRoot> <快照条数> <标签>
 * 协议：就绪后 stdout 打 `ready`，等 stdin 一行 `go` 再开写（两个进程同时起跑，不靠 sleep）；
 * 写完 stdout 打一行 JSON `{ "ids": [...] }`（本进程拍下的快照 id），退出码 0。
 */
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { SidecarStore } from '../../src/storage/sidecar.ts'
import { SnapshotStore } from '../../src/governance/snapshots.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../../src/governance/schema.ts'
import { MemoryStore, InMemoryTable } from '../../src/store.ts'
import { record } from './record.ts'

const [root, countArg, tag] = process.argv.slice(2)
if (root === undefined || countArg === undefined || tag === undefined) throw new Error('usage: sidecar-worker.ts <root> <count> <tag>')

const sidecar = new SidecarStore({
  root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
})
const snapshots = new SnapshotStore(sidecar.snapshots)
const store = new MemoryStore(new InMemoryTable(), undefined, sidecar.recallStats)
const shared = record({ id: 'mem_shared' })
const own = record({ id: `mem_${tag}` })
await store.put(shared)
await store.put(own)

const lines = createInterface({ input: process.stdin })
process.stdout.write('ready\n')
await once(lines, 'line')
lines.close()

const ids: string[] = []
for (let i = 0; i < Number(countArg); i++) {
  const snap = await snapshots.capture({ operation: 'manual', description: `${tag}-${i}`, records: [shared, own] }, Date.now())
  ids.push(snap.id)
  await store.markRecalled([shared.id, own.id])
}
process.stdout.write(`${JSON.stringify({ ids })}\n`)
