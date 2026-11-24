import { sidecarSchemas, createPluginEnv } from './plugin-env.ts'
import { afterEach, beforeEach, expect } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore } from '../../src/storage/sidecar.ts'
import type { LegacyKvTables } from '../../src/storage/legacy-kv-import.ts'
import { createAgentsMdWriter } from '../../src/storage/agents-md.ts'
import { STATE_DIR } from '../../src/storage/paths.ts'
import { type MemoryLogger, type MemoryTable } from '../../src/store.ts'
import { buildTypeRegistry } from '../../src/type-registry.ts'
import { type PendingTable } from '../../src/governance/decisions.ts'
import { AdviceIgnoreStore } from '../../src/governance/advice-ignores.ts'
import type { SemanticLlm } from '../../src/governance/semantic-scan.ts'
import { ModelSelectionStore, type HostModelCatalog } from '../../src/governance/background-llm.ts'
import { RETENTION_MS } from '../../src/retention.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from '../../src/gui/view-writer.ts'
import { createMemoryCommand } from '../../src/gui/commands.ts'
import { CheckupSuggestions } from '../../src/gui/checkup-suggestions.ts'
import { GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, GUI_VIEW_FILES, MEMORY_COMMAND_NAME, encodeMemoryCommand, checkupViewSchema, memoryCommandResultSchema, type MemoryCommand, type MemoryCommandResult, type PendingItem } from '../../src/gui/contract.ts'
import type { ReadEventFn } from '../../src/tools/source.ts'
import { record } from './record.ts'
import { instructionsOf } from './instructions.ts'

// /memory 命令处理器：真实临时目录（FileTable + .state 侧表 + 视图文件），只把宿主那一侧
// （借来的会话：workspace、子 agent 深度、模型、基线）换成测试桩。断言账本、记忆文件、快照与视图的终态。

const NOW = 10 * RETENTION_MS
const SESSION_WS = '/tmp/pm-cmd-session'
const OTHER_WS = '/tmp/pm-cmd-other'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
function setRoot(value: string) { root = value }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-gui-commands-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

interface EnvOpts {
  /** Wrap the ledger table to interleave operations between reads and writes. */
  wrapPending?: (table: PendingTable) => PendingTable
  workspacePath?: string
  delegationDepth?: number
  llm?: SemanticLlm | null
  /** Instructions keyed by global or workspace path; workspace entries include both layers. */
  instructions?: Parameters<typeof instructionsOf>[0]
  now?: number
  /** Whether checkups are enabled; defaults to true. */
  governanceEnabled?: boolean
  /** Wrap the view writer to inject collection or write failures. */
  wrapViews?: (writer: ViewWriter) => Pick<ViewWriter, 'request' | 'rewriteAll' | 'collectViews' | 'requestCheckups'>
  log?: MemoryLogger
  /** Claim heartbeat scheduling; defaults to real intervals. */
  heartbeat?: (callback: () => void, delayMs: number) => () => void
  /** Memory table; defaults to a real temporary file table. */
  table?: MemoryTable
  /** Optional legacy side-table import source. */
  openLegacyKv?: () => Promise<LegacyKvTables | undefined>
  /** Optional host event reader. */
  readEvent?: ReadEventFn
  /** Enable suggestion generation after scanning. */
  withSuggestions?: boolean
  /** 宿主 llm 服务的列模型部分；缺省当宿主没有。 */
  catalog?: HostModelCatalog
}

function env(opts: EnvOpts = {}) {
  const clock = { now: opts.now ?? NOW }
  // 侧表也用这个时钟：认领的时间和是否残留按它算
  const sidecar = new SidecarStore({
    root, schemas: sidecarSchemas, now: () => clock.now,
    ...(opts.openLegacyKv !== undefined ? { openLegacyKv: opts.openLegacyKv } : {}),
  })
  // 表和命令用同一个时钟：软删记的时刻和最近删除的保留期清扫才对得上
  const { store, decisions, snapshots, checkups, autoCheckups } = createPluginEnv(sidecar, { root, stats: sidecar.recallStats, now: () => clock.now }, { table: opts.table, pending: opts.wrapPending?.(sidecar.pending) })
  const cache = sidecar.scanCache
  const selections = new ModelSelectionStore(sidecar.modelSelections)
  let suggestions: CheckupSuggestions | undefined
  const views = new ViewWriter({
    memoryRoot: root,
    collect: () => collectGlobalViews({
      store, decisions, snapshots, cache, checkups, autoCheckups, registry, memoryRoot: root, now: () => clock.now,
      ...(suggestions !== undefined ? { generatingSuggestions: () => suggestions!.generatingIds() } : {}),
    }),
    collectCheckups: () => collectCheckupView({ store, checkups, autoCheckups, selections, cache, now: () => clock.now, ...(opts.governanceEnabled !== undefined ? { isGovernanceEnabled: () => opts.governanceEnabled! } : {}) }),
    // 替换间隔按测试时钟算、不真等：节流本身由视图测试单独覆盖
    now: () => clock.now, sleep: async () => {}, lock: sidecar.lock,
  })
  // 本进程调度器收到的「设置改了」通知次数
  const autoCheckupChanges = { count: 0 }
  const instructions = instructionsOf(opts.instructions)
  if (opts.withSuggestions === true) suggestions = new CheckupSuggestions({ store, decisions, checkups, views, instructions, now: () => clock.now, log: { info() {}, warn() {}, error() {} } })
  const command = createMemoryCommand({
    memoryRoot: root, store, decisions, snapshots, cache, checkups, autoCheckups, selections, ignores: new AdviceIgnoreStore(sidecar.adviceIgnores), registry, views: opts.wrapViews?.(views) ?? views,
    onAutoCheckupChanged: () => { autoCheckupChanges.count++ },
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.heartbeat !== undefined ? { heartbeat: opts.heartbeat } : {}),
    agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')),
    host: { contextOf: async () => ({ workspacePath: 'workspacePath' in opts ? opts.workspacePath : SESSION_WS, delegationDepth: opts.delegationDepth ?? 0, session: { id: 'sess-1' } }), llmOf: () => (opts.llm === undefined ? null : opts.llm), modelCatalog: () => opts.catalog },
    instructions,
    ...(opts.governanceEnabled !== undefined ? { isGovernanceEnabled: () => opts.governanceEnabled! } : {}),
    ...(opts.readEvent !== undefined ? { getReadEvent: () => opts.readEvent! } : {}),
    isLegacyImportSettled: () => sidecar.isLegacyImportSettled(),
    ...(suggestions !== undefined ? { suggestions } : {}),
    now: () => clock.now,
  })
  /** Pass the raw suffix, including whitespace, as the host parser does. */
  const runRaw = async (rawInput: string) => {
    const r = await command.handler({ rawInput, agent: {} })
    expect(typeof r.text).toBe('string')
    const body = memoryCommandResultSchema.parse(JSON.parse(r.text!))
    expect(r.kind).toBe(body.ok ? 'success' : 'error')
    return body
  }
  const run = (c: MemoryCommand) => runRaw(encodeMemoryCommand(c).slice(`/${MEMORY_COMMAND_NAME}`.length))
  const readView = async (name: keyof typeof GUI_VIEW_FILES) => JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES[name]), 'utf8')) as unknown
  const readCheckupView = async () => checkupViewSchema.parse(JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_CHECKUP_VIEW_FILE), 'utf8')))
  return { store, decisions, snapshots, cache, checkups, autoCheckups, selections, autoCheckupChanges, stats: sidecar.recallStats, command, run, runRaw, readView, readCheckupView, clock, suggestions }
}

type Ok = Extract<MemoryCommandResult, { ok: true }>
type Err = Extract<MemoryCommandResult, { ok: false }>
const ok = (r: MemoryCommandResult): Ok => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Ok }
const err = (r: MemoryCommandResult): Err => { expect(r.ok, JSON.stringify(r)).toBe(false); return r as Err }

async function seedPair(e: ReturnType<typeof env>, ws?: string) {
  const scoped = ws === undefined ? {} : { scope: 'workspace' as const, workspacePath: ws }
  await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', ...scoped }))
  await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', ...scoped }))
  return (await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)).entry
}

const allEntries = async (e: ReturnType<typeof env>) => [...await e.decisions.list(), ...await e.decisions.listSettled()]

/** Map relative paths to contents outside the side-table directory. */
async function memoryTree(): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter(d => d.isFile()).map(d => join(d.parentPath, d.name).slice(root.length + 1)).filter(rel => !rel.startsWith(`${STATE_DIR}/`)).sort()
  return Object.fromEntries(await Promise.all(files.map(async rel => [rel, await readFile(join(root, rel), 'utf8')] as const)))
}

/** Exclude advice caused by the fixture records having old confirmation dates. */
const ledgerItems = (view: { items: readonly PendingItem[] }) => view.items.filter(i => i.kind !== 'advice')
export { NOW, SESSION_WS, OTHER_WS, registry, root, setRoot, type EnvOpts, env, type Ok, type Err, ok, err, seedPair, allEntries, memoryTree, ledgerItems }
