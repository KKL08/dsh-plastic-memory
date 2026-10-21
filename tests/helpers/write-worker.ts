/**
 * 双进程写路径测试的子进程脚本（tests/write-two-process.spec.ts 起两份）。
 * 用法：node write-worker.ts <memoryRoot> <标签> <步骤：create | create,forget>
 * 协议：就绪后 stdout 打 `ready`，等 stdin 一行 `go` 再开写（两个进程同时起跑，不靠 sleep）；
 * 写完 stdout 打一行 JSON `{ "id": "...", "content": "..." }`，退出码 0。
 * 两个进程用同一个 name（同 slug）、不同 id，抢同一个文件名。
 */
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { FileTable } from '../../src/storage/file-table.ts'
import { InMemoryKvTable } from '../../src/kv-table.ts'
import type { RecallStats } from '../../src/storage/schema.ts'
import { record } from './record.ts'

const [root, tag, stepsArg] = process.argv.slice(2)
if (root === undefined || tag === undefined || stepsArg === undefined) throw new Error('usage: write-worker.ts <root> <tag> <steps>')
const steps = stepsArg.split(',')

const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })
const own = record({ id: `mem_${tag}`, name: '抢名', content: `进程 ${tag} 的正文`, updatedAt: Date.now() })

const lines = createInterface({ input: process.stdin })
process.stdout.write('ready\n')
await once(lines, 'line')
lines.close()

for (const step of steps) {
  if (step === 'create') await table.create(own)
  else if (step === 'forget') await table.update(own.id, r => ({ ...r, status: 'deleted', updatedAt: Date.now() }))
  else throw new Error(`unknown step: ${step}`)
}
process.stdout.write(`${JSON.stringify({ id: own.id, content: own.content })}\n`)
