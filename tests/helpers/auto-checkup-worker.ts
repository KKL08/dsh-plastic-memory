/**
 * 自动体检跨进程测试的子进程脚本（tests/auto-checkup-two-process.spec.ts 起两份）：一个子进程就是一个宿主进程里的自动体检调度。
 * 用法：node auto-checkup-worker.ts <memoryRoot> <起始时刻> <模型报的发现：conflict | none>
 * 只在进程边界换成假的：时钟、宿主计时服务、宿主 llm 服务（按宿主的流形状回文本、usage、finish）。
 * 模型调用开始后一直等 stdin 的 `open` 才回，不理会取消信号（模拟模型在认领丢了之后才回来）。
 * 协议：stdin 一行一条命令，stdout 一行一个 JSON。
 *   clock <ms>    把时钟拨到这个时刻               → {"reply":"clock"}
 *   check         立刻检查一次（不等它做完）       → {"reply":"check"}
 *   advance <ms>  推进时钟并触发到点的定时器       → {"reply":"advance"}
 *   open          让在等的模型调用返回             → {"reply":"open"}
 *   idle          等这一轮检查（含体检）做完       → {"reply":"idle"}
 * 事件：模型调用开始 {"event":"llm"}；体检做完 {"event":"scanned"}；认领被接手 {"event":"lost"}。就绪时先打 {"event":"ready"}。
 */
import { createInterface } from 'node:readline'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { FileTable } from '../../src/storage/file-table.ts'
import { SidecarStore } from '../../src/storage/sidecar.ts'
import { MemoryStore } from '../../src/store.ts'
import { buildTypeRegistry } from '../../src/type-registry.ts'
import { PendingDecisionsStore } from '../../src/governance/decisions.ts'
import { AdviceIgnoreStore } from '../../src/governance/advice-ignores.ts'
import { CheckupRecordStore } from '../../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../../src/governance/auto-checkups.ts'
import { hostSemanticLlm } from '../../src/governance/host-llm.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../../src/governance/schema.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from '../../src/gui/view-writer.ts'
import { AutoCheckupScheduler, type AutoCheckupTimer } from '../../src/gui/auto-checkup.ts'

const [root, startArg, findingsArg] = process.argv.slice(2)
if (root === undefined || startArg === undefined || findingsArg === undefined) throw new Error('usage: auto-checkup-worker.ts <root> <start> <conflict|none>')

const emit = (line: object) => { process.stdout.write(`${JSON.stringify(line)}\n`) }
const clock = { now: Number(startArg) }

// 宿主计时服务的替身：由 advance 推进时钟并按时刻先后触发
const timers: Array<{ at: number; every?: number; callback: () => void; isLive: boolean }> = []
const add = (callback: () => void, delayMs: number, every?: number) => {
  const t = { at: clock.now + delayMs, ...(every !== undefined ? { every } : {}), callback, isLive: true }
  timers.push(t)
  return () => { t.isLive = false }
}
const timer: AutoCheckupTimer = { timeout: (callback, delayMs) => add(callback, delayMs), interval: (callback, delayMs) => add(callback, delayMs, delayMs) }
function advance(ms: number) {
  const end = clock.now + ms
  for (;;) {
    const next = timers.filter(t => t.isLive && t.at <= end).sort((a, b) => a.at - b.at)[0]
    if (next === undefined) break
    clock.now = next.at
    if (next.every !== undefined) next.at += next.every
    else next.isLive = false
    next.callback()
  }
  clock.now = end
}

// 宿主 llm 服务的替身
let openGate: (() => void) | undefined
const findings = findingsArg === 'conflict'
  ? [{ type: 'conflict', memoryIds: ['mem_x', 'mem_y'], summary: '端口说法矛盾', suggestedAction: '请裁决' }]
  : []
const llm = {
  async *stream(_req: GenerateOptions): AsyncIterable<StreamChunk> {
    const gate = new Promise<void>(resolve => { openGate = resolve })
    emit({ event: 'llm' })
    await gate
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ findings }) }
    yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 80 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const quiet = { warn() {}, error() {} }
const sidecar = new SidecarStore({
  root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
  now: () => clock.now, log: { ...quiet, info() {} },
})
const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => clock.now }), undefined, sidecar.recallStats)
const checkups = new CheckupRecordStore(sidecar.checkups)
const source = { store, checkups, autoCheckups: new AutoCheckupSettingStore(sidecar.autoCheckups), cache: sidecar.scanCache, now: () => clock.now }
const writer = new ViewWriter({ memoryRoot: root, collect: () => { throw new Error('这里只写体检视图') }, collectCheckups: () => collectCheckupView(source) })
const decisions = new PendingDecisionsStore(sidecar.pending)
const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
const scheduler = new AutoCheckupScheduler({
  scan: { store, registry, decisions, cache: sidecar.scanCache, ignores },
  checkups,
  collectPending: async () => (await collectGlobalViews({ store, decisions, cache: sidecar.scanCache, ignores, checkups, registry, memoryRoot: root, now: () => clock.now })).pending,
  status: () => collectCheckupView(source),
  getDefaultLlm: () => hostSemanticLlm(llm, { provider: 'deepseek', model: 'deepseek-v4-flash' }),
  isGovernanceEnabled: () => true,
  timer,
  onChecked: () => writer.requestCheckups(),
  onClaimChanged: () => writer.requestCheckups(),
  onScanned: async () => { emit({ event: 'scanned' }); await writer.requestCheckups() },
  now: () => clock.now,
  log: { ...quiet, info: (message: string) => { if (message.includes('接手')) emit({ event: 'lost' }) } },
})

const lines = createInterface({ input: process.stdin })
emit({ event: 'ready' })
for await (const line of lines) {
  const [cmd, arg] = line.trim().split(/\s+/)
  if (cmd === 'clock') clock.now = Number(arg)
  else if (cmd === 'check') void scheduler.recheck()
  else if (cmd === 'advance') advance(Number(arg))
  else if (cmd === 'open') openGate?.()
  else if (cmd === 'idle') await scheduler.whenIdle()
  else throw new Error(`unknown command: ${line}`)
  emit({ reply: cmd })
}
await scheduler.dispose()
