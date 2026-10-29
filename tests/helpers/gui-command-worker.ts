/**
 * 双进程界面命令测试的子进程脚本（tests/gui-advice-ignore.spec.ts 起两份，模拟同时开着的两个 dsh 进程各自的界面命令）。
 * 用法：node gui-command-worker.ts <memoryRoot> <workspacePath> <标签> <nowMs>
 * 存储按接线层的方式搭：FileTable + .state/ 侧表 + 视图写入器，命令走真实的 /memory 处理器。
 * 协议：搭好后 stdout 打 `ready`；之后 stdin 每行一条 JSON 命令，按序执行，stdout 每条回一行 JSON 结果：
 *   {"op":"command","raw":"..."}   → 命令名之后的原文交给处理器，回处理器给出的结果对象
 *   {"op":"ignores"}               → 本进程读到的忽略记录
 * stdin 关闭后退出，退出码 0。
 */
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { FileTable } from '../../src/storage/file-table.ts'
import { SidecarStore } from '../../src/storage/sidecar.ts'
import { createAgentsMdWriter } from '../../src/storage/agents-md.ts'
import { MemoryStore } from '../../src/store.ts'
import { buildTypeRegistry } from '../../src/type-registry.ts'
import { PendingDecisionsStore } from '../../src/governance/decisions.ts'
import { SnapshotStore } from '../../src/governance/snapshots.ts'
import { CheckupRecordStore } from '../../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../../src/governance/auto-checkups.ts'
import { AdviceIgnoreStore } from '../../src/governance/advice-ignores.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../../src/governance/schema.ts'
import { ViewWriter, collectGlobalViews } from '../../src/gui/view-writer.ts'
import { createMemoryCommand } from '../../src/gui/commands.ts'

const [root, workspacePath, tag, nowArg] = process.argv.slice(2)
if (root === undefined || workspacePath === undefined || tag === undefined || nowArg === undefined) {
  throw new Error('usage: gui-command-worker.ts <root> <workspacePath> <tag> <nowMs>')
}
const nowMs = Number(nowArg)
const now = () => nowMs

// stdout 只走协议行：日志一律写 stderr
const log = {
  info: (message: string) => { process.stderr.write(`${message}\n`) },
  warn: (message: string) => { process.stderr.write(`${message}\n`) },
  error: (message: string) => { process.stderr.write(`${message}\n`) },
}
const sidecar = new SidecarStore({
  root, log, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
})
const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, log, now }), log, sidecar.recallStats)
const decisions = new PendingDecisionsStore(sidecar.pending)
const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
const cache = sidecar.scanCache
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const views = new ViewWriter({ memoryRoot: root, collect: () => collectGlobalViews({ store, decisions, cache, ignores, registry, memoryRoot: root, now }) })
const command = createMemoryCommand({
  memoryRoot: root, store, decisions, snapshots: new SnapshotStore(sidecar.snapshots), cache,
  checkups: new CheckupRecordStore(sidecar.checkups), autoCheckups: new AutoCheckupSettingStore(sidecar.autoCheckups), ignores, registry, views,
  agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')),
  resolveContext: async () => ({ workspacePath, delegationDepth: 0, session: { id: `s-${tag}` } }),
  getLlm: () => null, getBaseline: () => null, now,
})

type Command =
  | { op: 'command'; raw: string }
  | { op: 'ignores' }

async function run(cmd: Command): Promise<unknown> {
  switch (cmd.op) {
    case 'command':
      return JSON.parse((await command.handler({ rawInput: cmd.raw, agent: {} })).text!) as unknown
    case 'ignores':
      return ignores.list()
  }
}

const lines = createInterface({ input: process.stdin })
process.stdout.write('ready\n')
for await (const line of lines) {
  if (line.trim() === '') continue
  process.stdout.write(`${JSON.stringify(await run(JSON.parse(line) as Command))}\n`)
}
