import { sidecarSchemas } from './sidecar-schemas.ts'
/**
 * 记忆写路径的交错测试对象：接线层同款的真实模块（文件表、侧表、存储、快照、账本、界面命令处理器）建在临时目录里，
 * 操作走真实入口。用它的测试文件要像 write-interleavings.spec.ts 那样把 node:fs/promises 换成夹具包过的那份。
 */
import { confirmCodeOf } from './global-confirm.ts'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import fc from 'fast-check'
import { FileTable } from '../../src/storage/file-table.ts'
import { DerivedIndex } from '../../src/storage/derived-index.ts'
import { SidecarStore } from '../../src/storage/sidecar.ts'
import { createAgentsMdWriter } from '../../src/storage/agents-md.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, STATE_DIR, isMemoryFileName, workspaceDirName } from '../../src/storage/paths.ts'
import { MemoryStore } from '../../src/store.ts'
import { SnapshotStore, editFingerprint } from '../../src/governance/snapshots.ts'
import { PendingDecisionsStore } from '../../src/governance/decisions.ts'
import { CheckupRecordStore } from '../../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../../src/governance/auto-checkups.ts'
import { AdviceIgnoreStore } from '../../src/governance/advice-ignores.ts'
import { goneCopies } from '../../src/tools/workspace-gate.ts'
import { executePromote, type PromoteResult } from '../../src/tools/promote.ts'
import { executeSnapshotTool } from '../../src/tools/snapshot.ts'
import { executeForget } from '../../src/tools/forget.ts'
import { runSavePipeline, type PipelineResult } from '../../src/pipeline.ts'
import { buildTypeRegistry } from '../../src/type-registry.ts'
import { ViewWriter, collectGlobalViews } from '../../src/gui/view-writer.ts'
import { createMemoryCommand } from '../../src/gui/commands.ts'
import { MEMORY_COMMAND_NAME, encodeMemoryCommand, type MemoryCommand } from '../../src/gui/contract.ts'
import type { MemoryRecord } from '../../src/record-schema.ts'
import type { MemoryLogger } from '../../src/storage/table.ts'
import { createRootLock } from '../../src/storage/root-lock.ts'
import type { SectionLock } from '../../src/root-lock.ts'
import { scopeKey, scopeOfMemory } from '../../src/scope.ts'
import { record, candidate } from './record.ts'
import { NOW } from './clock.ts'
import { noInstructions } from './instructions.ts'
import { FAKE_SECRET } from './secrets.ts'
import { diskState, type OpHooks, type Outcome, type Subject, type WriteLock } from './interleave.ts'

export const W = '/home/dev/proj'
export const IDS = { a: 'mem_a', b: 'mem_b' } as const
export type Key = keyof typeof IDS
/** 初始盘面里一条记忆的样子：项目里在用、全局在用、项目最近删除里。 */
export type Init = 'workspace' | 'global' | 'deleted'
/**
 * 初始盘面。可选项：secret——这条的正文带一个高危密钥；copy——全局里另有一份 id、内容（含密钥）都相同的独立副本（这条须在项目里）；
 * isSnapshotted——铺完记忆后拍一份含两条的手动快照（「既有快照」）；conflict——账本里挂一条两者矛盾的冲突，settled 是已按保留 a 裁决过。
 */
export interface Seed {
  a: Init
  b: Init
  isSameName: boolean
  secret?: Key
  copy?: Key
  isSnapshotted?: boolean
  conflict?: 'open' | 'settled'
}

export type Verdict = 'keep-left' | 'keep-right' | 'keep-both'
export type MemOp =
  | { kind: 'create'; name: Key | 'fresh'; scope: 'global' | 'workspace' }
  | { kind: 'update' | 'softDelete' | 'restore' | 'promote' | 'guiEdit'; id: Key }
  | { kind: 'preciseEdit' | 'corroborate'; id: Key }
  | { kind: 'guiBatch' }
  | { kind: 'hardDelete'; id: Key; layer?: 'workspace' | 'global' }
  | { kind: 'modelRewrite'; id: Key; allowsSecret: boolean }
  | { kind: 'external'; id: Key; isTwoStep: boolean }
  | { kind: 'recall'; ids: Key[] }
  | { kind: 'redact' | 'purge'; id: Key }
  | { kind: 'snapshot'; ids: Key[] }   // ids 为空：拍可见集合
  | { kind: 'forget'; id: Key }
  | { kind: 'restoreSnapshot' }
  | { kind: 'resolve'; verdict: Verdict }
  | { kind: 'undo' }

/** 各操作的时刻：按操作下标固定、各不相同，并发执行与串行重放用同一组时刻，时间戳直接比较。 */
const opTime = (index: number) => NOW + (index + 1) * 1000
/** 存储自己的时钟（deletedAt 缺省、维护点的保留期与 tmp 陈旧判定、侧表）。 */
export const STORE_NOW = NOW + 10_000

const silent: MemoryLogger = { info: () => {}, warn: () => {}, error: () => {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

export interface MemoryWorld {
  root: string
  sidecar: ReturnType<typeof newSidecar>
  store: MemoryStore
  snapshots: SnapshotStore
  decisions: PendingDecisionsStore
  ignores: AdviceIgnoreStore
  /** 界面视图写入器：一个插件实例一个，各界面命令共用（它自己串行写视图）。 */
  views: ViewWriter
  /** 页面上那一份：在初始盘面上读到的记录（界面就地编辑的 base、出处都按它）。 */
  bases: Map<Key, MemoryRecord | undefined>
  /** 初始盘面里那份既有快照、那条冲突条目的 id（铺了才有）。 */
  snapshotId?: string
  decisionId?: string
}

const newSidecar = (root: string, lock: SectionLock) => new SidecarStore({
  root,
  lock,
  schemas: sidecarSchemas,
  log: silent,
  now: () => STORE_NOW,
})

// hintRacyMs 给无穷大：提示用不用不看真实时间过了多久（每次都列目录比对），同一个调度每次走出的文件调用一样
/** 接线层同款构造（src/index.ts）：一把记忆根写锁注入侧表、文件表、账本；存储、快照（带读后被彻底删除的复核）。 */
function memoryWorld(root: string, lock: WriteLock | undefined): MemoryWorld {
  const rootLock = lock ?? createRootLock({ root, log: silent })
  const sidecar = newSidecar(root, rootLock)
  const store = new MemoryStore(new FileTable({ root, lock: rootLock, stats: sidecar.recallStats, log: silent, now: () => STORE_NOW, index: new DerivedIndex({ path: join(root, STATE_DIR, 'derived', 'derived-index.sqlite'), log: silent }), hintRacyMs: Infinity }), silent, sidecar.recallStats)
  const snapshots = new SnapshotStore(sidecar.snapshots, { findGone: goneCopies(store) })
  const decisions = new PendingDecisionsStore(sidecar.pending, rootLock)
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const clock = () => STORE_NOW
  const views = new ViewWriter({
    memoryRoot: root, now: clock, sleep: async () => {},
    collect: () => collectGlobalViews({ store, decisions, cache: sidecar.scanCache, ignores, registry, memoryRoot: root, now: clock }),
  })
  return { root, sidecar, store, snapshots, decisions, ignores, views, bases: new Map() }
}

/**
 * 第一次写记忆之前停在提交点（见 OpHooks）；读不拦。进写入段（writeSection）也算：段里的读写别的操作插不进来，
 * 在段里停住的话排在中间的操作进不了段、跑不完，所以停在拿段之前。
 */
const MUTATING = new Set<PropertyKey>(['create', 'put', 'update', 'updateIfLive', 'hardDelete', 'softDelete', 'restoreArchived', 'softDeleteUnlessSecret', 'writeSection'])
function withCommitPoint(store: MemoryStore, hooks: OpHooks): MemoryStore {
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return value
      const fn = value as (...args: unknown[]) => unknown
      if (!MUTATING.has(prop)) return fn.bind(target)
      return async (...args: unknown[]) => { await hooks.beforeCommit(); return fn.apply(target, args) }
    },
  })
}

/** 界面命令处理器：接线层同款依赖，store 换成带提交点的那份，命令的时刻取这个操作的时刻。 */
function guiCommand(w: MemoryWorld, store: MemoryStore, now: number) {
  const sidecar = w.sidecar
  return createMemoryCommand({
    memoryRoot: w.root, store, decisions: w.decisions, snapshots: w.snapshots, cache: sidecar.scanCache,
    checkups: new CheckupRecordStore(sidecar.checkups), autoCheckups: new AutoCheckupSettingStore(sidecar.autoCheckups), ignores: w.ignores, registry, views: w.views,
    agentsMd: createAgentsMdWriter(join(w.root, 'AGENTS.md')),
    instructions: noInstructions, host: { contextOf: async () => ({ workspacePath: W, delegationDepth: 0, session: { id: 's-gui' } }), llmOf: () => null },
    now: () => now, log: silent,
  })
}

const NAMES: Record<Key, string> = { a: 'alpha', b: 'beta' }

const SEED_SNAPSHOT = '初始盘面的既有快照'

function seedRecord(key: Key, init: Init, name: string, isSecret = false): MemoryRecord {
  return record({
    id: IDS[key], name, type: 'knowledge', content: isSecret ? `${key} 正文 ${FAKE_SECRET.sk}` : `${key} 正文`, summary: `${key} 摘要`,
    createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW,
    ...(init === 'global' ? { scope: 'global' } : { scope: 'workspace', workspacePath: W }),
    ...(init === 'deleted' ? { status: 'deleted', deletedAt: NOW } : {}),
  })
}

const NO_HOOKS: OpHooks = { beforeCommit: async () => {} }

async function seedMemories(w: MemoryWorld, seed: Seed): Promise<void> {
  const records = [
    seedRecord('a', seed.a, NAMES.a, seed.secret === 'a'),
    seedRecord('b', seed.b, seed.isSameName ? NAMES.a : NAMES.b, seed.secret === 'b'),
  ]
  for (const r of records) await w.store.create(r)
  if (seed.copy !== undefined) await w.store.create({ ...records[seed.copy === 'a' ? 0 : 1]!, scope: 'global', workspacePath: undefined })
  // 旧 KV 导入在第一次碰账本、快照表时做，挪到播种里
  await w.snapshots.list()
  if (seed.isSnapshotted === true) await w.snapshots.capture({ operation: 'manual', description: SEED_SNAPSHOT, records }, NOW)
  if (seed.conflict !== undefined) {
    const { entry } = await w.decisions.upsert({ memoryIds: [IDS.a, IDS.b], summary: '两条矛盾', fingerprint: 'fp-ab' }, NOW)
    if (seed.conflict === 'settled') await runGui(w, NO_HOOKS, NOW, { cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' })
  }
}

/** 界面上的卡片是在初始盘面上加载的：每个世界操作之前读一次；既有快照、冲突条目的 id 一并记下。 */
async function readBases(w: MemoryWorld): Promise<void> {
  for (const key of ['a', 'b'] as const) w.bases.set(key, await w.store.get(IDS[key], { workspacePath: W }))
  w.snapshotId = (await w.snapshots.list()).find(s => s.description === SEED_SNAPSHOT)?.id
  w.decisionId = [...await w.decisions.list(), ...await w.decisions.listSettled()][0]?.id
}

/** 不经插件、不拿锁的原始改写：找到这条记忆的文件，原地写（isTwoStep：先清空再写，模拟非原子保存的编辑器）。 */
async function externalEdit(root: string, id: string, isTwoStep: boolean, index: number): Promise<string> {
  const top = [join(root, GLOBAL_DIR), join(root, workspaceDirName(W))]
  for (const dir of [...top, ...top.map(d => join(d, ARCHIVE_DIR))]) {
    let names: string[]
    try { names = await readdir(dir) } catch { continue }
    for (const name of names.filter(isMemoryFileName).sort()) {
      const path = join(dir, name)
      let text: string
      try { text = await readFile(path, 'utf8') } catch { continue }
      if (!new RegExp(`^id: ${id}$`, 'm').test(text)) continue
      if (isTwoStep) await writeFile(path, '', 'utf8')
      await writeFile(path, `${text.trimEnd()}\n手改 ${index}\n`, 'utf8')
      return 'edited'
    }
  }
  return 'absent'
}

/** 按宿主的切法把命令名之后的原文交给界面命令处理器，回处理器给的结果对象。 */
export async function runGui(w: MemoryWorld, hooks: OpHooks, now: number, command: MemoryCommand): Promise<unknown> {
  const raw = encodeMemoryCommand(command).slice(`/${MEMORY_COMMAND_NAME}`.length)
  return JSON.parse((await guiCommand(w, withCommitPoint(w.store, hooks), now).handler({ rawInput: raw, agent: {} })).text!) as unknown
}

async function runMemOp(w: MemoryWorld, op: MemOp, index: number, hooks: OpHooks): Promise<unknown> {
  const t = opTime(index)
  const at = (key: Key) => ({ id: IDS[key], workspacePath: W })
  switch (op.kind) {
    case 'create': {
      const name = op.name === 'fresh' ? `fresh${index}` : NAMES[op.name]
      await w.store.create(record({
        id: `mem_new${index}`, name, type: 'knowledge', content: `新建 ${index}`, summary: `新建 ${index}`,
        createdAt: t, updatedAt: t, lastConfirmedAt: t,
        ...(op.scope === 'global' ? { scope: 'global' } : { scope: 'workspace', workspacePath: W }),
      }))
      return 'created'
    }
    case 'update':
      return w.store.update(at(op.id), r => ({ ...r, content: `${r.content} +u${index}`, updatedAt: t }))
    case 'softDelete':
      return w.store.softDelete(at(op.id), { now: t })
    case 'restore':
      return w.store.restoreArchived(at(op.id), { now: t })
    case 'hardDelete':
      // 彻底删除走界面上的那个按钮：最近删除里的一条先清账本与快照里的这条，再在锁内复核后物理删除；在用的只删含密钥的（走完整的遗忘流程）。
      // layer：只删那一层的副本
      return runGui(w, hooks, t, {
        cmd: 'hard-delete', memoryId: IDS[op.id],
        ...(op.layer === undefined ? {} : { layer: op.layer === 'global' ? { kind: 'global' } : { kind: 'workspace', workspacePath: W } }),
      })
    case 'promote': {
      const r = await executePromote({ confirmedIds: [IDS[op.id]], target: 'global' }, { workspacePath: W },
        { store: withCommitPoint(w.store, hooks), agentsMd: createAgentsMdWriter(join(w.root, 'AGENTS.md')), snapshots: w.snapshots, now: () => t })
      return { promoted: r.promoted, skipped: r.skipped, taken: r.taken, snapshotId: r.snapshotId, message: r.message }
    }
    case 'guiEdit': {
      // 界面上那张卡是在初始盘面上加载的：base 取那时的 updatedAt 与 digest
      const base = w.bases.get(op.id)
      if (base === undefined) return 'no-card'
      return runGui(w, hooks, t, {
        cmd: 'edit-memory', memoryId: base.id, base: { updatedAt: base.updatedAt, digest: editFingerprint(base) },
        content: `界面改 ${index}`, name: base.name, summary: base.summary, tags: base.tags,
      })
    }
    case 'guiBatch': {
      const records = (['a', 'b'] as const).map(key => w.bases.get(key))
      if (records.some(r => r === undefined)) return 'no-card'
      return runGui(w, hooks, t, {
        cmd: 'apply-edits',
        ops: records.map(r => ({
          kind: 'edit', memoryId: r!.id,
          layer: scopeOfMemory(r!)!,
          base: { updatedAt: r!.updatedAt, digest: editFingerprint(r!) },
          name: r!.name, summary: r!.summary, tags: r!.tags, content: `批量改写 ${index}`,
        })),
      })
    }
    case 'preciseEdit':
    case 'corroborate':
    case 'modelRewrite': {
      // 像模型一样：改的是全局记忆就先收到引导，抄引导里的确认码重发；其间被别处改过、码变了，就照新引导再发一次
      const args = candidate({ action: 'update', change: 'correct', id: IDS[op.id], name: NAMES[op.id], type: 'knowledge', scope: 'workspace', content: `模型改写 ${index}`, summary: `模型改写 ${index}`, ...(op.kind === 'modelRewrite' && op.allowsSecret ? { allowSecret: true } : {}) })
      // 补证：同一件事又被提到，只带 id 和依据，正文不动
      const input = op.kind === 'preciseEdit'
        ? { action: 'update' as const, change: 'correct' as const, id: IDS[op.id], sourceMode: 'user-explicit' as const, edits: [{ oldString: w.bases.get(op.id)?.content ?? '不存在的正文', newString: `精确修改 ${index}` }] }
        : op.kind === 'corroborate'
          ? { action: 'update' as const, change: 'corroborate' as const, id: IDS[op.id], sourceMode: 'user-explicit' as const }
          : args
      const deps = { store: withCommitPoint(w.store, hooks), registry, workspacePath: W, session: { id: 's-model', lastSeq: 1 }, snapshots: w.snapshots, decisions: w.decisions, now: () => t }
      let r = await runSavePipeline(input, deps)
      for (let attempt = 0; attempt < 3 && r.kind === 'rejected' && r.code === 'global-update-unconfirmed'; attempt++) {
        r = await runSavePipeline({ ...input, confirmGlobal: confirmCodeOf(r) }, deps)
      }
      // 重发几次还在等确认，说明确认环节卡住了：当场失败，不让串行和交错两边一起停在这里而对上
      if (r.kind === 'rejected' && r.code === 'global-update-unconfirmed') throw new Error(`全局改写重发 3 次仍未写入：${r.reason}`)
      return r
    }
    case 'external':
      return externalEdit(w.root, IDS[op.id], op.isTwoStep, index)
    case 'recall':
      await w.store.markRecalled(op.ids.map(k => IDS[k]), t)
      return 'recalled'
    // 侧表读改写本身：对所有快照里的这条脱敏、清除（遗忘、彻底删除各自调它们）
    case 'redact':
      await w.snapshots.redact(new Set([IDS[op.id]]))
      return 'redacted'
    case 'purge':
      await w.snapshots.purge(r => r.id === IDS[op.id])
      return 'purged'
    case 'snapshot':
      // 不给 id 时拍可见集合（全局 + 本项目）里在用的全部，同 id 的两层副本各拍一份
      return executeSnapshotTool({ action: 'create', ...(op.ids.length === 0 ? {} : { memoryIds: op.ids.map(k => IDS[k]) }) }, { workspacePath: W }, { store: w.store, snapshots: w.snapshots, now: () => t })
    case 'forget':
      // 模型的遗忘工具：快照先行、软删；含密钥的物理删除，所有快照里脱敏
      return executeForget({ ids: [IDS[op.id]], reason: `遗忘 ${index}` }, { workspacePath: W },
        { store: withCommitPoint(w.store, hooks), snapshots: w.snapshots, decisions: w.decisions, now: () => t, log: silent })
    case 'restoreSnapshot':
      if (w.snapshotId === undefined) return 'no-snapshot'
      return executeSnapshotTool({ action: 'restore', snapshotId: w.snapshotId, overwriteChanged: true }, { workspacePath: W },
        { store: withCommitPoint(w.store, hooks), snapshots: w.snapshots, now: () => t })
    case 'resolve':
      if (w.decisionId === undefined) return 'no-entry'
      return runGui(w, hooks, t, { cmd: 'resolve', decisionId: w.decisionId, verdict: op.verdict })
    case 'undo':
      if (w.decisionId === undefined) return 'no-entry'
      return runGui(w, hooks, t, { cmd: 'undo', decisionId: w.decisionId })
  }
}

export const labelOf = (op: MemOp) => {
  switch (op.kind) {
    case 'create': return `create(${op.name},${op.scope})`
    case 'modelRewrite': return `modelRewrite(${op.id}${op.allowsSecret ? ',allowSecret' : ''})`
    case 'external': return `external(${op.id}${op.isTwoStep ? ',两步' : ''})`
    case 'hardDelete': return `hardDelete(${op.id}${op.layer === undefined ? '' : `,${op.layer}`})`
    case 'recall': return `recall(${op.ids.join('+')})`
    case 'snapshot': return `snapshot(${op.ids.length === 0 ? '可见' : op.ids.join('+')})`
    case 'guiBatch': case 'restoreSnapshot': case 'undo': return op.kind
    case 'resolve': return `resolve(${op.verdict})`
    default: return `${op.kind}(${op.id})`
  }
}

/**
 * 允许串行重放拆开的结果，都是竞争类拒绝（读后被改或被删而放弃的写入）：界面编辑回 stale、彻底删除回 failed、
 * 模型改写回 changed-after-read（精确修改在最新正文上重做成功的带 edit-rebased）、提升计入 skipped。这些操作在锁内复核之前已经按「快照先行」拍了快照，被拒后这份
 * 改动前的快照留在盘上（无害，保留期满清扫），整体串行重放复现不出这份快照，所以在提交点拆开比。
 */
function splitTag(value: unknown, op: MemOp): string | undefined {
  if (op.kind === 'guiEdit' || op.kind === 'guiBatch') return (value as { code?: string }).code === 'stale' ? 'race' : undefined
  // 锁内复核发现定位之后被恢复或改过，没有删（清账本、快照在复核之前已经做了）
  if (op.kind === 'hardDelete') return (value as { code?: string }).code === 'failed' ? 'race' : undefined
  if (op.kind === 'modelRewrite' || op.kind === 'preciseEdit' || op.kind === 'corroborate') {
    const r = value as PipelineResult
    // 精确修改在别处改过的正文上重做成功：结果里带着期间有人改过的说明，整体串行重放同样复现不出，也在提交点拆开比
    if (r.kind === 'updated' && r.warnings?.some(w => w.code === 'edit-rebased') === true) return 'race'
    return r.kind === 'rejected' && r.subcode === 'changed-after-read' ? 'race' : undefined
  }
  if (op.kind === 'promote') {
    const r = value as PromoteResult
    // 预读时还在、快照已拍，搬家时发现被别处删了或改过：计入 skipped，快照留下
    return r.skipped.length > 0 && r.snapshotId !== null ? 'race' : undefined
  }
  // 遗忘、裁决删败方：先行快照已拍，软删时发现预读之后被改过或搬走，不删（裁决回「败方没有删掉」，条目留着）
  if (op.kind === 'forget') {
    const r = value as { snapshotId: string | null; forgotten: string[] }
    return r.snapshotId !== null && !r.forgotten.includes(IDS[op.id]) ? 'race' : undefined
  }
  if (op.kind === 'resolve') {
    const r = value as { ok?: boolean; code?: string; detail?: string }
    return r.ok === false && r.code === 'failed' && r.detail?.includes('没有删掉') === true ? 'race' : undefined
  }
  return undefined
}

/**
 * 盘面：记忆根下全部文件的原文。界面视图（.state/gui/）不比：它是派生缓存，任何一次读都可能读到别的写入中途的状态，
 * 下一次视图重写收敛，记忆数据不受影响。写锁的锁库（.state/lock/）也不比：它不存数据。
 * 派生索引库（.state/derived/，正式接线里在记忆根之外）也不比：它可以从记忆文件重建。
 */
const memoryState = async (_: MemoryWorld, root: string) =>
  diskState(root, path => !path.startsWith(`${STATE_DIR}/gui/`) && !path.startsWith(`${STATE_DIR}/lock/`) && !path.startsWith(`${STATE_DIR}/derived/`))

/** 认领不到、立即返回（界面命令的 claimed）：判据把它当成没发生过（见 Subject.isClaimed）。 */
const isClaimed = (value: unknown) => (value as { ok?: boolean; code?: string } | null)?.ok === false && (value as { code?: string }).code === 'claimed'

export const memorySubject = (seed: Seed): Subject<MemoryWorld, MemOp> => ({
  world: memoryWorld,
  seed: w => seedMemories(w, seed),
  seedKey: JSON.stringify(seed),
  prepare: readBases,
  run: runMemOp,
  label: labelOf,
  state: memoryState,
  splitTag,
  isClaimed,
})

/**
 * 硬删之后快照里没有明文：快照里带着密钥的那条记录，它自己那一层此刻必须还有这个 id（在用、软删都算）；
 * 哪层都没了（被物理删除）还留着明文，就是删掉的密钥能从快照恢复出来。别层还有同 id 的副本不算数，那是另一份。
 */
export async function secretProblems(w: MemoryWorld): Promise<string[]> {
  const problems: string[] = []
  for (const snap of await w.snapshots.list()) {
    for (const r of snap.data) {
      if (!r.content.includes(FAKE_SECRET.sk)) continue
      const own = scopeOfMemory(r)
      const copies = await w.store.copiesOf(r.id)
      if (own !== undefined && copies.some(scope => scopeKey(scope) === scopeKey(own))) continue
      problems.push(`快照 ${snap.id} 里 ${r.id}（${own === undefined ? '?' : scopeKey(own)}）带着明文密钥，这一层已经没有它`)
    }
  }
  return problems
}

/** 带上 secretProblems 这条不变量的测试对象。 */
export const secretSubject = (seed: Seed): Subject<MemoryWorld, MemOp> => ({
  ...memorySubject(seed),
  invariant: async (w: MemoryWorld, _ops: readonly MemOp[], _outcomes: readonly Outcome[]) => secretProblems(w),
})

export const initArb = fc.constantFrom<Init>('workspace', 'global', 'deleted')
export const seedArb: fc.Arbitrary<Seed> = fc.record({ a: initArb, b: initArb, isSameName: fc.boolean() })
export const keyArb = fc.constantFrom<Key>('a', 'b')
/** 拍快照的 id：空表示拍可见集合。 */
export const snapshotIdsArb = fc.constantFrom<Key[]>([], ['a'], ['a', 'b'])
export const writeOpArb: fc.Arbitrary<MemOp> = fc.oneof(
  fc.record({ kind: fc.constant('create' as const), name: fc.constantFrom<Key | 'fresh'>('a', 'b', 'fresh'), scope: fc.constantFrom('global' as const, 'workspace' as const) }),
  fc.record({ kind: fc.constantFrom('update' as const, 'softDelete' as const, 'restore' as const, 'hardDelete' as const, 'promote' as const, 'guiEdit' as const), id: keyArb }),
  fc.record({ kind: fc.constant('modelRewrite' as const), id: keyArb, allowsSecret: fc.boolean() }),
)
export const externalOpArb: fc.Arbitrary<MemOp> = fc.record({ kind: fc.constant('external' as const), id: keyArb, isTwoStep: fc.boolean() })
