import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { INDEX_FILE } from '../src/storage/paths.ts'
import type { CheckupRecord, RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { ledgerSteps } from '../src/governance/op-steps.ts'
import type { PendingDecision } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import type { SnapshotStore } from '../src/governance/snapshots.ts'
import { runOrganize, type OrganizeOutcome } from '../src/gui/organize-run.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { UNSORTED_TITLE, readIndex } from '../src/topic-index.ts'
import { InMemoryBatchKvTable, InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

// 「整理一次索引」从头到尾：真文件、真操作日志、真写锁，模型是按顺序吐预设回复的桩。

const quiet = { info() {}, warn() {}, error() {} }
const global = { kind: 'global' } as const
const NOW = Date.parse('2026-06-01T00:00:00.000Z')

let root: string
let journal: OpJournal
let table: FileTable
let store: MemoryStore
let decisions: PendingDecisionsStore
let checkups: CheckupRecordStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-organize-'))
  journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
  const lock = createRootLock({ root, log: quiet })
  const stats = new InMemoryBatchKvTable<RecallStats>()
  table = new FileTable({ root, stats, log: quiet, lock, journal })
  store = new MemoryStore(table, quiet, stats)
  decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>(), lock)
  checkups = new CheckupRecordStore(new InMemoryKvTable<CheckupRecord>())
  store.registerSteps(ledgerSteps(decisions, quiet))
  for (const [id, name] of [['mem_a', '发版步骤'], ['mem_b', '打 tag'], ['mem_c', '回复语言'], ['mem_d', '写锁设计']] as const) {
    await table.create(record({ id, name, summary: `${name}的摘要`, content: `${name}的正文` }))
  }
  await store.maintain(global)
})
afterEach(async () => {
  journal.close()
  await rm(root, { recursive: true, force: true })
})

/** 按顺序回复的模型桩；回复用完了回空的操作表。throws 里的位置改成抛错。 */
function modelOf(replies: Array<unknown[] | string | Error>) {
  const prompts: Array<{ system: string; user: string }> = []
  const llm: SemanticLlm = {
    model: 'stub',
    complete: async (prompt) => {
      prompts.push(prompt)
      const reply = replies[prompts.length - 1] ?? []
      if (reply instanceof Error) throw reply
      return typeof reply === 'string' ? reply : JSON.stringify({ operations: reply })
    },
  }
  return { llm, prompts }
}

const organize = (llm: SemanticLlm, signal?: AbortSignal) => runOrganize({ scope: global, llm, ...(signal !== undefined ? { signal } : {}) }, {
  store, decisions, checkups, interval: () => () => {}, maxTopics: 30, now: () => NOW, log: quiet,
})
const done = (r: OrganizeOutcome) => {
  if (r.kind !== 'done') throw new Error(`预期做完，实际：${JSON.stringify(r)}`)
  return r
}
const layout = async () => {
  const { topics, unsorted } = readIndex((await store.readIndex(global))!)
  return Object.fromEntries([...topics.map(t => [t.name, t.memberIds] as const), [UNSORTED_TITLE, unsorted]])
}
const undoDeps = () => ({ store, decisions, snapshots: {} as SnapshotStore, ignores: { unignoreIfSame: async () => false } })
const undo = (decisionId: string) => executeUndo({ decisionId }, { workspacePath: undefined }, undoDeps())

const ASSIGN_RELEASE = { op: 'assign', memoryIds: ['mem_a', 'mem_b'], from: UNSORTED_TITLE, to: '发版', about: '发版、打 tag 的步骤。' }
const ASSIGN_CONVENTION = { op: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '约定', about: '协作上的约定。' }

describe('整理一次索引', () => {
  it('还没有主题时直接按批问成员；给的操作逐个落盘，入口投影跟着更新，记下整理的时刻', async () => {
    const { llm, prompts } = modelOf([[ASSIGN_RELEASE, ASSIGN_CONVENTION]])
    const r = done(await organize(llm))
    expect(r).toMatchObject({ applied: 2, skipped: 0, dropped: 0, unreadBatches: 0 })
    expect(r.isPartial).toBeUndefined()
    expect(await layout()).toEqual({ 发版: ['mem_a', 'mem_b'], 约定: ['mem_c'], [UNSORTED_TITLE]: ['mem_d'] })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.user).toContain('## 主题目录\n[]')
    expect(prompts[0]!.user).toContain('mem_d')
    const projection = await readFile(join(table.globalDir, INDEX_FILE), 'utf8')
    expect(projection).toContain('发版')
    expect(projection).toContain('约定')
    expect((await checkups.list()).map(c => c.organizedAt)).toEqual([NOW])
  })

  it('留一条回执齐全的记录：一个做成的操作一条，按做的先后；做完不再标「进行中」', async () => {
    const r = done(await organize(modelOf([[ASSIGN_RELEASE, ASSIGN_CONVENTION]]).llm))
    const [entry] = await decisions.listSettled()
    expect(entry).toMatchObject({ id: r.decisionId, kind: 'index-organize', memoryIds: [], workspaces: ['global'], settled: { verdict: 'index-organized', at: NOW } })
    expect(entry!.indexRun!.receipts.map(x => [x.plan.kind, 'name' in x.plan ? x.plan.name : undefined])).toEqual([['assign', '发版'], ['assign', '约定']])
    expect(journal.hasPending()).toBe(false)
  })

  it('落盘时对不上的操作跳过，不影响其余', async () => {
    const r = done(await organize(modelOf([[
      { op: 'assign', memoryIds: ['mem_a'], from: '没有的主题', to: '发版' },
      ASSIGN_CONVENTION,
      { op: 'rename', topic: '也没有', name: '新名' },
    ]]).llm))
    expect(r).toMatchObject({ applied: 1, skipped: 2 })
    const after = await layout()
    expect(after['约定']).toEqual(['mem_c'])
    expect([...after[UNSORTED_TITLE]!].sort()).toEqual(['mem_a', 'mem_b', 'mem_d'])
    expect((await decisions.listSettled())[0]!.indexRun!.receipts).toHaveLength(1)
  })

  it('已有主题时先问主题目录（这一批不带成员）、再按批问成员；后一批看到的是前面操作做完之后的索引', async () => {
    await organize(modelOf([[ASSIGN_RELEASE]]).llm)
    const { llm, prompts } = modelOf([[{ op: 'rename', topic: '发版', name: '发布流程' }], []])
    done(await organize(llm))
    expect(prompts).toHaveLength(2)
    expect(prompts[0]!.user).toContain('"name":"发版"')
    expect(prompts[0]!.user).toContain('## 这一批的成员\n[]')
    expect(prompts[1]!.user).toContain('"topic":"发布流程"')
  })

  it('模型什么都不改：不留记录，照样记下整理的时刻', async () => {
    const r = done(await organize(modelOf([]).llm))
    expect(r).toMatchObject({ applied: 0 })
    expect(r.decisionId).toBeUndefined()
    expect(await decisions.listSettled()).toEqual([])
    expect((await checkups.list())[0]!.organizedAt).toBe(NOW)
  })

  it('回复读不出来：带着提示再问一次；还读不出，这一批记一笔、别的批照做', async () => {
    await organize(modelOf([[ASSIGN_RELEASE]]).llm)
    const { llm, prompts } = modelOf(['我觉得不用改', '还是不用改', [ASSIGN_CONVENTION]])
    const r = done(await organize(llm))
    expect(r).toMatchObject({ applied: 1, unreadBatches: 1 })
    expect(prompts[1]!.user).toContain('只回复那个 JSON 对象')
    expect(prompts[2]!.user).not.toContain('只回复那个 JSON 对象')
  })

  it('模型调用出错、一个操作都没做：报失败，不留记录，不记整理的时刻', async () => {
    const r = await organize(modelOf([new Error('upstream 503')]).llm)
    expect(r).toEqual({ kind: 'failed', message: 'upstream 503' })
    expect(await decisions.listSettled()).toEqual([])
    expect((await checkups.list()).some(c => c.organizedAt !== undefined)).toBe(false)
  })

  it('做了一部分之后模型出错：已做的留着、有回执、可撤，结果标明只做了一部分', async () => {
    await organize(modelOf([[ASSIGN_RELEASE]]).llm)
    const r = done(await organize(modelOf([[{ op: 'describe', topic: '发版', about: '发版、打 tag。' }], new Error('upstream 503')]).llm))
    expect(r).toMatchObject({ applied: 1, isPartial: true })
    const entry = (await decisions.listSettled()).find(e => e.id === r.decisionId)!
    expect(entry.indexRun!.receipts).toHaveLength(1)
    expect(await undo(r.decisionId!)).toMatchObject({ kind: 'undone' })
  })

  it('这个范围正在体检或整理：回忙，什么都不做', async () => {
    const held = await checkups.claim([global])
    const { llm, prompts } = modelOf([[ASSIGN_CONVENTION]])
    expect(await organize(llm)).toEqual({ kind: 'busy', scope: global })
    expect(prompts).toEqual([])
    if ('claims' in held) for (const c of held.claims) await c.release()
    // 做完放掉认领：下一次进得来
    expect((await organize(modelOf([]).llm)).kind).toBe('done')
  })

  it('还没有记忆的范围：不问模型', async () => {
    const { llm, prompts } = modelOf([])
    expect(await runOrganize({ scope: { kind: 'workspace', workspacePath: '/w/empty' }, llm }, {
      store, decisions, checkups, interval: () => () => {}, maxTopics: 30, now: () => NOW, log: quiet,
    })).toEqual({ kind: 'empty' })
    expect(prompts).toEqual([])
  })

  it('开跑前已经取消：不问模型、不留记录', async () => {
    const { llm, prompts } = modelOf([[ASSIGN_CONVENTION]])
    const r = done(await organize(llm, AbortSignal.abort()))
    expect(r).toMatchObject({ applied: 0, isPartial: true })
    expect(prompts).toEqual([])
  })
})

describe('整批撤销', () => {
  it('按回执从后往前撤：索引回到整理前，记录移出账本；再撤一次说不在了', async () => {
    const before = await layout()
    const r = done(await organize(modelOf([[ASSIGN_RELEASE, ASSIGN_CONVENTION, { op: 'rename', topic: '发版', name: '发布流程' }, { op: 'merge', from: ['约定'], into: '发布流程' }]]).llm))
    expect(r.applied).toBe(4)
    expect(await layout()).toEqual({ 发布流程: ['mem_a', 'mem_b', 'mem_c'], [UNSORTED_TITLE]: ['mem_d'] })
    expect(await undo(r.decisionId!)).toEqual({ kind: 'undone', decisionId: r.decisionId, restored: [] })
    expect(await layout()).toEqual(before)
    expect(await decisions.listSettled()).toEqual([])
    expect(await readFile(join(table.globalDir, INDEX_FILE), 'utf8')).not.toContain('发布流程')
    expect(await undo(r.decisionId!)).toMatchObject({ kind: 'error', code: 'not-found' })
    expect(journal.hasPending()).toBe(false)
  })

  it('整理之后新保存的记忆进了动过的主题：撤销照样能做，新来的那条留在原处', async () => {
    const r = done(await organize(modelOf([[ASSIGN_CONVENTION]]).llm))
    await table.create(record({ id: 'mem_new', name: '提交信息', summary: '提交信息的摘要', content: '提交信息的正文' }))
    await store.maintain(global)
    expect(await store.applyIndexOp(global, { kind: 'assign', memoryIds: ['mem_new'], from: UNSORTED_TITLE, to: '约定' }, { maxTopics: 30 })).toMatchObject({ kind: 'applied' })
    expect(await undo(r.decisionId!)).toMatchObject({ kind: 'undone' })
    const after = await layout()
    expect(after['约定']).toEqual(['mem_new'])
    expect(after[UNSORTED_TITLE]).toContain('mem_c')
    expect(await decisions.listSettled()).toEqual([])
  })

  it('其中一个操作之后又被改过：别的照撤，那一个留着，结果带上没撤的个数，记录里只剩它的回执', async () => {
    const before = await layout()
    const r = done(await organize(modelOf([[ASSIGN_RELEASE, ASSIGN_CONVENTION, { op: 'describe', topic: '发版', about: '整理时写的说明。' }]]).llm))
    expect(await store.applyIndexOp(global, { kind: 'describe', topic: '发版', about: '之后手改的说明。' }, { maxTopics: 30 })).toMatchObject({ kind: 'applied' })
    const result = await undo(r.decisionId!)
    expect(result).toMatchObject({ kind: 'undone', skipped: 1 })
    expect((await layout())[UNSORTED_TITLE]).toEqual(before[UNSORTED_TITLE])
    const [left] = await decisions.listSettled()
    expect(left!.indexRun!.receipts.map(x => x.plan.kind)).toEqual(['describe'])
    // 说明后来改过的那个主题留着（成员已经搬回去），留下的回执指着的页还在
    expect((await layout())['发版']).toEqual([])
  })

  it('上一次撤销撤完了回执、没来得及把记录移出账本：再撤一次把记录移走', async () => {
    const r = done(await organize(modelOf([[ASSIGN_CONVENTION]]).llm))
    const [entry] = await decisions.listSettled()
    for (const receipt of entry!.indexRun!.receipts) {
      expect(await store.undoIndexPlan(global, receipt.plan)).toMatchObject({ kind: 'undone' })
      await decisions.dropIndexReceipt(entry!.id, receipt.op)
    }
    expect(await undo(r.decisionId!)).toEqual({ kind: 'undone', decisionId: r.decisionId, restored: [] })
    expect(await decisions.listSettled()).toEqual([])
  })

  it('收尾时回执还没确认、但它的操作提交了正等着补做：回执留着，补做时确认', async () => {
    await decisions.addIndexRun('pd_x', { summary: '整理', workspace: 'global' }, NOW)
    const plan = { kind: 'describe', page: '约定.md', about: '新的', before: '' } as const
    await decisions.appendIndexReceipt('pd_x', { op: 'op_pending', plan })
    await decisions.appendIndexReceipt('pd_x', { op: 'op_never', plan })
    const left = await decisions.finishIndexRun('pd_x', op => op === 'op_pending')
    expect(left!.indexRun!.receipts.map(x => x.op)).toEqual(['op_pending'])
    expect(await decisions.confirmIndexReceipt('pd_x', 'op_pending')).toBe(true)
    expect((await decisions.listSettled())[0]!.indexRun!.receipts).toEqual([{ op: 'op_pending', plan, isConfirmed: true }])
  })

  it('记录里还有一条没确认的回执（操作等着补做）：确认过的照撤，那一条算没撤，记录留着', async () => {
    const r = done(await organize(modelOf([[ASSIGN_CONVENTION]]).llm))
    await decisions.appendIndexReceipt(r.decisionId!, { op: 'op_pending', plan: { kind: 'describe', page: '约定.md', about: '新的', before: '' } })
    expect(await undo(r.decisionId!)).toMatchObject({ kind: 'undone', skipped: 1 })
    expect((await decisions.listSettled())[0]!.indexRun!.receipts.map(x => x.op)).toEqual(['op_pending'])
  })

  it('动过的主题全都又被改过：什么都不动，回「之后又被改过」', async () => {
    const r = done(await organize(modelOf([[ASSIGN_CONVENTION, { op: 'describe', topic: '约定', about: '整理时写的。' }]]).llm))
    await store.applyIndexOp(global, { kind: 'rename', topic: '约定', name: '规矩' }, { maxTopics: 30 })
    await store.applyIndexOp(global, { kind: 'describe', topic: '规矩', about: '之后手改的。' }, { maxTopics: 30 })
    await store.applyIndexOp(global, { kind: 'assign', memoryIds: ['mem_c'], from: '规矩', to: '别处', about: '挪走了。' }, { maxTopics: 30 })
    const before = await layout()
    expect(await undo(r.decisionId!)).toMatchObject({ kind: 'error', code: 'stale', reason: 'changed' })
    expect(await layout()).toEqual(before)
    expect((await decisions.listSettled())[0]!.indexRun!.receipts).toHaveLength(2)
  })
})
