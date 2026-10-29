/**
 * 双进程工具调用测试的子进程脚本（tests/sidecar-two-process.spec.ts 起两份，模拟同时开着的两个 dsh 进程）。
 * 用法：node tool-worker.ts <memoryRoot> <workspacePath> <标签>
 * 存储按接线层的方式搭：FileTable + .state/ 侧表，工具走真实执行器（forget / search / snapshot）。
 * 协议：搭好后 stdout 打 `ready`；之后 stdin 每行一条 JSON 命令，按序执行，stdout 每条回一行 JSON 结果：
 *   {"op":"forget","ids":[...],"reason":"..."}       → executeForget 的结果
 *   {"op":"search","query":"..."}                    → executeSearch 的结果
 *   {"op":"restore","snapshotId":"..."}              → executeSnapshotTool restore 的结果
 * stdin 关闭后退出，退出码 0。
 */
import { createInterface } from 'node:readline'
import { FileTable } from '../../src/storage/file-table.ts'
import { SidecarStore } from '../../src/storage/sidecar.ts'
import { MemoryStore } from '../../src/store.ts'
import { SnapshotStore } from '../../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../../src/governance/decisions.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../../src/governance/schema.ts'
import { buildTypeRegistry } from '../../src/type-registry.ts'
import { executeForget } from '../../src/tools/forget.ts'
import { executeSearch } from '../../src/tools/search.ts'
import { executeSnapshotTool } from '../../src/tools/snapshot.ts'
import { fakeExec } from './exec.ts'

const [root, workspacePath, tag] = process.argv.slice(2)
if (root === undefined || workspacePath === undefined || tag === undefined) throw new Error('usage: tool-worker.ts <root> <workspacePath> <tag>')

// stdout 只走协议行：日志一律写 stderr
const log = {
  info: (message: string) => { process.stderr.write(`${message}\n`) },
  warn: (message: string) => { process.stderr.write(`${message}\n`) },
  error: (message: string) => { process.stderr.write(`${message}\n`) },
}
const sidecar = new SidecarStore({
  root, log, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
})
const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, log }), log, sidecar.recallStats)
const snapshots = new SnapshotStore(sidecar.snapshots)
const decisions = new PendingDecisionsStore(sidecar.pending)
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const session = { id: `s-${tag}`, lastSeq: 1 }

type Command =
  | { op: 'forget'; ids: string[]; reason: string }
  | { op: 'search'; query: string }
  | { op: 'restore'; snapshotId: string }

async function run(cmd: Command): Promise<unknown> {
  switch (cmd.op) {
    case 'forget':
      return executeForget({ ids: cmd.ids, reason: cmd.reason }, { workspacePath }, { store, snapshots, decisions, log })
    case 'search':
      return executeSearch({ query: cmd.query }, fakeExec(), { store, registry, resolveContext: async () => ({ workspacePath, session }) })
    case 'restore':
      return executeSnapshotTool({ action: 'restore', snapshotId: cmd.snapshotId }, { workspacePath }, { store, snapshots })
  }
}

const lines = createInterface({ input: process.stdin })
process.stdout.write('ready\n')
for await (const line of lines) {
  if (line.trim() === '') continue
  process.stdout.write(`${JSON.stringify(await run(JSON.parse(line) as Command))}\n`)
}
