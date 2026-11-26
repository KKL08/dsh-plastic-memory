import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { newWriteOp, type LocateTarget, type TopicIntent } from '../src/storage/table.ts'
import { isPendingDelegated, type MemoryRecord } from '../src/record-schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { UNSORTED_TITLE } from '../src/topic-index.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { interleaveRuns, interleaveSeed } from './helpers/interleave.ts'
import { record } from './helpers/record.ts'
import { indexTree, indexedIds } from './helpers/topic-index.ts'
import { applied, entryOf, expectedRow, membersOf, placement, rowOf } from './helpers/topic-placement.ts'

// 几路写入同时归主题：两个「进程」（各自的文件表、日志连接、写锁实例，同一个记忆根）。
// 做完之后不维护，每条在用的记忆在自己目录的索引里恰好一行、行和文件对得上；再维护一遍索引不变。

const quiet = { info() {}, warn() {}, error() {} }
const G = { kind: 'global' } as const
const WS = '/tmp/pm-topic-concurrency-ws'
const W = { kind: 'workspace', workspacePath: WS } as const

let root: string
const journals: OpJournal[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-topic-concurrency-')) })
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close()
  await rm(root, { recursive: true, force: true })
})

function open() {
  const journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quiet })
  journals.push(journal)
  return { table: new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }), journal }), journal }
}
const gdir = () => join(root, GLOBAL_DIR)
const wdir = () => join(root, workspaceDirName(WS))
const choose = (name: string, about?: string): TopicIntent => ({ kind: 'choose', name, ...(about !== undefined ? { about } : {}), maxTopics: 4 })

async function createWith(table: FileTable, r: MemoryRecord, topic?: TopicIntent) {
  const op = topic === undefined ? undefined : newWriteOp({ topic })
  await table.create(r, op)
  if (op !== undefined) await table.finishOp(op, r)
}
async function updateWith(table: FileTable, id: string, at: LocateTarget, fn: (r: MemoryRecord) => MemoryRecord, topic?: TopicIntent) {
  const op = topic === undefined ? undefined : newWriteOp({ topic })
  const written = await table.update(id, at, fn, op)
  if (op !== undefined) await table.finishOp(op, written)
}

/** 两个目录都有索引：全局 mem_1 在「上线」，项目 mem_w 在「上线」。 */
async function seed(table: FileTable) {
  await table.create(record({ id: 'mem_1', name: '记忆 1' }))
  await table.create(record({ id: 'mem_w', name: '项目里的', scope: 'workspace', workspacePath: WS }))
  await table.maintain([gdir(), wdir()])
  await applied(table, gdir(), { kind: 'assign', memoryIds: ['mem_1'], from: UNSORTED_TITLE, to: '上线' })
  await applied(table, wdir(), { kind: 'assign', memoryIds: ['mem_w'], from: UNSORTED_TITLE, to: '上线' })
}

/**
 * 不维护直接看：每个目录里每条在用、已进主档的记忆恰好一行，行和磁盘上的文件对得上，索引里没有别的成员；
 * 再维护一遍两个目录的索引都不变，日志里没有待补的行。
 */
async function expectSettled(table: FileTable, journal: OpJournal, label: string) {
  for (const [dir, at] of [[gdir(), G], [wdir(), W]] as const) {
    const live = (await table.readScope([dir])).records.filter(l => l.record.status === 'active' && !isPendingDelegated(l.record)).map(l => l.record.id)
    const ids = await indexedIds(dir)
    expect([...ids].sort(), label).toEqual([...new Set(live)].sort())
    expect(new Set(ids).size, label).toBe(ids.length)
    for (const id of live) expect(await rowOf(dir, id), `${label}：${id}`).toBe(await expectedRow(table, id, at))
  }
  const trees = [await indexTree(gdir()), await indexTree(wdir())]
  await table.maintain([gdir(), wdir()])
  expect([await indexTree(gdir()), await indexTree(wdir())], label).toEqual(trees)
  expect(journal.hasPending(), label).toBe(false)
}

describe('同时保存到同一个主题', () => {
  it('两个进程同时保存到同一个现有主题：两行都在，都排在原来那行前面', async () => {
    const a = open()
    const b = open()
    await seed(a.table)
    await Promise.all([
      createWith(a.table, record({ id: 'mem_x', name: '甲进程的' }), choose('上线')),
      createWith(b.table, record({ id: 'mem_y', name: '乙进程的' }), choose('上线')),
    ])
    const members = (await membersOf(gdir(), '上线'))!
    expect([...members].sort()).toEqual(['mem_1', 'mem_x', 'mem_y'])
    expect(members.at(-1)).toBe('mem_1')
    expect(await placement(gdir())).toEqual({ mem_1: ['上线'], mem_x: ['上线'], mem_y: ['上线'] })
    await expectSettled(a.table, a.journal, '两路同时归现有主题')
  })

  it('两个进程同时用同一个新名字：只建一个主题，两行都在里面', async () => {
    const a = open()
    const b = open()
    await seed(a.table)
    await Promise.all([
      createWith(a.table, record({ id: 'mem_x' }), choose('写锁', '甲的说明。')),
      createWith(b.table, record({ id: 'mem_y' }), choose(' 写锁 ', '乙的说明。')),
    ])
    expect((await entryOf(gdir())).filter(t => t.name === '写锁')).toHaveLength(1)
    expect([...(await membersOf(gdir(), '写锁'))!].sort()).toEqual(['mem_x', 'mem_y'])
    await expectSettled(a.table, a.journal, '两路同时建同名主题')
  })
})

type Step =
  | { kind: 'create'; id: string; topic?: string }
  | { kind: 'move-topic'; id: string; topic: string }
  | { kind: 'retitle'; id: string }
  | { kind: 'edit-content'; id: string }
  | { kind: 'soft-delete'; id: string }
  | { kind: 'hard-delete'; id: string }
  | { kind: 'switch-scope'; id: string; isCarried: boolean }

const IDS = ['mem_1', 'mem_2', 'mem_3', 'mem_4', 'mem_5']
// 现有的、新的、不能用的名字都有；上限 4 个主题，新名字多了会到上限
const NAMES = ['上线', '回复语言', '写锁', '甲类', '乙类', '甲、乙']
const idArb = fc.constantFrom(...IDS)
const nameArb = fc.constantFrom(...NAMES)
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ id: idArb, topic: fc.option(nameArb, { nil: undefined }) }).map(s => ({ kind: 'create' as const, id: s.id, ...(s.topic !== undefined ? { topic: s.topic } : {}) })) },
  { weight: 3, arbitrary: fc.record({ id: idArb, topic: nameArb }).map(s => ({ kind: 'move-topic' as const, ...s })) },
  { weight: 2, arbitrary: idArb.map(id => ({ kind: 'retitle' as const, id })) },
  { weight: 2, arbitrary: idArb.map(id => ({ kind: 'edit-content' as const, id })) },
  { weight: 1, arbitrary: idArb.map(id => ({ kind: 'soft-delete' as const, id })) },
  { weight: 1, arbitrary: idArb.map(id => ({ kind: 'hard-delete' as const, id })) },
  { weight: 2, arbitrary: fc.record({ id: idArb, isCarried: fc.boolean() }).map(s => ({ kind: 'switch-scope' as const, ...s })) },
)

it('随机交错：两个进程的新建、改归、改名、删、换作用域同时发起，做完不维护索引就对得上', async () => {
  let placedInTopic = 0
  await fc.assert(fc.asyncProperty(fc.array(fc.array(stepArb, { minLength: 1, maxLength: 4 }), { minLength: 2, maxLength: 5 }), async (waves) => {
    for (const journal of journals.splice(0)) journal.close()
    await rm(root, { recursive: true, force: true })
    const a = open()
    const b = open()
    await seed(a.table)
    let revision = 0
    /** 这条记忆现在在哪：全局或项目，按磁盘找。 */
    const whereIs = async (table: FileTable, id: string): Promise<LocateTarget | undefined> =>
      (await table.locate(id, G))?.record.scope === 'global' ? G : (await table.locate(id, W)) !== undefined ? W : undefined
    const run = async (table: FileTable, step: Step): Promise<void> => {
      const at = await whereIs(table, step.id)
      switch (step.kind) {
        case 'create':
          if (at === undefined) await createWith(table, record({ id: step.id, name: `记忆 ${step.id}`, summary: `${step.id} 的摘要` }), step.topic === undefined ? undefined : choose(step.topic)).catch(() => {})
          return
        case 'move-topic':
          if (at !== undefined) await updateWith(table, step.id, at, r => ({ ...r, content: `${r.content}+` }), choose(step.topic)).catch(() => {})
          return
        case 'retitle':
          if (at !== undefined) await table.update(step.id, at, r => ({ ...r, name: `记忆 ${step.id} 第 ${++revision} 版`, summary: `第 ${revision} 版摘要` })).catch(() => {})
          return
        case 'edit-content':
          if (at !== undefined) await table.update(step.id, at, r => ({ ...r, content: `${r.content}。` })).catch(() => {})
          return
        case 'soft-delete':
          if (at !== undefined) await table.update(step.id, at, r => ({ ...r, status: 'deleted' })).catch(() => {})
          return
        case 'hard-delete':
          if (at !== undefined) await table.delete(step.id, at).catch(() => {})
          return
        case 'switch-scope': {
          if (at === undefined) return
          const to = (r: MemoryRecord): MemoryRecord => {
            const { workspacePath: _from, ...rest } = r
            return at === G ? { ...rest, scope: 'workspace', workspacePath: WS } : { ...rest, scope: 'global' }
          }
          await updateWith(table, step.id, at, to, step.isCarried ? { kind: 'carry' } : undefined).catch(() => {})
        }
      }
    }
    // 一波里的几步同时发起，单双号分给两个进程
    for (const wave of waves) await Promise.all(wave.map((step, i) => run(i % 2 === 0 ? a.table : b.table, step)))
    const where = { ...(await placement(gdir())), ...(await placement(wdir())) }
    // 只数随机步骤动过的那几条（种子里放进主题的 mem_1、mem_w 不算）
    placedInTopic += Object.entries(where).filter(([id, pages]) => id !== 'mem_1' && IDS.includes(id) && pages.some(p => p !== UNSORTED_TITLE)).length
    await expectSettled(a.table, a.journal, JSON.stringify(waves))
    expect(b.journal.hasPending()).toBe(false)
  }), { seed: interleaveSeed(), numRuns: interleaveRuns(15) })
  // 生成的序列里确实有归进主题的，不是全落在「未整理」
  expect(placedInTopic).toBeGreaterThan(0)
}, 120_000)
