import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import type { DreamMarks, DreamsRecord, RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { ledgerSteps } from '../src/governance/op-steps.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { DREAMS_DEFAULTS } from '../src/governance/dreams-gate.ts'
import { DreamsStore } from '../src/governance/dreams-records.ts'
import { buildTidyPrompt, parseTidyOutput } from '../src/governance/dreams-tidy.ts'
import { basisOf } from '../src/governance/changeset.ts'
import { countDreamChanges, maintainStep, runDreams, type DreamsRunDeps } from '../src/tools/dreams-run.ts'
import { organizeIndexStep, tidyMemoriesStep } from '../src/tools/dreams-tidy.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { UNSORTED_TITLE, readIndex } from '../src/topic-index.ts'
import type { MemoryRecord, RecallTier } from '../src/record-schema.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 记忆梦境的整理：整理主题索引、逐条整理记忆。真文件、真操作日志、真写锁；模型是按提示词种类依次回复的桩。

const quiet = { info() {}, warn() {}, error() {} }
const GLOBAL = { kind: 'global' } as const
const NOW = 1_800_000_000_000
const ORGANIZE_MARK = '长期记忆索引'

let root: string
/** 写文件失败的注入点（文件系统边界）：返回真的那次写抛错。 */
let failWrite: ((path: string, text: string) => boolean) | undefined
class FaultyFileTable extends FileTable {
  protected override async atomicWrite(filePath: string, text: string): Promise<void> {
    if (failWrite?.(filePath, text) === true) throw new Error('写盘失败')
    await super.atomicWrite(filePath, text)
  }
}
/** 账本写入失败的注入点（键值表边界）：返回真的那次写抛错。 */
let failLedgerPut: ((value: PendingDecision) => boolean) | undefined
class FaultyLedger extends InMemoryKvTable<PendingDecision> {
  override async put(id: string, value: PendingDecision): Promise<void> {
    if (failLedgerPut?.(value) === true) throw new Error('磁盘满了')
    return super.put(id, value)
  }
}
let lock: ReturnType<typeof createRootLock>
let stats: InMemoryBatchKvTable<RecallStats>
let journal: OpJournal
let store: MemoryStore
let decisions: PendingDecisionsStore
let snapshots: SnapshotStore
let dreams: DreamsStore
let lose: (() => void) | undefined
let ratio: number
let runSeq = 0

type Reply = unknown[] | string | Error | (() => unknown[] | string | Promise<unknown[] | string>)
const replies: { organize: Reply[]; tidy: Reply[] } = { organize: [], tidy: [] }
const prompts: { organize: Array<{ system: string; user: string }>; tidy: Array<{ system: string; user: string }> } = { organize: [], tidy: [] }
const signals: Array<AbortSignal | undefined> = []

const llm: SemanticLlm = {
  model: 'stub',
  complete: async (prompt, signal, onUsage) => {
    const kind = prompt.system.includes(ORGANIZE_MARK) ? 'organize' : 'tidy'
    prompts[kind].push(prompt)
    signals.push(signal)
    onUsage?.(10)
    const reply = replies[kind].shift() ?? []
    const value = typeof reply === 'function' ? await reply() : reply
    if (value instanceof Error) throw value
    return typeof value === 'string' ? value : JSON.stringify({ operations: value })
  },
}

/** 换一个存储实例（同一个目录、同一个操作日志），像进程重启之后：补做的失败次数重新算。 */
function openStore() {
  store = new MemoryStore(new FaultyFileTable({ root, stats, log: quiet, lock, journal, now: () => NOW }), quiet, stats)
  store.registerSteps(ledgerSteps(decisions, quiet))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-dreams-tidy-'))
  journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
  lock = createRootLock({ root, log: quiet })
  stats = new InMemoryBatchKvTable<RecallStats>()
  failWrite = undefined
  failLedgerPut = undefined
  decisions = new PendingDecisionsStore(new FaultyLedger(), lock)
  snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
  dreams = new DreamsStore(new InMemoryKvTable<DreamsRecord>(), new InMemoryKvTable<DreamMarks>())
  openStore()
  replies.organize = []
  replies.tidy = []
  prompts.organize = []
  prompts.tidy = []
  signals.length = 0
  lose = undefined
  ratio = 1
  runSeq = 0
})
afterEach(async () => {
  journal.close()
  await rm(root, { recursive: true, force: true })
})

/** 类型默认的注入档位：用例里的记忆都是 knowledge，默认 search。 */
const typeRecall = (): RecallTier => 'search'

function deps(): DreamsRunDeps {
  const claims = new InMemoryKvTable<{ id: string }>()
  const stepDeps = { store, maxTopics: () => 30, now: () => NOW, typeRecall }
  return {
    store, snapshots, decisions, dreams, log: quiet,
    claimScope: async (scope, onLost) => {
      const release = await claims.claim(scope.kind)
      if (release === undefined) return { busy: scope }
      lose = onLost
      return { release }
    },
    activity: async () => ({ isComplete: true, workspaces: new Map() }),
    resolveLlm: async () => ({ llm, isSelected: true, fellBack: false }),
    config: () => ({ ...DREAMS_DEFAULTS, minChanges: 0, maxChangeRatio: ratio }),
    isGovernanceEnabled: () => true,
    plan: [maintainStep(store), organizeIndexStep(stepDeps), tidyMemoriesStep(stepDeps)],
    interval: () => () => {},
    now: () => NOW,
    newRunId: () => `run_${++runSeq}`,
  }
}
const dream = (signal?: AbortSignal) => runDreams(GLOBAL, { by: 'manual', ...(signal !== undefined ? { signal } : {}) }, deps())

async function seed(names: Array<[string, string]>, extra: Partial<MemoryRecord> = {}) {
  for (const [id, name] of names) {
    await store.create(record({ id, name, summary: `${name}的摘要`, content: `${name}的正文`, createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, ...extra }))
  }
  await store.maintain(GLOBAL)
}
const FOUR: Array<[string, string]> = [['mem_a', '发版步骤'], ['mem_b', '打 tag'], ['mem_c', '回复语言'], ['mem_d', '写锁设计']]
/** 刚铺好的四条都在「未整理」，按名称排。 */
const allUnsorted = { [UNSORTED_TITLE]: ['mem_d', 'mem_a', 'mem_c', 'mem_b'] }
const get = async (id: string) => (await store.get(id, {}))!
const layout = async () => {
  const { topics, unsorted } = readIndex((await store.readIndex(GLOBAL))!)
  return Object.fromEntries([...topics.map(t => [t.name, t.memberIds] as const), [UNSORTED_TITLE, unsorted]])
}
const entryOf = async (id: string) => (await decisions.listSettled()).find(d => d.id === id)
const undo = (decisionId: string, op?: string) =>
  executeUndo({ decisionId, ...(op !== undefined ? { op } : {}) }, { workspacePath: undefined }, { store, decisions, snapshots, ignores: { unignoreIfSame: async () => false }, now: () => NOW })
const lastResult = async () => (await dreams.read()).records.get('global')?.lastResult
const marksOf = async () => {
  const b = await dreams.baseline(GLOBAL, (await dreams.read()).records.get('global')?.completed?.runId)
  return b.kind === 'ok' ? b.marks : undefined
}

const ASSIGN = [
  { op: 'assign', memoryIds: ['mem_a', 'mem_b'], from: UNSORTED_TITLE, to: '发版', about: '发版、打 tag 的步骤。' },
  { op: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '约定', about: '协作上的约定。' },
]
const TIDY = [
  { op: 'refresh', id: 'mem_a', summary: '发版前先跑全套\n再打 tag', tags: ['发版', 'release'] },
  { op: 'relate', id: 'mem_a', related: ['mem_b'] },
  { op: 'recall', id: 'mem_c', recall: 'passive' },
  { op: 'recall', id: 'mem_d', recall: 'always' },
]

describe('归主题与直接处理', () => {
  it('未整理的归进主题，刷新摘要和标签、建关联、调注入档位，直接生效；回执记在这次运行的批次条目上', async () => {
    await seed(FOUR)
    replies.organize = [ASSIGN]
    replies.tidy = [TIDY]
    const r = await dream()
    expect(r).toMatchObject({ kind: 'completed', entryId: 'run_1', usageTokens: 20 })
    expect(r.steps.map(s => s.state)).toEqual(['done', 'done', 'done'])
    expect(await layout()).toEqual({ 发版: ['mem_a', 'mem_b'], 约定: ['mem_c'], [UNSORTED_TITLE]: ['mem_d'] })
    const a = await get('mem_a')
    // 新摘要折成一行
    expect(a).toMatchObject({ summary: '发版前先跑全套 再打 tag', tags: ['发版', 'release'], related: ['mem_b'], lastChange: { by: 'dreams' } })
    expect((await get('mem_c')).recall).toBe('passive')
    // 不认识的档位不做
    expect((await get('mem_d')).recall).toBeUndefined()
    const entry = (await entryOf('run_1'))!
    expect(entry.kind).toBe('brewing-dreams-run')
    expect(entry.indexRun?.receipts.map(x => [x.plan.kind, x.isConfirmed])).toEqual([['assign', true], ['assign', true]])
    expect(entry.changes?.map(x => [x.memoryId, x.kind])).toEqual([['mem_a', 'edit'], ['mem_a', 'link'], ['mem_c', 'set-recall']])
  })

  it('交给模型的记忆按 JSON 给出，正文里的疑似密钥遮住；模型写回的摘要同样遮住', async () => {
    await seed([['mem_a', '发版步骤']])
    const a = { ...(await get('mem_a')), content: `第一行\n## 像标题的一行\nkey=${FAKE_SECRET.sk}` }
    const read = new Map([[a.id, a]])
    const prompt = buildTidyPrompt((await store.readIndex(GLOBAL))!, read, new Set([a.id]), typeRecall)
    expect(prompt.user).not.toContain(FAKE_SECRET.sk)
    expect(prompt.user).toContain('\\n## 像标题的一行')
    let n = 0
    const parsed = parseTidyOutput(JSON.stringify({ operations: [{ op: 'refresh', id: 'mem_a', summary: `用 ${FAKE_SECRET.sk} 登录` }] }), read, () => `op${++n}`, { typeRecall, maxOpsPerMemory: 20 })!
    expect(JSON.stringify(parsed.ops)).not.toContain(FAKE_SECRET.sk)
  })

  it('模型给的主题名不合规：这一个操作跳过并列进结果，其余照做', async () => {
    await seed(FOUR)
    replies.organize = [[{ op: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '# 坏名字\n第二行' }, ASSIGN[1]]]
    const r = await dream()
    expect(r.kind).toBe('completed')
    expect(await layout()).toMatchObject({ 约定: ['mem_c'] })
    expect((await lastResult())?.skipped?.items).toEqual([expect.objectContaining({ step: 'organize-index', kind: 'assign', reason: expect.any(String) })])
  })
})

describe('模型给的操作', () => {
  it('整理主题时，模型对没给它看过的记忆提的归组丢掉，列进结果', async () => {
    await seed(FOUR)
    await store.applyIndexOp(GLOBAL, { kind: 'assign', from: UNSORTED_TITLE, to: '已有主题', memoryIds: ['mem_b'] }, { maxTopics: 30 })
    // 第一轮只看主题目录，没有成员
    replies.organize = [[{ op: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '错的主题' }]]
    expect((await dream()).kind).toBe('completed')
    expect(prompts.organize[0]!.user).not.toContain('mem_a')
    expect(await layout()).not.toHaveProperty('错的主题')
    expect((await lastResult())?.skipped?.items).toContainEqual({ step: 'organize-index', kind: 'operation', target: '', reason: 'unusable' })
  })

  it('逐条整理时模型给的值不能用的操作：丢掉，列进结果；其余照做', async () => {
    await seed(FOUR)
    replies.tidy = [[{ op: 'refresh', id: 'mem_x', summary: '没有这条' }, { op: 'recall', id: 'mem_c', recall: 'core' }, { op: 'refresh', id: 'mem_a', summary: '甲的新摘要' }]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_a')).summary).toBe('甲的新摘要')
    expect((await lastResult())?.skipped).toEqual({
      items: [{ step: 'tidy-memories', kind: 'refresh', target: 'mem_x', reason: 'unusable' }, { step: 'tidy-memories', kind: 'recall', target: 'mem_c', reason: 'unusable' }],
      total: 2,
    })
  })

  it('同一条记忆给了 21 个操作：多出来的一个丢掉，别的记忆的操作照做，运行照常做完', async () => {
    await seed(FOUR)
    replies.tidy = [[...Array.from({ length: 21 }, (_, i) => ({ op: 'refresh', id: 'mem_a', summary: `新摘要${i}` })), { op: 'recall', id: 'mem_b', recall: 'passive' }]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_a')).summary).toBe('新摘要19')
    expect((await get('mem_b')).recall).toBe('passive')
    expect((await lastResult())?.skipped?.items).toEqual([{ step: 'tidy-memories', kind: 'refresh', target: 'mem_a', reason: 'unusable' }])
  })

  it('调模型带着这次运行的取消信号', async () => {
    await seed(FOUR)
    const controller = new AbortController()
    await dream(controller.signal)
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every(x => x === controller.signal)).toBe(true)
  })
})

describe('锁与前台改动', () => {
  it('梦境调模型期间用户给目标上了锁：落盘时跳过这一项，列进结果；其余照做', async () => {
    await seed(FOUR)
    replies.tidy = [async () => {
      await store.updateIfLive({ id: 'mem_a' }, cur => ({ ...cur, locked: true }))
      return [{ op: 'refresh', id: 'mem_a', summary: '梦境写的甲' }, { op: 'refresh', id: 'mem_b', summary: '梦境写的乙' }]
    }]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_a')).summary).toBe('发版步骤的摘要')
    expect((await get('mem_b')).summary).toBe('梦境写的乙')
    expect((await lastResult())?.skipped?.items).toEqual([{ step: 'tidy-memories', kind: 'edit', target: 'mem_a', reason: 'locked' }])
  })

  it('锁定的记忆：内容不改，它在索引里的行照样能归到主题（锁只管记忆文件）', async () => {
    await seed([['mem_a', '发版步骤']], { locked: true })
    replies.organize = [[{ op: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '发版', about: '发版的步骤。' }]]
    replies.tidy = [[{ op: 'refresh', id: 'mem_a', summary: '改不了' }]]
    expect((await dream()).kind).toBe('completed')
    expect(await layout()).toMatchObject({ 发版: ['mem_a'] })
    expect((await get('mem_a')).summary).toBe('发版步骤的摘要')
  })

  it('整理主题期间前台改了这条记忆：按旧内容给的归组跳过，列进结果', async () => {
    await seed(FOUR)
    replies.organize = [async () => {
      await store.updateIfLive({ id: 'mem_a' }, cur => ({ ...cur, content: '现在记的是数据库故障', summary: '数据库故障处理', updatedAt: NOW + 5 }))
      return [{ op: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '发版', about: '发版的步骤。' }, ASSIGN[1]]
    }]
    expect((await dream()).kind).toBe('completed')
    expect(await layout()).toEqual({ 约定: ['mem_c'], [UNSORTED_TITLE]: ['mem_d', 'mem_a', 'mem_b'] })
    expect((await lastResult())?.skipped?.items).toContainEqual({ step: 'organize-index', kind: 'assign', target: '发版', reason: 'basis-changed' })
  })

  it('梦境调模型期间前台改了这一条：依据对不上，跳过', async () => {
    await seed(FOUR)
    replies.tidy = [async () => {
      await store.updateIfLive({ id: 'mem_a' }, cur => ({ ...cur, content: '前台刚改的正文', updatedAt: NOW + 5 }))
      return [{ op: 'refresh', id: 'mem_a', summary: '按旧正文写的摘要' }]
    }]
    expect((await dream()).kind).toBe('completed')
    expect(await get('mem_a')).toMatchObject({ content: '前台刚改的正文', summary: '发版步骤的摘要' })
    expect((await lastResult())?.skipped?.items).toEqual([{ step: 'tidy-memories', kind: 'edit', target: 'mem_a', reason: 'basis-changed' }])
  })
})

describe('改动量上限', () => {
  it('名额按改了的记忆算（10 条、0.2 是 2 条）：只挪索引行的不算，同一条做几个操作只算一条，超出的跳过', async () => {
    await seed(Array.from({ length: 10 }, (_, i) => [`mem_${i}`, `记忆${i}`] as [string, string]))
    ratio = 0.2
    replies.organize = [[
      { op: 'assign', memoryIds: ['mem_0'], from: UNSORTED_TITLE, to: '甲', about: '甲的事。' },
      { op: 'assign', memoryIds: ['mem_1', 'mem_2'], from: UNSORTED_TITLE, to: '乙', about: '乙的事。' },
    ]]
    replies.tidy = [[
      { op: 'refresh', id: 'mem_0', summary: '零的新摘要' },
      { op: 'recall', id: 'mem_0', recall: 'passive' },
      { op: 'refresh', id: 'mem_3', summary: '三的新摘要' },
      { op: 'refresh', id: 'mem_4', summary: '四的新摘要' },
    ]]
    expect((await dream()).kind).toBe('completed')
    expect(await layout()).toMatchObject({ 甲: ['mem_0'], 乙: ['mem_1', 'mem_2'] })
    expect((await get('mem_0')).summary).toBe('零的新摘要')
    expect((await get('mem_0')).recall).toBe('passive')
    expect((await get('mem_3')).summary).toBe('三的新摘要')
    expect((await get('mem_4')).summary).toBe('记忆4的摘要')
    expect((await lastResult())?.skipped?.items.map(x => [x.step, x.target, x.reason])).toEqual([['tidy-memories', 'mem_4', 'quota']])
  })
})

describe('改动量上限：没做完的留给下次', () => {
  it('名额用完：没整理成的不进这次的基线；下次运行算它们变了，接着整理，已整理过的不再交给模型', async () => {
    await seed(Array.from({ length: 10 }, (_, i) => [`mem_${i}`, `记忆${i}`] as [string, string]))
    ratio = 0.2
    replies.tidy = [Array.from({ length: 10 }, (_, i) => ({ op: 'refresh', id: `mem_${i}`, summary: `第一次的${i}` }))]
    expect((await dream()).kind).toBe('completed')
    expect([(await get('mem_0')).summary, (await get('mem_1')).summary, (await get('mem_2')).summary]).toEqual(['第一次的0', '第一次的1', '记忆2的摘要'])
    expect(Object.keys((await marksOf())!).sort()).toEqual(['mem_0', 'mem_1'])
    expect(await countDreamChanges({ store, dreams }, GLOBAL, 'run_1')).toBe(8)
    replies.tidy = [[{ op: 'refresh', id: 'mem_2', summary: '第二次的2' }, { op: 'refresh', id: 'mem_3', summary: '第二次的3' }]]
    const second = await runDreams(GLOBAL, { by: 'manual' }, deps())
    expect(second.kind).toBe('completed')
    expect(prompts.tidy).toHaveLength(2)
    expect(prompts.tidy[1]!.user).not.toMatch(/"mem_[01]"/)
    expect(prompts.tidy[1]!.user).toContain('"mem_9"')
    expect([(await get('mem_2')).summary, (await get('mem_3')).summary]).toEqual(['第二次的2', '第二次的3'])
  })

  it('上一次做完之后变了的才交给模型', async () => {
    await seed(FOUR)
    expect((await dream()).kind).toBe('completed')
    await store.updateIfLive({ id: 'mem_c' }, cur => ({ ...cur, content: '回复语言改了', updatedAt: NOW + 5 }))
    expect((await dream()).kind).toBe('completed')
    expect(prompts.tidy).toHaveLength(2)
    expect(prompts.tidy[1]!.user).toContain('"mem_c"')
    expect(prompts.tidy[1]!.user).not.toMatch(/"mem_[abd]"/)
  })

  it('只有一条：归主题不占名额，这一条的摘要照样刷新', async () => {
    await seed([['mem_a', '名称']])
    replies.organize = [[{ op: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '主题', about: '主题的说明。' }]]
    replies.tidy = [[{ op: 'refresh', id: 'mem_a', summary: '按正文刷新' }]]
    expect((await dream()).kind).toBe('completed')
    expect(await layout()).toMatchObject({ 主题: ['mem_a'] })
    expect((await get('mem_a')).summary).toBe('按正文刷新')
  })

  it('索引的合并挪动的成员比名额多：照样合并，不占名额，逐条整理还有名额', async () => {
    await seed(FOUR)
    await store.applyIndexOp(GLOBAL, { kind: 'assign', from: UNSORTED_TITLE, to: '甲', memoryIds: ['mem_a'] }, { maxTopics: 30 })
    await store.applyIndexOp(GLOBAL, { kind: 'assign', from: UNSORTED_TITLE, to: '乙', memoryIds: ['mem_b', 'mem_c'] }, { maxTopics: 30 })
    ratio = 0.25
    replies.organize = [[{ op: 'merge', from: ['乙'], into: '甲' }]]
    replies.tidy = [[{ op: 'refresh', id: 'mem_d', summary: '丁的新摘要' }]]
    expect((await dream()).kind).toBe('completed')
    expect(await layout()).toMatchObject({ 甲: ['mem_a', 'mem_b', 'mem_c'] })
    expect((await get('mem_d')).summary).toBe('丁的新摘要')
    expect((await lastResult())?.skipped).toBeUndefined()
  })

  it('上次没做完已用光名额：续跑照样把未整理的归进主题', async () => {
    await seed(FOUR)
    ratio = 0.5
    failWrite = (path, text) => path.endsWith('.md') && text.includes('id: mem_b') && text.includes('写不进去')
    replies.tidy = [[{ op: 'refresh', id: 'mem_a', summary: '占掉一个名额' }, { op: 'refresh', id: 'mem_b', summary: '写不进去' }]]
    expect((await dream()).kind).toBe('failed')
    expect((await dreams.read()).records.get('global')?.unfinished?.quotaUsed).toBe(1)
    failWrite = undefined
    // 续跑时上限是 1 条，上次用掉的 1 条接着扣：名额已用光
    ratio = 0.25
    replies.organize = [ASSIGN]
    expect((await dream()).kind).toBe('completed')
    expect(await layout()).toEqual({ 发版: ['mem_a', 'mem_b'], 约定: ['mem_c'], [UNSORTED_TITLE]: ['mem_d'] })
  })

  it('运行没做完时记下的已用名额不含只挪了索引行的记忆', async () => {
    await seed(FOUR)
    // 逐条整理的写入都失败：这次运行按出错收，已用名额只按写成的记忆算
    failWrite = (path, text) => path.endsWith('.md') && text.includes('写不进去')
    replies.organize = [ASSIGN]
    replies.tidy = [FOUR.map(([id]) => ({ op: 'refresh', id, summary: '写不进去' }))]
    expect((await dream()).kind).toBe('failed')
    expect(await layout()).toEqual({ 发版: ['mem_a', 'mem_b'], 约定: ['mem_c'], [UNSORTED_TITLE]: ['mem_d'] })
    expect((await dreams.read()).records.get('global')?.unfinished?.quotaUsed).toBeUndefined()
  })

  it('一次应用里前面的写成、后面的写盘抛错：前面的照样占名额，续跑接着扣', async () => {
    await seed(FOUR)
    ratio = 0.5
    failWrite = (path, text) => path.endsWith('.md') && text.includes('id: mem_b') && text.includes('第二项写入')
    replies.tidy = [[{ op: 'refresh', id: 'mem_a', summary: '第一项已写入' }, { op: 'refresh', id: 'mem_b', summary: '第二项写入' }]]
    expect((await dream()).kind).toBe('failed')
    expect((await get('mem_a')).summary).toBe('第一项已写入')
    expect((await dreams.read()).records.get('global')?.unfinished?.quotaUsed).toBe(1)
    failWrite = undefined
    replies.tidy = [[{ op: 'refresh', id: 'mem_c', summary: '续跑第一项' }, { op: 'refresh', id: 'mem_d', summary: '续跑第二项' }]]
    expect((await dream()).kind).toBe('completed')
    expect((await get('mem_c')).summary).toBe('续跑第一项')
    expect((await get('mem_d')).summary).toBe('写锁设计的摘要')
  })

  it('一组撤回时写盘失败、改动留在盘上：它照样占名额，后面的不再做，运行按出错收', async () => {
    await seed(FOUR)
    ratio = 0.25
    const [a, b] = [await get('mem_a'), await get('mem_b')]
    // 撤回甲（写回原来的摘要）这一次写盘失败
    failWrite = (path, text) => path.endsWith('.md') && text.includes('id: mem_a') && text.includes(a.summary)
    const at = (r: MemoryRecord) => ({ memoryId: r.id, scopeKey: 'global', basis: [basisOf(r)] })
    const env = deps()
    env.plan = [{
      name: 'group', needsChanges: false,
      async run(ctx) {
        await ctx.apply([
          { ...at(a), id: 'a1', group: 'g', kind: 'edit', patch: { summary: '修改甲' }, expect: { summary: a.summary } },
          // 第二步的预期对不上，整组撤回
          { ...at(a), id: 'a2', group: 'g', kind: 'set-recall', patch: { recall: 'passive' }, expect: { recall: 'core' } },
          { ...at(b), id: 'b1', kind: 'edit', patch: { summary: '修改乙' }, expect: { summary: b.summary } },
        ])
      },
    }]
    expect((await runDreams(GLOBAL, { by: 'manual' }, env)).kind).toBe('failed')
    expect((await get('mem_a')).summary).toBe('修改甲')
    expect((await get('mem_b')).summary).toBe(b.summary)
    expect((await lastResult())?.skipped?.items).toContainEqual({ step: 'group', kind: 'edit', target: 'mem_b', reason: 'quota' })
    // 留在盘上的那一步回执还在批次上，可以再撤
    expect((await entryOf('run_1'))?.changes?.map(x => x.memoryId)).toEqual(['mem_a'])
  })
})

describe('撤销', () => {
  it('整批撤销：记忆字段和索引都回到改前，条目移出账本', async () => {
    await seed(FOUR)
    const before = await Promise.all(FOUR.map(([id]) => get(id)))
    replies.organize = [ASSIGN]
    replies.tidy = [TIDY]
    await dream()
    expect(await undo('run_1')).toMatchObject({ kind: 'undone', restored: expect.arrayContaining(['mem_a', 'mem_c']) })
    expect(await layout()).toEqual(allUnsorted)
    for (const [i, [id]] of FOUR.entries()) {
      const now = await get(id)
      expect([now.summary, now.tags, now.related, now.recall]).toEqual([before[i]!.summary, before[i]!.tags, before[i]!.related, before[i]!.recall])
    }
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('单条撤销：只撤那一条；之后整批撤销只撤剩下的', async () => {
    await seed(FOUR)
    replies.organize = [ASSIGN]
    replies.tidy = [TIDY]
    await dream()
    const entry = (await entryOf('run_1'))!
    const recall = entry.changes!.find(x => x.kind === 'set-recall')!
    const convention = entry.indexRun!.receipts[1]!
    expect(await undo('run_1', recall.op)).toMatchObject({ kind: 'undone', restored: ['mem_c'] })
    expect(await undo('run_1', convention.op)).toMatchObject({ kind: 'undone', restored: [] })
    expect((await get('mem_c')).recall).toBeUndefined()
    // 撤回的那条回到它原来在「未整理」里的位置
    expect(await layout()).toEqual({ 发版: ['mem_a', 'mem_b'], [UNSORTED_TITLE]: ['mem_d', 'mem_c'] })
    expect((await get('mem_a')).summary).toBe('发版前先跑全套 再打 tag')
    const left = (await entryOf('run_1'))!
    expect(left.changes?.map(x => x.kind)).toEqual(['edit', 'link'])
    expect(left.indexRun?.receipts).toHaveLength(1)
    // 撤过的那条再撤：不在了
    expect(await undo('run_1', recall.op)).toMatchObject({ kind: 'error', code: 'not-found' })
    expect(await undo('run_1')).toMatchObject({ kind: 'undone', restored: ['mem_a'] })
    expect(await layout()).toEqual(allUnsorted)
    const a = await get('mem_a')
    expect([a.summary, a.related]).toEqual(['发版步骤的摘要', undefined])
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('单撤一条索引回执：同一批里排在它后面的索引回执一并撤，顺序和改前一样，新主题不留', async () => {
    await seed(FOUR)
    replies.organize = [[
      { op: 'assign', memoryIds: ['mem_d'], from: UNSORTED_TITLE, to: '新主题', about: '新建的。' },
      { op: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '新主题' },
    ]]
    expect((await dream()).kind).toBe('completed')
    const [first] = (await entryOf('run_1'))!.indexRun!.receipts
    expect(await undo('run_1', first!.op)).toEqual({ kind: 'undone', decisionId: 'run_1', restored: [], alsoUndone: 1 })
    expect(await layout()).toEqual(allUnsorted)
    expect(await entryOf('run_1')).toBeUndefined()
  })

  it('同一条先刷新摘要再建关联：只单撤刷新摘要那条，关联留着', async () => {
    await seed(FOUR)
    replies.tidy = [[{ op: 'refresh', id: 'mem_a', summary: '甲的新摘要' }, { op: 'relate', id: 'mem_a', related: ['mem_b'] }]]
    await dream()
    const edit = (await entryOf('run_1'))!.changes!.find(x => x.kind === 'edit')!
    expect(await undo('run_1', edit.op)).toMatchObject({ kind: 'undone', restored: ['mem_a'] })
    expect(await get('mem_a')).toMatchObject({ summary: '发版步骤的摘要', related: ['mem_b'] })
    expect((await entryOf('run_1'))?.changes?.map(x => x.kind)).toEqual(['link'])
  })

  it('批次里还有记忆回执等着补记：撤完别的回执也不删条目，结果里说还有没撤完的；补记之后能接着撤', async () => {
    await seed(FOUR)
    replies.organize = [ASSIGN.slice(0, 1)]
    replies.tidy = [[{ op: 'refresh', id: 'mem_a', summary: '梦境写的甲' }]]
    failLedgerPut = value => (value.changes?.length ?? 0) > 0
    expect((await dream()).kind).toBe('failed')
    expect(await undo('run_1')).toMatchObject({ kind: 'undone', skipped: 1 })
    expect(await entryOf('run_1')).toBeDefined()
    // 故障解除、重启之后补记做成：那条改动照样能撤
    failLedgerPut = undefined
    openStore()
    await store.writeSection(async () => {})
    expect(await undo('run_1')).toMatchObject({ kind: 'undone', restored: ['mem_a'] })
    expect((await get('mem_a')).summary).toBe('发版步骤的摘要')
    expect(await layout()).toEqual(allUnsorted)
  })

  it('单撤一条索引回执、它后面还有没确认的：回忙，什么都不动；确认之后照严格逆序撤', async () => {
    await seed(FOUR)
    replies.organize = [[
      { op: 'assign', memoryIds: ['mem_d'], from: UNSORTED_TITLE, to: '新主题', about: '新建的。' },
      { op: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '新主题' },
    ]]
    // 第二个归组提交了，确认它回执的那次账本写入失败
    failLedgerPut = value => value.indexRun?.receipts.length === 2 && value.indexRun.receipts[1]?.isConfirmed === true
    await dream()
    const receipts = (await entryOf('run_1'))!.indexRun!.receipts
    expect(receipts.map(r => r.isConfirmed === true)).toEqual([true, false])
    const moved = await layout()
    expect(await undo('run_1', receipts[0]!.op)).toMatchObject({ kind: 'error', code: 'busy' })
    expect(await layout()).toEqual(moved)
    failLedgerPut = undefined
    openStore()
    await store.writeSection(async () => {})
    expect(await undo('run_1', receipts[0]!.op)).toMatchObject({ kind: 'undone', alsoUndone: 1 })
    expect(await layout()).toEqual(allUnsorted)
  })

  it('批次里没有可撤的回执：回不存在，不当成撤销成功', async () => {
    await decisions.addDreamsRun('run_x', { summary: '记忆梦境', workspace: 'global' }, NOW)
    expect(await undo('run_x')).toMatchObject({ kind: 'error', code: 'not-found' })
  })

  it('别的条目给了单条回执：不认，什么都不动', async () => {
    await seed(FOUR)
    const other = await decisions.addIndexRun('pd_other', { summary: '整理了一次主题索引', workspace: 'global' }, NOW)
    expect(await undo(other.id, 'op_x')).toMatchObject({ kind: 'error', code: 'not-found' })
  })
})

describe('中途退出与失败', () => {
  it('中途退出：已应用的各有回执；下次运行把批次收成部分完成，整批照样能撤', async () => {
    await seed(FOUR)
    // 丁的正文超过一批的文字量，单独一批；其余三条一批
    await store.updateIfLive({ id: 'mem_d' }, cur => ({ ...cur, content: '长'.repeat(30_000) }))
    replies.organize = [ASSIGN.slice(0, 1)]
    replies.tidy = [
      [{ op: 'refresh', id: 'mem_d', summary: '梦境写的丁' }],
      // 第二批的回复到了时认领已被接手：这一批不做，这次运行不再记任何东西
      () => { lose?.(); return [{ op: 'refresh', id: 'mem_c', summary: '梦境写的丙' }] },
    ]
    expect((await dream()).kind).toBe('lost')
    expect(prompts.tidy).toHaveLength(2)
    expect((await get('mem_d')).summary).toBe('梦境写的丁')
    expect((await get('mem_c')).summary).toBe('回复语言的摘要')
    expect((await dreams.read()).records.get('global')?.unfinished?.entryIds).toEqual(['run_1'])
    // 下次运行先收尾：条目收成留在账本里，两种回执都在
    expect((await dream()).kind).toBe('completed')
    const entry = (await entryOf('run_1'))!
    expect(entry.receipts).toBeDefined()
    expect(entry.indexRun?.receipts).toHaveLength(1)
    expect(entry.changes?.map(x => x.memoryId)).toEqual(['mem_d'])
    expect(await undo('run_1')).toMatchObject({ kind: 'undone' })
    expect((await get('mem_d')).summary).toBe('写锁设计的摘要')
    expect(await layout()).toEqual(allUnsorted)
  })

  it('记忆回执一直没补记上：收尾不删批次、运行按出错收；补记做成之后下次运行把它收好，照样能撤', async () => {
    await seed(FOUR)
    replies.tidy = [[{ op: 'refresh', id: 'mem_a', summary: '梦境写的甲' }]]
    // 记忆文件写成之后，账本里记回执的那次写一直失败
    failLedgerPut = value => (value.changes?.length ?? 0) > 0
    expect((await dream()).kind).toBe('failed')
    expect((await get('mem_a')).summary).toBe('梦境写的甲')
    expect(await entryOf('run_1')).toBeDefined()
    expect((await dreams.read()).records.get('global')?.unfinished?.entryIds).toEqual(['run_1'])
    // 故障解除、重启之后：补记做成，下次运行收尾
    failLedgerPut = undefined
    openStore()
    expect((await dream()).kind).toBe('completed')
    expect((await entryOf('run_1'))?.changes?.map(x => x.memoryId)).toEqual(['mem_a'])
    expect(await undo('run_1')).toMatchObject({ kind: 'undone', restored: ['mem_a'] })
    expect((await get('mem_a')).summary).toBe('发版步骤的摘要')
  })

  it('调模型失败：这一批不出操作，运行按出错收，不记成做完', async () => {
    await seed(FOUR)
    replies.organize = [new Error('网络断了')]
    const r = await dream()
    expect(r.kind).toBe('failed')
    expect(await layout()).toEqual(allUnsorted)
    expect(prompts.tidy).toHaveLength(0)
    const saved = (await dreams.read()).records.get('global')
    expect(saved?.completed).toBeUndefined()
    expect(saved?.unfinished?.reason).toBe('failed')
  })

  it('模型的回复重问一次仍读不出：这一批不出操作，前面做成的留着，运行不记成做完', async () => {
    await seed(FOUR)
    replies.organize = [ASSIGN]
    replies.tidy = ['不是 JSON', '还不是']
    const r = await dream()
    expect(r.kind).toBe('failed')
    expect(prompts.tidy).toHaveLength(2)
    expect(await layout()).toMatchObject({ 发版: ['mem_a', 'mem_b'] })
    expect((await dreams.read()).records.get('global')?.completed).toBeUndefined()
    expect((await entryOf('run_1'))?.indexRun?.receipts).toHaveLength(2)
  })

  it('这个范围有记忆文件读不出：在用条数不准，这次不跑，不调模型', async () => {
    await seed(FOUR)
    const dir = join(root, GLOBAL_DIR)
    expect((await readdir(dir)).length).toBeGreaterThan(0)
    await writeFile(join(dir, 'broken.md'), '---\nid: [坏的\n---\n正文', 'utf8')
    const r = await dream()
    expect(r.kind).toBe('failed')
    expect(prompts.organize).toHaveLength(0)
    expect(prompts.tidy).toHaveLength(0)
  })
})

describe('读不全', () => {
  it('读完基线之后有记忆文件变得读不出：不当成没有这条，运行按出错收，不记成做完', async () => {
    await seed(FOUR)
    replies.organize = [async () => {
      const file = (await store.readRaw(GLOBAL)).records.find(r => r.record.id === 'mem_a')!.filePath
      await writeFile(file, '---\nid: [坏的\n---\n正文', 'utf8')
      return []
    }]
    expect((await dream()).kind).toBe('failed')
    expect(prompts.tidy).toHaveLength(0)
    expect((await dreams.read()).records.get('global')?.completed).toBeUndefined()
  })
})

describe('模型输出的解析', () => {
  const a = record({ id: 'mem_a', summary: '甲的摘要', tags: ['甲'], recall: 'passive' })
  const b = record({ id: 'mem_b', related: [] })
  const read = new Map([[a.id, a], [b.id, b]])
  const parse = (operations: unknown, maxOpsPerMemory = 20) => {
    let n = 0
    return parseTidyOutput(typeof operations === 'string' ? operations : JSON.stringify({ operations }), read, () => `op${++n}`, { typeRecall, maxOpsPerMemory })
  }

  it('整体不是要求的 JSON：返回 undefined，交给调用方重问', () => {
    expect(parse('好的，我来整理')).toBeUndefined()
  })

  it('操作带上读到时的依据和预期值；标签去重、去空、折成一行', () => {
    const r = parse([{ op: 'refresh', id: 'mem_a', tags: ['甲', ' 别名\n二 ', '', '甲'] }, { op: 'recall', id: 'mem_b', recall: 'unlisted' }, { op: 'relate', id: 'mem_b', related: ['mem_a', 'mem_b'] }])!
    expect(r.dropped).toEqual([])
    expect(r.ops).toEqual([
      expect.objectContaining({ kind: 'edit', memoryId: 'mem_a', patch: { tags: ['甲', '别名 二'] }, expect: { tags: ['甲'] }, basis: [expect.objectContaining({ memoryId: 'mem_a' })] }),
      expect.objectContaining({ kind: 'set-recall', memoryId: 'mem_b', patch: { recall: 'unlisted' }, expect: { recall: null } }),
      expect.objectContaining({ kind: 'link', memoryId: 'mem_b', links: { add: { related: ['mem_a'] } }, basis: [expect.objectContaining({ memoryId: 'mem_b' }), expect.objectContaining({ memoryId: 'mem_a' })] }),
    ])
  })

  it('不认识的记忆、不认识的档位、和现状一样的、格式不对的：丢掉这一个，其余照收，丢掉的逐个列出', () => {
    const r = parse([
      { op: 'refresh', id: 'mem_x', summary: '新的' },
      { op: 'recall', id: 'mem_a', recall: 'always' },
      { op: 'recall', id: 'mem_a', recall: 'passive' },
      { op: 'refresh', id: 'mem_a', summary: '甲的摘要', tags: ['甲'] },
      { op: 'relate', id: 'mem_a', related: ['mem_x'] },
      { op: 'rename', id: 'mem_a' },
      { op: 'refresh', id: 'mem_b', summary: '乙的新摘要' },
    ])!
    expect(r.dropped).toEqual([
      { kind: 'refresh', target: 'mem_x' }, { kind: 'recall', target: 'mem_a' }, { kind: 'recall', target: 'mem_a' },
      { kind: 'refresh', target: 'mem_a' }, { kind: 'relate', target: 'mem_a' }, { kind: 'rename', target: 'mem_a' },
    ])
    expect(r.ops.map(o => [o.kind, o.memoryId])).toEqual([['edit', 'mem_b']])
  })

  it('提示词要求摘要和标签用记忆原来的语言写；档位在三档之间按生效档位调，不提 core', () => {
    const { system } = buildTidyPrompt({ entry: '', pages: {} }, read, new Set(['mem_a']), typeRecall)
    expect(system).toContain('原来的语言')
    expect(system).toContain('在 search、passive、unlisted 之间调整')
    expect(system).toContain('effectiveRecall')
    expect(system).not.toMatch(/提到 core|core：|降到/)
  })

  it('交给模型的每条记忆带上实际生效的档位：单条设的，否则类型默认', async () => {
    await seed([['mem_a', '甲'], ['mem_b', '乙']])
    await store.updateIfLive({ id: 'mem_a' }, cur => ({ ...cur, recall: 'passive' }))
    const members = new Map([['mem_a', await get('mem_a')], ['mem_b', await get('mem_b')]])
    const { user } = buildTidyPrompt((await store.readIndex(GLOBAL))!, members, new Set(['mem_a', 'mem_b']), type => (type === 'knowledge' ? 'core' : 'search'))
    const rows = (JSON.parse(user.slice(user.indexOf('['))) as Array<{ members: Array<{ id: string; recall: string | null; effectiveRecall: string }> }>).flatMap(g => g.members)
    expect(rows.map(r => [r.id, r.recall, r.effectiveRecall]).sort()).toEqual([['mem_a', 'passive', 'passive'], ['mem_b', null, 'core']])
  })

  it('摘要超过 120 字、标签超过 12 个：丢掉这个操作', () => {
    const r = parse([
      { op: 'refresh', id: 'mem_a', summary: '长'.repeat(121) },
      { op: 'refresh', id: 'mem_a', tags: Array.from({ length: 13 }, (_, i) => `标签${i}`) },
      { op: 'refresh', id: 'mem_b', summary: '长'.repeat(120), tags: Array.from({ length: 12 }, (_, i) => `标签${i}`) },
    ])!
    expect(r.dropped.map(d => d.target)).toEqual(['mem_a', 'mem_a'])
    expect(r.ops.map(o => o.memoryId)).toEqual(['mem_b'])
  })

  it('档位升到 core、或和这条现在生效的档位相同：丢掉；降档照做', () => {
    const r = parse([
      { op: 'recall', id: 'mem_b', recall: 'core' },
      // 乙没单独设，跟随类型的 search
      { op: 'recall', id: 'mem_b', recall: 'search' },
      { op: 'recall', id: 'mem_a', recall: 'unlisted' },
    ])!
    expect(r.dropped).toEqual([{ kind: 'recall', target: 'mem_b' }, { kind: 'recall', target: 'mem_b' }])
    expect(r.ops.map(o => [o.kind, o.memoryId])).toEqual([['set-recall', 'mem_a']])
  })

  it('写回的摘要或标签里带着遮盖的占位：丢掉这个操作', () => {
    const r = parse([
      { op: 'refresh', id: 'mem_a', summary: `用 ${SECRET_MASK} 登录` },
      { op: 'refresh', id: 'mem_b', tags: ['发版', SECRET_MASK] },
    ])!
    expect(r.dropped).toHaveLength(2)
    expect(r.ops).toEqual([])
  })

  it('同一条记忆的操作超过上限：多出来的丢掉并列出', () => {
    const r = parse([
      ...Array.from({ length: 3 }, (_, i) => ({ op: 'refresh', id: 'mem_a', summary: `新摘要${i}` })),
      { op: 'recall', id: 'mem_b', recall: 'passive' },
    ], 2)!
    expect(r.ops.map(o => o.memoryId)).toEqual(['mem_a', 'mem_a', 'mem_b'])
    expect(r.dropped).toEqual([{ kind: 'refresh', target: 'mem_a' }])
  })
})
