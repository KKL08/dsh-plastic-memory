import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { INDEX_FILE, workspaceDirName } from '../src/storage/paths.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import { ViewWriter, collectGlobalViews } from '../src/gui/view-writer.ts'
import { createMemoryCommand } from '../src/gui/commands.ts'
import { MEMORY_COMMAND_NAME, encodeMemoryCommand, type MemoryCommand } from '../src/gui/contract.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { scopeAt } from '../src/scope.ts'
import { candidate, record } from './helpers/record.ts'

// 撤销条目的指纹取本次提交的那条：A 已写盘、还没记撤销条目时 B 写进同一条，撤销 A 不能把 B 当成 A 写的盖掉。
// fs 是进程边界：给 writeFile 套一层闸门，让 A 写盘后维护索引那一步停住；这时另一个进程（真实 writeFile）把 B 写进同一个文件，再放行 A。
const { writeGate } = vi.hoisted(() => ({
  writeGate: { current: undefined as { match: (path: string) => boolean; entered: () => void; release: Promise<void> } | undefined },
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writeFile = vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
    const g = writeGate.current
    if (g !== undefined && g.match(String(args[0]))) {
      writeGate.current = undefined
      g.entered()
      await g.release
    }
    return actual.writeFile(...args)
  })
  return { ...actual, writeFile }
})

const WS = '/ws/race'
const NOW = 1_800_000_000_000
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-undo-race-')) })
afterEach(async () => {
  writeGate.current = undefined
  await rm(root, { recursive: true, force: true })
})

function env() {
  const now = () => NOW
  const sidecar = new SidecarStore({ root, log: quietLog, now, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, log: quietLog, now }), quietLog, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const views = new ViewWriter({ memoryRoot: root, collect: () => collectGlobalViews({ store, decisions, snapshots, cache: sidecar.scanCache, ignores, registry, memoryRoot: root, now }), now, sleep: async () => {} })
  const command = createMemoryCommand({
    memoryRoot: root, store, decisions, snapshots, cache: sidecar.scanCache, registry, views, ignores,
    checkups: new CheckupRecordStore(sidecar.checkups), autoCheckups: new AutoCheckupSettingStore(sidecar.autoCheckups),
    agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')),
    host: { contextOf: async () => ({ workspacePath: WS, delegationDepth: 0, session: { id: 'sess-1' } }), llmOf: () => null, baselineOf: () => null },
    now, log: quietLog,
  })
  const run = async (c: MemoryCommand) =>
    JSON.parse((await command.handler({ rawInput: encodeMemoryCommand(c).slice(`/${MEMORY_COMMAND_NAME}`.length), agent: {} })).text!) as { ok: boolean; code?: string }
  const save = (partial: object) => runSavePipeline(
    candidate({ scope: 'workspace', force: true, ...partial }),
    { store, registry, workspacePath: WS, session: { id: 'sess-1', lastSeq: 1 }, snapshots, decisions, callId: 'call-a', now },
  )
  return { store, decisions, run, save }
}

describe('撤销条目记本次提交的记录', () => {
  it('PA-36 A 改写已写盘、还没记撤销条目时 B 写进同一条：撤销 A 回 stale，B 的版本保持', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_r', name: '名', summary: '改前摘要', content: '改前的内容', scope: 'workspace', workspacePath: WS }))
    const dir = join(root, workspaceDirName(WS))
    const file = join(dir, (await readdir(dir)).find(n => n.startsWith('名'))!)

    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    // A 改了摘要：写完记忆文件后维护点要重写索引，就停在写索引的临时文件上
    writeGate.current = { match: p => p.startsWith(join(dir, INDEX_FILE)), entered, release: new Promise((resolve) => { release = resolve }) }
    const saving = e.save({ action: 'update', id: 'mem_r', name: '名', summary: 'A 的摘要', content: 'A 改写的' })
    await reached
    const a = (await e.store.get('mem_r', scopeAt(WS)))!
    expect(a.content).toBe('A 改写的')
    await writeFile(file, encodeRecord({ ...a, content: 'B 紧接着写的' }, {}), 'utf8')
    release()
    expect((await saving).kind).toBe('updated')

    const entry = (await e.decisions.listSettled()).find(d => d.kind === 'rewrite')!
    expect((await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('stale')
    expect((await e.store.get('mem_r', scopeAt(WS)))!.content).toBe('B 紧接着写的')
  })
})
