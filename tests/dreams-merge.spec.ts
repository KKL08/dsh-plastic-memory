import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import type { DreamMarks, DreamsRecord, RecallStats } from '../src/storage/schema.ts'
import { STATE_CHANGE_VERSION, layerOf } from '../src/storage/history.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { ledgerSteps } from '../src/governance/op-steps.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore, UNDONE_MERGES_MAX } from '../src/governance/dreams-records.ts'
import { buildMergePrompt, conclusionOfGroup, mergeConclusion, mergeGroupId, planMerges } from '../src/governance/dreams-merge.ts'
import { tidyMemoriesStep } from '../src/tools/dreams-tidy.ts'
import { CONTENT_LENGTH_HINT } from '../src/save-signals.ts'
import { maintainStep, runDreams, type DreamsRunDeps, type DreamsStep } from '../src/tools/dreams-run.ts'
import { mergeFragmentsStep } from '../src/tools/dreams-merge.ts'
import { applyChangeset } from '../src/tools/changeset.ts'
import { mergePlan } from '../src/governance/changeset-plans.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { historyWithMerged } from '../src/merged-history.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { mergedIntoOf, type MemoryRecord } from '../src/record-schema.ts'
import type { Scope } from '../src/scope.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { interleaveRuns, interleaveSeed } from './helpers/interleave.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 记忆梦境合并零碎记忆。真文件、真操作日志、真写锁；模型是按次回复的桩。

const quiet = { info() {}, warn() {}, error() {} }
const GLOBAL = { kind: 'global' } as const
const WS = '/proj/a'
const PROJECT: Scope = { kind: 'workspace', workspacePath: WS }
const NOW = 1_800_000_000_000
const MERGE_MARK = '合并成一条'

/** 写文件失败的注入点（文件系统边界）：writeFile 写记忆文件（含临时文件）时返回真的那次抛错。 */
const fsFault = vi.hoisted(() => ({ failWrite: undefined as ((path: string, text: string) => boolean) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writeFile = (async (...args: Parameters<typeof actual.writeFile>) => {
    const [path, data] = args
    if (String(path).includes('.md') && typeof data === 'string' && fsFault.failWrite?.(String(path), data) === true) throw new Error('写盘失败')
    return actual.writeFile(...args)
  }) as typeof actual.writeFile
  return { ...actual, writeFile, default: { ...actual, writeFile } }
})

let root: string
let clock: number
let lock: ReturnType<typeof createRootLock>
let journal: OpJournal
let store: MemoryStore
let decisions: PendingDecisionsStore
let snapshots: SnapshotStore
let dreamsRecords: InMemoryKvTable<DreamsRecord>
let dreams: DreamsStore
let ratio: number
let runSeq = 0

type Reply = unknown[] | string | (() => unknown[] | string | Promise<unknown[] | string>)
let replies: Reply[] = []
let prompts: Array<{ system: string; user: string }> = []
/** 逐条整理那一步的回复（按次取，没有就是不改）；它看到的提示词记在 tidyPrompts。 */
let tidyReplies: unknown[][] = []
let tidyPrompts: string[] = []

const llm: SemanticLlm = {
  model: 'stub',
  complete: async (prompt, _signal, onUsage) => {
    if (!prompt.system.includes(MERGE_MARK)) {
      tidyPrompts.push(prompt.user)
      return JSON.stringify({ operations: tidyReplies.shift() ?? [] })
    }
    prompts.push(prompt)
    onUsage?.(10)
    const reply = replies.shift() ?? []
    const value = typeof reply === 'function' ? await reply() : reply
    return typeof value === 'string' ? value : JSON.stringify({ merges: value })
  },
}

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'pm-dreams-merge-'))
  clock = NOW
  journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
  lock = createRootLock({ root, log: quiet })
  const stats = new InMemoryBatchKvTable<RecallStats>()
  fsFault.failWrite = undefined
  decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>(), lock)
  snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  dreamsRecords = new InMemoryKvTable<DreamsRecord>()
  dreams = new DreamsStore(dreamsRecords, new InMemoryKvTable<DreamMarks>())
  store = new MemoryStore(new FileTable({ root, stats, log: quiet, lock, journal, now: () => clock }), quiet, stats)
  store.registerSteps(ledgerSteps(decisions, quiet))
  replies = []
  prompts = []
  tidyReplies = []
  tidyPrompts = []
  ratio = 1
  runSeq = 0
}
async function teardown() {
  journal.close()
  await rm(root, { recursive: true, force: true })
}
beforeEach(setup)
afterEach(teardown)

function deps(extra: DreamsStep[] = [], after: DreamsStep[] = []): DreamsRunDeps {
  const claims = new InMemoryKvTable<{ id: string }>()
  return {
    store, snapshots, decisions, dreams, log: quiet,
    claimScope: async (scope) => {
      const release = await claims.claim(scope.kind === 'global' ? 'global' : scope.workspacePath)
      return release === undefined ? { busy: scope } : { release }
    },
    activity: async () => ({ isComplete: true, workspaces: new Map() }),
    resolveLlm: async () => ({ llm, isSelected: true, fellBack: false }),
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: ratio }),
    isGovernanceEnabled: () => true,
    plan: [maintainStep(store), ...extra, mergeFragmentsStep({ store, dreams }), ...after],
    interval: () => () => {},
    now: () => NOW,
    newRunId: () => `run_${++runSeq}`,
  }
}
const dream = (scope: Scope = GLOBAL, extra: DreamsStep[] = []) => runDreams(scope, { by: 'manual' }, deps(extra))
/** 合并之后接着逐条整理的运行（和插件里的运行计划同一个顺序）。 */
const tidyStep = () => tidyMemoriesStep({ store, maxTopics: () => 30, now: () => NOW, typeRecall: () => 'search' })
const dreamThenTidy = () => runDreams(GLOBAL, { by: 'manual' }, deps([], [tidyStep()]))

const at = (r: Pick<MemoryRecord, 'workspacePath'>): Scope => (r.workspacePath === undefined ? GLOBAL : { kind: 'workspace', workspacePath: r.workspacePath })
async function seed(rows: Array<[string, string]>, extra: Partial<MemoryRecord> = {}): Promise<MemoryRecord[]> {
  const out: MemoryRecord[] = []
  for (const [id, name] of rows) {
    const rec = record({ id, name, summary: `${name}的摘要`, content: `${name}的正文`, tags: [name], createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, ...extra })
    await store.create(rec)
    out.push((await store.get(id, at(rec)))!)
  }
  await store.maintain(at(out[0]!))
  return out
}
const THREE: Array<[string, string]> = [['mem_a', '发版步骤'], ['mem_b', '发版要打 tag'], ['mem_c', '回复语言']]
const get = async (id: string, scope: Scope = GLOBAL) => (await store.get(id, scope))!
const entryOf = async (id: string) => (await decisions.listSettled()).find(d => d.id === id)
const lastResult = async (scope = 'global') => (await dreams.read()).records.get(scope)?.lastResult
const undo = (decisionId: string, op?: string) => executeUndo(
  { decisionId, ...(op !== undefined ? { op } : {}) }, { workspacePath: undefined },
  { store, decisions, snapshots, dreams, log: quiet, ignores: { unignoreIfSame: async () => false }, now: () => NOW },
)
/** 召回统计、提交标记之外的内容。 */
const stable = ({ lastWriteOp: _op, recallCount: _c, lastRecalledAt: _a, ...rest }: MemoryRecord) => rest

const FUSED = { name: '发版步骤', summary: '发版先跑全套再打 tag', tags: ['发版', 'tag'], content: '发版先跑全套测试，再打 tag。' }
const MERGE_AB = { keep: 'mem_a', merge: ['mem_b'], ...FUSED }

describe('合并', () => {
  it('留下的那条改成合并稿，其余软删并记下并进了它；回执在这次运行的批次条目上，组号带着结论身份', async () => {
    const [a, b] = await seed(THREE)
    replies = [[MERGE_AB]]
    const r = await dream()
    expect(r.kind).toBe('completed')
    expect(await get('mem_a')).toMatchObject({ ...FUSED, status: 'active', lastChange: { by: 'dreams' } })
    expect(mergedIntoOf(await get('mem_b'))).toEqual({ id: 'mem_a', scopeKey: 'global', as: 'merge' })
    expect((await get('mem_c')).status).toBe('active')
    const changes = (await entryOf('run_1'))!.changes!
    expect(changes.map(c => [c.kind, c.memoryId])).toEqual([['edit', 'mem_a'], ['forget', 'mem_b']])
    expect(changes.every(c => c.group === mergeGroupId('run_1', mergeConclusion([a!, b!])))).toBe(true)
    // 被合并的原件留了撤销快照
    const forget = changes.find(c => c.kind === 'forget')!
    expect((await snapshots.get(forget.snapshotId!))?.data.map(x => [x.id, x.content])).toEqual([['mem_b', '发版要打 tag的正文']])
  })

  it('交给模型的记忆按 JSON 给出：正文里像标题、围栏的行折在字符串里，疑似密钥遮住', async () => {
    const [a] = await seed([['mem_a', '发版步骤']])
    const tricky = { ...a!, content: `第一行\n## 像标题的一行\n\`\`\`\nkey=${FAKE_SECRET.sk}` }
    const prompt = buildMergePrompt((await store.readIndex(GLOBAL))!, new Map([[tricky.id, tricky]]), new Set([tricky.id]))
    expect(prompt.user).not.toContain(FAKE_SECRET.sk)
    expect(prompt.user).toContain('\\n## 像标题的一行\\n```')
    expect(prompt.user.split('\n')).toHaveLength(2)
  })

  it('被合并方的历史版本并到存活那条名下、记着原 id；清扫之后搬到存活那条的历史里，读出来一样', async () => {
    await seed(THREE)
    const located = (await store.locate('mem_b', GLOBAL))!
    const b = located.record
    await store.history.write(layerOf(located), { versionId: 'v-early', record: { ...b, content: '更早的说法' }, extras: {}, startedAt: NOW - 20_000, endedAt: NOW - 9_000, kind: STATE_CHANGE_VERSION, writes: [] })
    replies = [[MERGE_AB]]
    expect((await dream()).kind).toBe('completed')
    const shape = (versions: Awaited<ReturnType<typeof historyWithMerged>>) => versions.map(v => [v.mergedFrom ?? null, v.record.content])
    const before = shape(await historyWithMerged(store, (await store.locate('mem_a', GLOBAL))!))
    expect(before).toEqual([['mem_b', '更早的说法']])
    clock = NOW + RETENTION_MS + 60_000
    await store.maintain(GLOBAL)
    expect(await store.get('mem_b', GLOBAL)).toBeUndefined()
    const keeper = (await store.locate('mem_a', GLOBAL))!
    expect(shape(await store.history.list(layerOf(keeper), 'mem_a'))).toEqual(before)
  })

  it('这次运行合并过的存活那条不进后面的逐条整理；单撤这个合并组照样能撤，下次运行再整理它', async () => {
    const [a, b] = await seed(THREE)
    replies = [[MERGE_AB]]
    tidyReplies = [[{ op: 'refresh', id: 'mem_a', summary: '整理写的摘要' }, { op: 'refresh', id: 'mem_c', summary: '丙的新摘要' }]]
    expect((await dreamThenTidy()).kind).toBe('completed')
    expect(tidyPrompts).toHaveLength(1)
    expect(tidyPrompts[0]).not.toContain('"mem_a"')
    expect(await get('mem_a')).toMatchObject(FUSED)
    expect((await get('mem_c')).summary).toBe('丙的新摘要')
    const forget = (await entryOf('run_1'))!.changes!.find(c => c.kind === 'forget')!
    expect(await undo('run_1', forget.op)).toMatchObject({ kind: 'undone', restored: expect.arrayContaining(['mem_a', 'mem_b']) })
    expect(stable(await get('mem_a'))).toEqual(stable(a!))
    expect(stable(await get('mem_b'))).toEqual(stable(b!))
  })

  it('存活那条下次运行算变了、照常整理', async () => {
    await seed(THREE)
    replies = [[MERGE_AB]]
    expect((await dreamThenTidy()).kind).toBe('completed')
    tidyReplies = [[{ op: 'refresh', id: 'mem_a', summary: '下次整理的摘要' }]]
    expect((await dreamThenTidy()).kind).toBe('completed')
    expect(tidyPrompts.at(-1)).toContain('"mem_a"')
    expect((await get('mem_a')).summary).toBe('下次整理的摘要')
  })

  it('合并时存活那条原样留下（合并稿和它一模一样）：这次不整理它，下次运行照样整理它', async () => {
    const [a] = await seed(THREE)
    // 先做完一次，留下基线；之后只有乙变了
    expect((await dreamThenTidy()).kind).toBe('completed')
    await store.updateIfLive({ id: 'mem_b' }, cur => ({ ...cur, content: '发版步骤里重复的一段', updatedAt: NOW + 5 }))
    replies = [[{ keep: 'mem_a', merge: ['mem_b'], name: a!.name, summary: a!.summary, tags: a!.tags, content: a!.content }]]
    tidyPrompts = []
    expect((await dreamThenTidy()).kind).toBe('completed')
    expect((await get('mem_b')).status).toBe('deleted')
    expect(tidyPrompts.some(p => p.includes('"mem_a"'))).toBe(false)
    tidyPrompts = []
    expect((await dreamThenTidy()).kind).toBe('completed')
    expect(tidyPrompts.some(p => p.includes('"mem_a"'))).toBe(true)
  })

  it('合并名额不够、整组跳过：这两条这次照样交给逐条整理，用上剩下的名额；下次运行合并照样重试', async () => {
    await seed(THREE.slice(0, 2))
    ratio = 0.5
    replies = [[MERGE_AB]]
    tidyReplies = [[{ op: 'refresh', id: 'mem_a', summary: '逐条整理写的摘要' }]]
    expect((await dreamThenTidy()).kind).toBe('completed')
    expect((await get('mem_b')).status).toBe('active')
    expect((await get('mem_a')).summary).toBe('逐条整理写的摘要')
    expect((await lastResult())?.skipped?.items).toEqual([
      { step: 'merge-fragments', kind: 'edit', target: 'mem_a', reason: 'quota' },
      { step: 'merge-fragments', kind: 'forget', target: 'mem_b', reason: 'quota' },
    ])
    const marks = await dreams.baseline(GLOBAL, (await dreams.read()).records.get('global')?.completed?.runId)
    expect(marks.kind === 'ok' ? Object.keys(marks.marks) : undefined).toEqual([])
  })

  it('同一个 id 在全局和项目里各有一份：整理项目时只动项目那一份', async () => {
    await seed(THREE)
    const globalA = await get('mem_a')
    await seed([['mem_a', '项目里的发版'], ['mem_b', '项目里的打 tag']], { scope: 'workspace', workspacePath: WS })
    replies = [[MERGE_AB]]
    expect((await dream(PROJECT)).kind).toBe('completed')
    expect(await get('mem_a', PROJECT)).toMatchObject(FUSED)
    expect(mergedIntoOf(await get('mem_b', PROJECT))).toEqual({ id: 'mem_a', scopeKey: WS, as: 'merge' })
    expect(stable(await get('mem_a'))).toEqual(stable(globalA))
    expect((await get('mem_b')).status).toBe('active')
  })
})

describe('应用之前丢掉的组', () => {
  it('合并稿正文超过保存提示的长度：这一组不落盘，列进结果，写明是哪几条、原因是超长', async () => {
    const [a, b] = await seed(THREE)
    replies = [[{ ...MERGE_AB, content: '长'.repeat(CONTENT_LENGTH_HINT + 1) }]]
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_a'))).toEqual(stable(a!))
    expect(stable(await get('mem_b'))).toEqual(stable(b!))
    expect(await entryOf('run_1')).toBeUndefined()
    expect((await lastResult())?.skipped?.items).toEqual([{ step: 'merge-fragments', kind: 'merge', target: 'mem_a,mem_b', reason: 'too-long' }])
  })

  it('正文正好是保存提示的长度：照常合并', async () => {
    await seed(THREE)
    replies = [[{ ...MERGE_AB, content: '长'.repeat(CONTENT_LENGTH_HINT) }]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_b')).status).toBe('deleted')
  })

  it('模型给的组引用了不存在的、没给它看的 id，或者同一条出现在两组里：整组丢掉，列进结果', async () => {
    await seed(THREE)
    replies = [[
      { ...MERGE_AB, merge: ['mem_x'] },
      MERGE_AB,
      { ...MERGE_AB, keep: 'mem_c', merge: ['mem_b'] },
    ]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_b')).status).toBe('deleted')
    expect((await get('mem_c')).status).toBe('active')
    expect((await lastResult())?.skipped?.items.map(x => [x.target, x.reason])).toEqual([['mem_a,mem_x', 'unusable'], ['mem_c,mem_b', 'unusable']])
  })

  it('模型填了认不出的 id：列进结果之前遮住像密钥的值、截短过长的', async () => {
    await seed(THREE)
    const long = `mem_${'x'.repeat(500)}`
    replies = [[{ ...MERGE_AB, merge: [FAKE_SECRET.sk, long] }]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_b')).status).toBe('active')
    const [item] = (await lastResult())!.skipped!.items
    expect(item).toMatchObject({ kind: 'merge', reason: 'unusable' })
    expect(item!.target.startsWith('mem_a,')).toBe(true)
    expect(item!.target).not.toContain(FAKE_SECRET.sk)
    expect(item!.target).not.toContain(long)
    expect(item!.target.length).toBeLessThan(200)
  })

  it('整理项目时模型给的组带着全局记忆：整组丢掉，两边都不动', async () => {
    const [g] = await seed([['mem_g', '全局的发版']])
    const [p, q] = await seed([['mem_p', '项目的发版'], ['mem_q', '项目的打 tag']], { scope: 'workspace', workspacePath: WS })
    replies = [[{ ...MERGE_AB, keep: 'mem_p', merge: ['mem_g'] }]]
    expect((await dream(PROJECT)).kind).toBe('completed')
    expect(stable(await get('mem_g'))).toEqual(stable(g!))
    expect(stable(await get('mem_p', PROJECT))).toEqual(stable(p!))
    expect(stable(await get('mem_q', PROJECT))).toEqual(stable(q!))
    expect((await lastResult(WS))?.skipped?.items.map(x => [x.target, x.reason])).toEqual([['mem_p,mem_g', 'unusable']])
  })

  it('合并稿里有遮盖的占位、名称或正文为空、摘要太长：丢掉这一组', async () => {
    const [a, b] = await seed(THREE)
    const shown = new Map([[a!.id, a!], [b!.id, b!]])
    const items = [{ ...MERGE_AB, content: '登录用 [已隐藏]' }, { ...MERGE_AB, name: ' ' }, { ...MERGE_AB, content: '' }, { ...MERGE_AB, summary: '长'.repeat(121) }]
    const r = planMerges(items, shown, { undone: new Set(), maxMembers: 20 })
    expect(r.drafts).toEqual([])
    expect(r.dropped.map(d => d.reason)).toEqual(['unusable', 'unusable', 'unusable', 'unusable'])
  })
})

describe('撤销过的结论', () => {
  it('结论身份和谁留下无关；只认类型、名称、正文：这三样变了就不同，摘要、标签、档位、出处、改动性质、事实时间变了不算', async () => {
    const [a, b] = await seed(THREE)
    const key = mergeConclusion([a!, b!])
    expect(mergeConclusion([b!, a!])).toBe(key)
    for (const changed of [{ content: '变了' }, { name: '换了名字' }, { type: 'decision' }]) {
      expect(mergeConclusion([a!, { ...b!, ...changed }])).not.toBe(key)
    }
    const corroborated = { ...b!.source!, sessionId: 's2', sourceMode: 'environment-observed' as const }
    const unchangedCases: Array<Partial<MemoryRecord>> = [
      { summary: '梦境刷新的摘要', tags: ['别的'], recall: 'passive' },
      { source: corroborated, confidence: 0.95 },
      { factTime: '2026-11-01' },
      { lastChange: { kind: 'refine', at: NOW, op: 'op_x', by: 'dreams' } },
    ]
    for (const unchanged of unchangedCases) {
      expect(mergeConclusion([a!, { ...b!, ...unchanged }])).toBe(key)
    }
    expect(conclusionOfGroup(mergeGroupId('run_9', key))).toBe(key)
    expect(conclusionOfGroup('g1')).toBeUndefined()
  })

  it('撤销之后同一次运行的逐条整理刷新了存活那条的摘要和标签：之后同一组照样拦下，不再合并', async () => {
    await seed(THREE)
    replies = [[MERGE_AB]]
    await dream()
    await undo('run_1')
    // 下一次运行：合并这一步被拦下，逐条整理刷新了甲的摘要和标签（改动性质记成细化）
    replies = [[MERGE_AB]]
    tidyReplies = [[{ op: 'refresh', id: 'mem_a', summary: '整理后的摘要', tags: ['发版', '整理后'] }]]
    expect((await dreamThenTidy()).kind).toBe('completed')
    expect(await get('mem_a')).toMatchObject({ summary: '整理后的摘要', lastChange: { kind: 'refine', by: 'dreams' } })
    // 之后同一主题又有变化，模型又给出同一组：仍然拦下
    await store.updateIfLive({ id: 'mem_c' }, cur => ({ ...cur, content: '回复语言改成中文', updatedAt: NOW + 5 }))
    replies = [[MERGE_AB]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_b')).status).toBe('active')
    expect((await lastResult())?.skipped?.items).toEqual([{ step: 'merge-fragments', kind: 'merge', target: 'mem_a,mem_b', reason: 'undone-before' }])
  })

  it('整批撤销梦境的合并：两条回到原样，记下撤销过的结论；下次同样几条、内容没变就不再提，列进结果', async () => {
    const [a, b] = await seed(THREE)
    replies = [[MERGE_AB]]
    await dream()
    expect(await undo('run_1')).toMatchObject({ kind: 'undone', restored: expect.arrayContaining(['mem_a', 'mem_b']) })
    expect(stable(await get('mem_a'))).toEqual(stable(a!))
    expect(stable(await get('mem_b'))).toEqual(stable(b!))
    expect([...(await dreams.undoneMerges(GLOBAL))!]).toEqual([mergeConclusion([a!, b!])])
    // 撤销把两条改回去了：内容和上次做完时不一样，下次照样交给模型看
    replies = [[MERGE_AB]]
    expect((await dream()).kind).toBe('completed')
    expect(prompts).toHaveLength(2)
    expect((await get('mem_b')).status).toBe('active')
    expect((await lastResult())?.skipped?.items).toEqual([{ step: 'merge-fragments', kind: 'merge', target: 'mem_a,mem_b', reason: 'undone-before' }])
  })

  it('整批撤销两个合并组，后一组撤完、前一组写盘失败：撤完的那组照样记下，没撤完的不记；重试撤销后两组都记下，不重复', async () => {
    const [a, b, c, d] = await seed([['mem_a', '甲'], ['mem_b', '乙'], ['mem_c', '丙'], ['mem_d', '丁']])
    const mergeCD = { ...MERGE_AB, keep: 'mem_c', merge: ['mem_d'] }
    replies = [[MERGE_AB, mergeCD]]
    expect((await dream()).kind).toBe('completed')
    const [keyAB, keyCD] = [mergeConclusion([a!, b!]), mergeConclusion([c!, d!])]
    // 逆序撤：丙丁那组先撤完，撤到甲（写回原来的正文）时写盘失败
    fsFault.failWrite = (_path, text) => text.includes('id: mem_a') && text.includes(a!.content)
    await expect(undo('run_1')).rejects.toThrow('写盘失败')
    fsFault.failWrite = undefined
    expect(stable(await get('mem_c'))).toEqual(stable(c!))
    expect((await get('mem_d')).status).toBe('active')
    expect([...(await dreams.undoneMerges(GLOBAL))!]).toEqual([keyCD])
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect([...(await dreams.undoneMerges(GLOBAL))!].sort()).toEqual([keyAB, keyCD].sort())
    // 模型再给出丙丁这一组：拦下
    replies = [[mergeCD]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_d')).status).toBe('active')
  })

  it('单撤合并组里的一条：整组撤回，同样记下撤销过的结论', async () => {
    const [a, b] = await seed(THREE)
    replies = [[MERGE_AB]]
    await dream()
    const forget = (await entryOf('run_1'))!.changes!.find(c => c.kind === 'forget')!
    expect(await undo('run_1', forget.op)).toMatchObject({ kind: 'undone' })
    expect((await get('mem_b')).status).toBe('active')
    expect([...(await dreams.undoneMerges(GLOBAL))!]).toEqual([mergeConclusion([a!, b!])])
  })

  it('撤销过之后其中一条内容变了：有了新信息，可以再提、照常合并', async () => {
    await seed(THREE)
    replies = [[MERGE_AB]]
    await dream()
    await undo('run_1')
    await store.updateIfLive({ id: 'mem_b' }, cur => ({ ...cur, content: '打 tag 前先确认版本号', updatedAt: NOW + 5 }))
    replies = [[MERGE_AB]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_b')).status).toBe('deleted')
    expect(await get('mem_a')).toMatchObject(FUSED)
  })

  it('撤销记录读不全：这一轮不合并，运行按没做完收，下次重来', async () => {
    const [a] = await seed(THREE)
    // 运行开头读记录时还读得全，到合并这一步之前变得读不出
    const breakRecords: DreamsStep = { name: 'break', needsChanges: false, run: async () => { dreamsRecords.isComplete = false } }
    replies = [[MERGE_AB]]
    expect((await dream(GLOBAL, [breakRecords])).kind).toBe('failed')
    expect(prompts).toHaveLength(0)
    expect(stable(await get('mem_a'))).toEqual(stable(a!))
  })

  it('撤销记录记不下（侧表写不进）：撤销照样算成', async () => {
    await seed(THREE)
    replies = [[MERGE_AB]]
    await dream()
    dreamsRecords.update = async () => { throw new Error('磁盘满了') }
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect((await get('mem_b')).status).toBe('active')
  })

  it('撤销过的结论每个范围最多留最近的若干个，同一个再记一次挪到最后；运行记录的其他内容不动', async () => {
    await dreams.setEnabled(GLOBAL, true)
    await dreams.noteUndoneMerges(GLOBAL, ['k0', 'k1'], NOW)
    await dreams.noteUndoneMerges(GLOBAL, ['k0'], NOW + 1)
    expect([...(await dreams.undoneMerges(GLOBAL))!]).toEqual(['k1', 'k0'])
    await dreams.noteUndoneMerges(GLOBAL, Array.from({ length: UNDONE_MERGES_MAX }, (_, i) => `n${i}`), NOW + 2)
    const kept = [...(await dreams.undoneMerges(GLOBAL))!]
    expect(kept).toHaveLength(UNDONE_MERGES_MAX)
    expect(kept[0]).toBe('n0')
    expect((await dreams.read()).settings.get('global')).toBe(true)
    expect([...(await dreams.undoneMerges(PROJECT))!]).toEqual([])
  })

  it('界面里「整理所选」的合并撤销：不记成梦境撤销过的结论', async () => {
    const [a, b] = await seed(THREE)
    await decisions.addChangeRun('pd_ui', { kind: 'edit', summary: '整理所选', workspaces: ['global'], memoryIds: [] }, 'batch-edited', NOW)
    await applyChangeset(mergePlan({ group: 'g1', keeper: a!, merged: [b!], fused: FUSED }), { entryId: 'pd_ui', by: 'gui', at: NOW, isSecretChecked: false }, { store, snapshots, decisions })
    await decisions.finishChangeRun('pd_ui', { writes: [] })
    expect(await undo('pd_ui')).toMatchObject({ kind: 'undone' })
    expect([...(await dreams.undoneMerges(GLOBAL))!]).toEqual([])
  })
})

describe('落盘前的核对', () => {
  it('组里有一条锁着：整组跳过，什么都不写，原因是锁定', async () => {
    await seed(THREE)
    await store.updateIfLive({ id: 'mem_b' }, cur => ({ ...cur, locked: true }))
    const [a, b] = [await get('mem_a'), await get('mem_b')]
    replies = [[MERGE_AB]]
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_a'))).toEqual(stable(a))
    expect(stable(await get('mem_b'))).toEqual(stable(b))
    expect((await lastResult())?.skipped?.items).toContainEqual({ step: 'merge-fragments', kind: 'forget', target: 'mem_b', reason: 'locked' })
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('存活那条锁着、模型给的合并稿和它一模一样：整组跳过，被合并方不删，原因是锁定', async () => {
    await seed(THREE)
    await store.updateIfLive({ id: 'mem_a' }, cur => ({ ...cur, locked: true }))
    const [a, b] = [await get('mem_a'), await get('mem_b')]
    replies = [[{ keep: 'mem_a', merge: ['mem_b'], name: a.name, summary: a.summary, tags: a.tags, content: a.content }]]
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_b'))).toEqual(stable(b))
    expect((await lastResult())?.skipped?.items).toContainEqual({ step: 'merge-fragments', kind: 'edit', target: 'mem_a', reason: 'locked' })
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('调模型期间前台改了其中一条：整组跳过，前台的改动留着', async () => {
    const [a] = await seed(THREE)
    replies = [async () => {
      await store.updateIfLive({ id: 'mem_b' }, cur => ({ ...cur, content: '前台刚改的正文', updatedAt: NOW + 5 }))
      return [MERGE_AB]
    }]
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_a'))).toEqual(stable(a!))
    expect(await get('mem_b')).toMatchObject({ status: 'active', content: '前台刚改的正文' })
    expect((await lastResult())?.skipped?.items).toEqual([
      { step: 'merge-fragments', kind: 'edit', target: 'mem_a', reason: 'basis-changed' },
      { step: 'merge-fragments', kind: 'forget', target: 'mem_b', reason: 'group' },
    ])
  })

  it.each([
    ['类型', { type: 'decision' }],
    ['标签', { tags: ['前台加的标签'] }],
  ] as Array<[string, Partial<MemoryRecord>]>)('调模型期间前台只改了被合并方的%s：整组跳过，被合并方不删', async (_label, change) => {
    const [a] = await seed(THREE)
    replies = [async () => {
      await store.updateIfLive({ id: 'mem_b' }, cur => ({ ...cur, ...change }))
      return [MERGE_AB]
    }]
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_a'))).toEqual(stable(a!))
    expect(await get('mem_b')).toMatchObject({ status: 'active', ...change })
    expect((await lastResult())?.skipped?.items).toContainEqual({ step: 'merge-fragments', kind: 'edit', target: 'mem_a', reason: 'basis-changed' })
  })

  it('合并稿带进原记忆没有的疑似密钥：整组不做；两条原记忆里已有的照常合并', async () => {
    await seed(THREE)
    replies = [[{ ...MERGE_AB, content: `发版用 ${FAKE_SECRET.sk} 登录` }]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_b')).status).toBe('active')
    expect((await lastResult())?.skipped?.items).toContainEqual({ step: 'merge-fragments', kind: 'edit', target: 'mem_a', reason: 'foreign-secret' })
  })

  it('存活那条带着用户确认过的疑似密钥：整组跳过，正文不变、被合并方不删，列进结果', async () => {
    await seed(THREE)
    await store.updateIfLive({ id: 'mem_a' }, cur => ({ ...cur, content: `发版用 ${FAKE_SECRET.sk} 登录` }))
    const [a, b] = [await get('mem_a'), await get('mem_b')]
    replies = [[MERGE_AB]]
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_a'))).toEqual(stable(a))
    expect(stable(await get('mem_b'))).toEqual(stable(b))
    expect((await lastResult())?.skipped?.items).toEqual([{ step: 'merge-fragments', kind: 'merge', target: 'mem_a,mem_b', reason: 'has-secret' }])
  })

  it('改动量上限：一组的几条放不下就整组跳过，没处理到的下次仍算变了', async () => {
    await seed(Array.from({ length: 4 }, (_, i) => [`mem_${i}`, `记忆${i}`] as [string, string]))
    ratio = 0.25
    replies = [[{ ...MERGE_AB, keep: 'mem_0', merge: ['mem_1'] }]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_1')).status).toBe('active')
    expect((await lastResult())?.skipped?.items).toEqual([
      { step: 'merge-fragments', kind: 'edit', target: 'mem_0', reason: 'quota' },
      { step: 'merge-fragments', kind: 'forget', target: 'mem_1', reason: 'quota' },
    ])
    const marks = await dreams.baseline(GLOBAL, (await dreams.read()).records.get('global')?.completed?.runId)
    expect(marks.kind === 'ok' ? Object.keys(marks.marks).sort() : undefined).toEqual(['mem_2', 'mem_3'])
  })
})

describe('中断', () => {
  /** 被合并方软删时写进最近删除的那个文件（文件系统边界）。 */
  const isForgetWrite = (text: string) => text.includes('id: mem_b') && text.includes('status: deleted')

  it('合并做到一半、撤回也写不进去：回执留着可撤，运行按出错收；下次运行开头先撤干净', async () => {
    const [a, b] = await seed(THREE)
    // 软删被合并方这一步写盘失败，撤回存活方（写回原来的正文）这一步也写盘失败：存活方停在合并稿
    fsFault.failWrite = (_path, text) => isForgetWrite(text) || (text.includes('id: mem_a') && text.includes(a!.content))
    replies = [[MERGE_AB]]
    expect((await dream()).kind).toBe('failed')
    expect((await get('mem_a')).content).toBe(FUSED.content)
    expect((await decisions.withOpenGroups()).map(e => e.id)).toEqual(['run_1'])
    expect((await entryOf('run_1'))?.changes?.map(c => c.memoryId)).toEqual(['mem_a'])
    fsFault.failWrite = undefined
    replies = []
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_a'))).toEqual(stable(a!))
    expect(stable(await get('mem_b'))).toEqual(stable(b!))
    expect(await decisions.withOpenGroups()).toEqual([])
  })

  it('两步之间进程退出：组的标记和第一步留在条目上；下次运行开头先撤干净，条目移出账本', async () => {
    const [a, b] = await seed(THREE)
    // 第一步写完、第二步写盘时进程退出：从这一刻起记忆文件一个都写不进去（第二步、撤回第一步都没发生）
    let isGone = false
    fsFault.failWrite = (_path, text) => {
      if (isForgetWrite(text)) isGone = true
      return isGone
    }
    replies = [[MERGE_AB]]
    expect((await dream()).kind).toBe('failed')
    fsFault.failWrite = undefined
    expect((await get('mem_a')).content).toBe(FUSED.content)
    expect((await decisions.withOpenGroups()).map(e => e.openGroups)).toEqual([[mergeGroupId('run_1', mergeConclusion([a!, b!]))]])
    replies = []
    expect((await dream()).kind).toBe('completed')
    expect(stable(await get('mem_a'))).toEqual(stable(a!))
    expect(stable(await get('mem_b'))).toEqual(stable(b!))
    expect(await decisions.withOpenGroups()).toEqual([])
    expect(await entryOf('run_1')).toBeUndefined()
  })
})

describe('前台改动落在随机时刻', () => {
  // 种子：缺省固定（helpers/interleave.ts），PM_INTERLEAVE_SEED 覆盖；轮数缺省 60，PM_INTERLEAVE_RUNS 覆盖
  const RUNS = interleaveRuns(60)
  it('前台在梦境的某个写入段之前改一条或给一条上锁：合并整组要么做成要么不做，前台写成的改动不丢，不留半个组', async () => {
    await teardown()
    try {
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }), fc.constantFrom('mem_a', 'mem_b', 'mem_c'), fc.constantFrom('edit', 'lock'),
        async (at, target, action) => {
          await setup()
          try {
            await seed(THREE)
            await store.updateIfLive({ id: 'mem_c' }, cur => ({ ...cur, content: '发版之后发公告的正文' }))
            const original = new Map(await Promise.all(['mem_a', 'mem_b', 'mem_c'].map(async id => [id, await get(id)] as const)))
            // 第 at 个最外层写入段开始之前，前台做一次改动（不在梦境的写入段里）
            const section = store.writeSection.bind(store)
            let depth = 0
            let count = 0
            let landed = false
            // 前台改动落在模型读到这几条之后：合并的依据是旧内容，不能盖掉前台的改动
            let isAfterRead = false
            // 上锁时写下的那一版：之后梦境不再动它
            let lockedAs: MemoryRecord | undefined
            store.writeSection = async <T>(fn: () => Promise<T>): Promise<T> => {
              if (depth === 0 && count++ === at) {
                isAfterRead = prompts.length > 0
                const written = await store.updateIfLive({ id: target }, cur => (action === 'edit' ? { ...cur, content: `前台改的${target}`, updatedAt: NOW + 5 } : { ...cur, locked: true }))
                landed = written !== undefined
                lockedAs = action === 'lock' ? written : undefined
              }
              depth++
              try { return await section(fn) } finally { depth-- }
            }
            replies = [[{ ...MERGE_AB, merge: ['mem_b', 'mem_c'] }]]
            await dream()
            store.writeSection = section
            const [a, b, c] = [await get('mem_a'), await get('mem_b'), await get('mem_c')]
            const front = (r: MemoryRecord) => landed && action === 'edit' && r.id === target
            const isMerged = b.status === 'deleted' || c.status === 'deleted'
            if (isMerged) {
              // 做成了：被合并的两条都软删、并进存活那条；存活那条是合并稿，或之后前台又改过
              expect([b.status, c.status]).toEqual(['deleted', 'deleted'])
              expect([mergedIntoOf(b)?.id, mergedIntoOf(c)?.id]).toEqual(['mem_a', 'mem_a'])
              expect(a.status).toBe('active')
              if (!front(a)) expect(a.content).toBe(FUSED.content)
            } else {
              // 没做成：几条都在用，内容是原样或前台改过的样子
              for (const r of [a, b, c]) {
                expect(r.status).toBe('active')
                if (!front(r)) expect(r.content).toBe(original.get(r.id)!.content)
              }
            }
            // 模型读过之后前台写成的改动不被盖掉；被合并方已软删时前台写不成（landed 为假）
            if (landed && isAfterRead && action === 'edit') expect((await get(target)).content).toBe(`前台改的${target}`)
            // 上锁之后梦境不再改这一条（之前写下的合并照旧，撤回只改回它自己写的字段）
            if (lockedAs !== undefined) expect(stable(await get(target))).toEqual(stable(lockedAs))
            expect(await decisions.withOpenGroups()).toEqual([])
          } finally {
            await teardown()
          }
        },
      ), { seed: interleaveSeed(), numRuns: RUNS })
    } finally {
      await setup()
    }
  }, Math.max(60_000, RUNS * 2_000))
})
