import { afterEach, beforeEach, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { UNSORTED_TITLE } from '../src/topic-index.ts'
import type { IndexOp, IndexPlan } from '../src/topic-ops.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { interleaveRuns, interleaveSeed } from './helpers/interleave.ts'
import { indexTree, indexedIdsMatchDisk } from './helpers/topic-index.ts'
import { record } from './helpers/record.ts'

// 索引操作和记忆写入的随机序列：几路同时发起（进程内排队，顺序不定），做完之后索引要对得上磁盘——
// 每条在用的记忆在索引里恰好一行，再核对一遍不再有改动；把做成的操作倒着全撤一遍之后同样成立。

const quiet = { info() {}, warn() {}, error() {} }
const global = { kind: 'global' } as const
const TOPICS = ['甲类', '乙类', '丙类', '丁类']
const PLACES = [...TOPICS, UNSORTED_TITLE]
const IDS = ['mem_1', 'mem_2', 'mem_3', 'mem_4', 'mem_5', 'mem_6']

type Step =
  | { kind: 'index'; op: IndexOp }
  | { kind: 'create'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'retitle'; id: string }
  | { kind: 'maintain' }

const idArb = fc.constantFrom(...IDS)
const topicArb = fc.constantFrom(...TOPICS)
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('assign' as const), memoryIds: fc.uniqueArray(idArb, { minLength: 1, maxLength: 2 }), from: fc.constantFrom(UNSORTED_TITLE, UNSORTED_TITLE, ...PLACES), to: topicArb, about: fc.constant('说明。') }).map(op => ({ kind: 'index' as const, op })) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('rename' as const), topic: topicArb, name: fc.constantFrom(...TOPICS, '戊类') }).map(op => ({ kind: 'index' as const, op })) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('merge' as const), from: fc.uniqueArray(topicArb, { minLength: 1, maxLength: 2 }), into: topicArb }).map(op => ({ kind: 'index' as const, op })) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('order-topics' as const), order: fc.shuffledSubarray(TOPICS) }).map(op => ({ kind: 'index' as const, op })) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('order-members' as const), topic: topicArb, order: fc.shuffledSubarray(IDS) }).map(op => ({ kind: 'index' as const, op })) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('describe' as const), topic: topicArb, about: fc.constantFrom('一句说明。', '另一句说明。') }).map(op => ({ kind: 'index' as const, op })) },
  { weight: 2, arbitrary: idArb.map(id => ({ kind: 'create' as const, id })) },
  { weight: 2, arbitrary: idArb.map(id => ({ kind: 'delete' as const, id })) },
  { weight: 1, arbitrary: idArb.map(id => ({ kind: 'retitle' as const, id })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'maintain' as const }) },
)

let root: string
let journal: OpJournal
let applied = 0
let undone = 0
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-index-random-')) })
afterEach(async () => {
  journal.close()
  await rm(root, { recursive: true, force: true })
})

it('索引操作和记忆写入随机交错：做完、撤完之后索引都对得上磁盘，每条记忆恰好一行', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.array(stepArb, { minLength: 1, maxLength: 4 }), { minLength: 2, maxLength: 6 }), async (waves) => {
    await rm(root, { recursive: true, force: true })
    journal?.close()
    journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
    const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }), journal })
    const dir = join(root, 'global')
    for (const id of IDS.slice(0, 4)) await table.create(record({ id, name: `记忆 ${id}`, summary: `${id} 的摘要` }))
    await table.maintain([dir])
    // 开局先有两个主题，后面的改名、合并、调顺序才有东西可动
    await table.applyIndexOp(dir, { kind: 'assign', memoryIds: ['mem_1'], from: UNSORTED_TITLE, to: '甲类', about: '甲。' }, { maxTopics: 3 })
    await table.applyIndexOp(dir, { kind: 'assign', memoryIds: ['mem_2'], from: UNSORTED_TITLE, to: '乙类', about: '乙。' }, { maxTopics: 3 })
    const plans: IndexPlan[] = []
    let revision = 0
    const run = async (step: Step): Promise<void> => {
      switch (step.kind) {
        case 'index': {
          const r = await table.applyIndexOp(dir, step.op, { maxTopics: 3 })
          if (r.kind === 'applied') plans.push(r.plan)
          return
        }
        case 'create':
          if (await table.locate(step.id, global) === undefined) await table.create(record({ id: step.id, name: `记忆 ${step.id}`, summary: `${step.id} 的摘要` })).catch(() => {})
          return
        case 'delete': await table.delete(step.id, global).catch(() => {}); return
        case 'retitle': await table.update(step.id, global, r => ({ ...r, summary: `${step.id} 的第 ${++revision} 版摘要` })).catch(() => {}); return
        case 'maintain': await table.maintain([dir])
      }
    }
    const settled = async () => {
      await table.maintain([dir])
      const ids = await indexedIdsMatchDisk(table, dir)
      expect(new Set(ids).size).toBe(ids.length)
      const before = await indexTree(dir)
      await table.maintain([dir])
      expect(await indexTree(dir)).toEqual(before)
      expect(journal.hasPending()).toBe(false)
    }
    // 一波里的几步同时发起
    for (const wave of waves) await Promise.all(wave.map(run))
    await settled()
    applied += plans.length
    for (const plan of plans.reverse()) if ((await table.undoIndexPlan(dir, plan)).kind === 'undone') undone++
    await settled()
  }), { seed: interleaveSeed(), numRuns: interleaveRuns(40) })
  // 生成的序列里确实有做成的、撤成的操作，不是全被跳过
  expect(applied).toBeGreaterThan(0)
  expect(undone).toBeGreaterThan(0)
}, 120_000)
