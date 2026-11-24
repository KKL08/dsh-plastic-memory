import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable, type IndexOpOutcome } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { readIndexFiles } from '../src/storage/index-store.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { UNSORTED_TITLE, readIndex, stampOf } from '../src/topic-index.ts'
import type { IndexOp, IndexPlan } from '../src/topic-ops.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { indexReceiptStep, ledgerSteps } from '../src/governance/op-steps.ts'
import type { PendingDecision } from '../src/governance/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'

// 索引操作落盘和中途退出：真文件、真操作日志、真写锁。在进程边界（node:fs/promises 的写调用）注入「进程没了」，
// 然后换一个新实例进一次写入段，看补做的结果。

const fault = vi.hoisted(() => ({ remaining: Number.POSITIVE_INFINITY, isDead: false, calls: 0 }))
class Crash extends Error {}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writes = new Set(['appendFile', 'copyFile', 'cp', 'link', 'mkdir', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'])
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && writes.has(key)
    ? async (...args: unknown[]) => {
        if (key === 'mkdir' && /[\\/]\.state[\\/]lock$/.test(String(args[0]))) return (value as (...a: unknown[]) => Promise<unknown>)(...args)
        if (fault.isDead || fault.remaining <= 0) {
          fault.isDead = true
          throw new Crash(`进程在 ${key} 之前退出`)
        }
        fault.remaining--
        fault.calls++
        return (value as (...a: unknown[]) => Promise<unknown>)(...args)
      }
    : value]))
})

const quiet = { info() {}, warn() {}, error() {} }
const global = { kind: 'global' } as const
const STEP = 'test-receipt'
const OPTS = { maxTopics: 30 }

let root: string
let journalDir: string
const journals: OpJournal[] = []
beforeEach(async () => {
  fault.remaining = Number.POSITIVE_INFINITY
  fault.isDead = false
  root = await mkdtemp(join(tmpdir(), 'pm-index-ops-root-'))
  journalDir = await mkdtemp(join(tmpdir(), 'pm-index-ops-journal-'))
})
afterEach(async () => {
  fault.remaining = Number.POSITIVE_INFINITY
  fault.isDead = false
  for (const journal of journals.splice(0)) journal.close()
  await rm(root, { recursive: true, force: true })
  await rm(journalDir, { recursive: true, force: true })
})

/** 一个「进程」：自己的锁、自己的日志连接、自己的步骤记录。 */
function open(opts: { journal?: boolean } = {}) {
  const journal = opts.journal === false ? undefined : new OpJournal({ path: join(journalDir, 'op-journal.sqlite'), log: quiet })
  if (journal !== undefined) journals.push(journal)
  const ran: string[] = []
  const table = new FileTable({
    root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }),
    ...(journal === undefined ? {} : { journal }),
  })
  table.registerStep(STEP, async (_step, ctx) => { ran.push(ctx.op) })
  return { table, journal, ran }
}

const dir = () => join(root, 'global')
const IDS = ['mem_a', 'mem_b', 'mem_c', 'mem_d']
const applied = (r: IndexOpOutcome) => {
  if (r.kind !== 'applied') throw new Error(`预期做成，实际跳过：${r.reason}`)
  return r
}

/** 四条记忆；「甲类」主题里是 a、b，「乙类」里是 c，d 在「未整理」。入口里甲类在前。 */
async function seed() {
  const { table } = open({ journal: false })
  for (const [id, name] of [['mem_a', '发版步骤'], ['mem_b', '打 tag'], ['mem_c', '回复语言'], ['mem_d', '写锁设计'], ['mem_other', '旁观']] as const) {
    await table.create(record({ id, name, summary: `${name}的摘要`, content: `${name}的正文` }))
  }
  await table.maintain([dir()])
  applied(await table.applyIndexOp(dir(), { kind: 'assign', memoryIds: ['mem_a', 'mem_b'], from: UNSORTED_TITLE, to: '甲类', about: '甲类的说明。' }, OPTS))
  applied(await table.applyIndexOp(dir(), { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: '乙类', about: '乙类的说明。' }, OPTS))
}

/** 每条记忆在哪几页（主题名）。 */
async function placement(): Promise<Record<string, string[]>> {
  const files = (await readIndexFiles(dir()))!
  const { topics, unsorted } = readIndex(files)
  const where: Record<string, string[]> = Object.fromEntries(IDS.map(id => [id, []]))
  for (const t of topics) for (const id of t.memberIds) where[id]?.push(t.name)
  for (const id of unsorted) where[id]?.push(UNSORTED_TITLE)
  return where
}
const snapshot = async () => JSON.stringify(await readIndexFiles(dir()))

/** 新实例进一次写入段（改一条不相干的记忆），触发补做。 */
async function recover() {
  const next = open()
  await next.table.update('mem_other', global, r => ({ ...r, content: `${r.content}。` }))
  return next
}

describe('索引操作落盘', () => {
  it('做一个操作：目标页带上这次操作的提交标记，别的页跟着改，提交后的步骤做一次，日志里不留行', async () => {
    await seed()
    const { table, journal, ran } = open()
    const r = applied(await table.applyIndexOp(dir(), { kind: 'assign', memoryIds: ['mem_d'], from: UNSORTED_TITLE, to: '乙类' }, { ...OPTS, prepare: async () => [{ kind: STEP }] }))
    expect(await placement()).toEqual({ mem_a: ['甲类'], mem_b: ['甲类'], mem_c: ['乙类'], mem_d: ['乙类'] })
    const files = (await readIndexFiles(dir()))!
    expect(stampOf(files.pages['乙类.md']!)).toBe(r.op)
    expect(ran).toEqual([r.op])
    expect(journal!.hasPending()).toBe(false)
  })

  it('对不上的跳过，什么都不写：记忆不在说的主题里、主题不在了', async () => {
    await seed()
    const { table, journal } = open()
    const before = await snapshot()
    expect(await table.applyIndexOp(dir(), { kind: 'assign', memoryIds: ['mem_d'], from: '甲类', to: '乙类' }, OPTS)).toMatchObject({ kind: 'skipped' })
    expect(await table.applyIndexOp(dir(), { kind: 'rename', topic: '没有的', name: '新名' }, OPTS)).toMatchObject({ kind: 'skipped' })
    expect(await snapshot()).toBe(before)
    expect(journal!.hasPending()).toBe(false)
  })

  it('模型交来的主题名和说明里带着密钥：落盘前遮掉', async () => {
    await seed()
    const { table } = open()
    const secret = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(5)
    applied(await table.applyIndexOp(dir(), { kind: 'describe', topic: '甲类', about: `部署用的 key 是 ${secret}` }, OPTS))
    expect(await snapshot()).not.toContain(secret)
  })

  it('主题页里手写的曾用名带着密钥：做操作时返回的计划里没有它，也没有记忆的名称和摘要', async () => {
    await seed()
    const { table } = open()
    const secret = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(5)
    const path = join(dir(), '_index', 'topics', '甲类.md')
    await writeFile(path, (await readFile(path, 'utf8')).replace('# 甲类\n', `# 甲类\n\n曾用名：${secret}\n`))
    const merged = applied(await table.applyIndexOp(dir(), { kind: 'merge', from: ['甲类'], into: '乙类' }, OPTS))
    expect(JSON.stringify(merged.plan)).not.toContain(secret)
    expect(JSON.stringify(merged.plan)).not.toMatch(/的摘要|发版步骤|打 tag|回复语言/)
    expect(await snapshot()).not.toContain(secret)
    // 照着这份计划照样撤得回去
    expect(await table.undoIndexPlan(dir(), merged.plan)).toMatchObject({ kind: 'undone' })
    expect(await placement()).toEqual(BEFORE)
  })

  it('撤销：回到做之前的样子（提交标记除外），再撤一次说撤不了', async () => {
    await seed()
    const { table, journal } = open()
    const before = await placement()
    const merged = applied(await table.applyIndexOp(dir(), { kind: 'merge', from: ['甲类'], into: '乙类', about: '合在一起。' }, OPTS))
    expect(await placement()).toEqual({ mem_a: ['乙类'], mem_b: ['乙类'], mem_c: ['乙类'], mem_d: [UNSORTED_TITLE] })
    expect(await table.undoIndexPlan(dir(), merged.plan)).toMatchObject({ kind: 'undone' })
    expect(await placement()).toEqual(before)
    const files = (await readIndexFiles(dir()))!
    expect(readIndex(files).topics.map(t => [t.name, t.about, t.aliases])).toEqual([['甲类', '甲类的说明。', []], ['乙类', '乙类的说明。', []]])
    expect(await table.undoIndexPlan(dir(), merged.plan)).toMatchObject({ kind: 'stale' })
    expect(journal!.hasPending()).toBe(false)
  })

  it('没有操作日志（写锁退回进程内保护时）照样能做、能撤', async () => {
    await seed()
    const { table } = open({ journal: false })
    const r = applied(await table.applyIndexOp(dir(), { kind: 'rename', topic: '甲类', name: '甲类新名' }, OPTS))
    expect((await placement()).mem_a).toEqual(['甲类新名'])
    expect(await table.undoIndexPlan(dir(), r.plan)).toMatchObject({ kind: 'undone' })
    expect((await placement()).mem_a).toEqual(['甲类'])
  })
})

interface Scenario { name: string; op: IndexOp; after: Record<string, string[]> }
const BEFORE = { mem_a: ['甲类'], mem_b: ['甲类'], mem_c: ['乙类'], mem_d: [UNSORTED_TITLE] }
const scenarios: Scenario[] = [
  // 源页（甲类）在入口里排在目标页（乙类）前面：只靠整份核对去重的话，留下的会是源页那一行
  { name: '归到现有主题', op: { kind: 'assign', memoryIds: ['mem_a'], from: '甲类', to: '乙类' }, after: { ...BEFORE, mem_a: ['乙类'] } },
  { name: '归到新主题（拆分）', op: { kind: 'assign', memoryIds: ['mem_b'], from: '甲类', to: '丙类', about: '拆出来的。' }, after: { ...BEFORE, mem_b: ['丙类'] } },
  { name: '合并', op: { kind: 'merge', from: ['甲类'], into: '乙类' }, after: { mem_a: ['乙类'], mem_b: ['乙类'], mem_c: ['乙类'], mem_d: [UNSORTED_TITLE] } },
  { name: '改名', op: { kind: 'rename', topic: '甲类', name: '甲类新名' }, after: { ...BEFORE, mem_a: ['甲类新名'], mem_b: ['甲类新名'] } },
]

describe('索引操作中途进程退出后的补做', () => {
  for (const s of scenarios) {
    it(`${s.name}：每一个写调用之前退出，补做后要么没发生、要么整个做完，成员只在一个主题里；做成了的提交后的步骤补一次`, async () => {
      await seed()
      const dry = open()
      fault.calls = 0
      applied(await dry.table.applyIndexOp(dir(), s.op, { ...OPTS, prepare: async () => [{ kind: STEP }] }))
      const total = fault.calls
      expect(total).toBeGreaterThan(1)
      expect(await placement()).toEqual(s.after)
      const doneShape = readIndex((await readIndexFiles(dir()))!).topics.map(t => [t.name, t.about, t.aliases])

      for (let k = 0; k < total; k++) {
        await rm(root, { recursive: true, force: true })
        await rm(journalDir, { recursive: true, force: true })
        root = await mkdtemp(join(tmpdir(), 'pm-index-ops-root-'))
        journalDir = await mkdtemp(join(tmpdir(), 'pm-index-ops-journal-'))
        await seed()
        const untouched = await snapshot()
        const crashed = open()
        fault.remaining = k
        await crashed.table.applyIndexOp(dir(), s.op, { ...OPTS, prepare: async () => [{ kind: STEP }] }).catch(() => {})
        fault.remaining = Number.POSITIVE_INFINITY
        fault.isDead = false
        const midway = await snapshot()
        // 留在日志里的行只带记忆 id，不带名称、摘要、正文
        expect(JSON.stringify(crashed.journal!.pending()), `第 ${k} 次写之前退出`).not.toMatch(/的摘要|的正文|发版步骤|打 tag|回复语言/)
        const next = await recover()
        const where = await placement()
        if (midway === untouched) {
          expect(where, `第 ${k} 次写之前退出`).toEqual(BEFORE)
          expect(next.ran).toEqual([])
        } else {
          expect(where, `第 ${k} 次写之前退出`).toEqual(s.after)
          expect(readIndex((await readIndexFiles(dir()))!).topics.map(t => [t.name, t.about, t.aliases]), `第 ${k} 次写之前退出`).toEqual(doneShape)
          expect(next.ran.length + crashed.ran.length, `第 ${k} 次写之前退出`).toBe(1)
        }
        expect(next.journal!.hasPending()).toBe(false)
      }
    })
  }

  it('提交之后目标页又被后来的操作写上新标记，前一个操作没补完的步骤照样补（记着已经提交，不再看标记）', async () => {
    // 找到「刚写完目标页就退出」的那个点：成员同时在两页里
    let isHalfway = false
    for (let k = 0; k < 20 && !isHalfway; k++) {
      await rm(root, { recursive: true, force: true })
      await rm(journalDir, { recursive: true, force: true })
      root = await mkdtemp(join(tmpdir(), 'pm-index-ops-root-'))
      journalDir = await mkdtemp(join(tmpdir(), 'pm-index-ops-journal-'))
      await seed()
      const first = open()
      fault.remaining = k
      await first.table.applyIndexOp(dir(), { kind: 'assign', memoryIds: ['mem_a'], from: '甲类', to: '乙类' }, OPTS).catch(() => {})
      fault.remaining = Number.POSITIVE_INFINITY
      fault.isDead = false
      isHalfway = (await placement()).mem_a!.length === 2
    }
    expect(isHalfway).toBe(true)
    // 提交了、还没补完的操作查得到：整理收尾时据此留着它的回执
    const pendingOp = open().journal!.pending()[0]!.op
    expect(open().table.isOpPending(pendingOp)).toBe(true)
    // 目标页的提交标记被别的东西换掉（后来的操作写的）
    const path = join(dir(), '_index', 'topics', '乙类.md')
    await writeFile(path, (await readFile(path, 'utf8')).replace(/lastWriteOp: \S+/, 'lastWriteOp: op_later'))
    const next = await recover()
    expect((await placement()).mem_a).toEqual(['乙类'])
    expect(next.journal!.hasPending()).toBe(false)
    expect(next.table.isOpPending(pendingOp)).toBe(false)
  })

  it('撤销中途退出：补做后要么没撤、要么撤完，每条记忆只在一个主题里', async () => {
    const run = async (table: FileTable, plan: IndexPlan) => table.undoIndexPlan(dir(), plan)
    await seed()
    const dry = open()
    const merged = applied(await dry.table.applyIndexOp(dir(), { kind: 'merge', from: ['甲类'], into: '乙类' }, OPTS))
    fault.calls = 0
    await run(dry.table, merged.plan)
    const total = fault.calls
    expect(await placement()).toEqual(BEFORE)
    for (let k = 0; k < total; k++) {
      await rm(root, { recursive: true, force: true })
      await rm(journalDir, { recursive: true, force: true })
      root = await mkdtemp(join(tmpdir(), 'pm-index-ops-root-'))
      journalDir = await mkdtemp(join(tmpdir(), 'pm-index-ops-journal-'))
      await seed()
      const setup = open()
      const plan = applied(await setup.table.applyIndexOp(dir(), { kind: 'merge', from: ['甲类'], into: '乙类' }, OPTS)).plan
      const mergedState = await snapshot()
      fault.remaining = k
      await run(setup.table, plan).catch(() => {})
      fault.remaining = Number.POSITIVE_INFINITY
      fault.isDead = false
      const midway = await snapshot()
      expect(JSON.stringify(setup.journal!.pending()), `第 ${k} 次写之前退出`).not.toMatch(/的摘要|的正文|发版步骤|打 tag|回复语言/)
      const next = await recover()
      const where = await placement()
      if (midway === mergedState) expect(where, `第 ${k} 次写之前退出`).toEqual({ mem_a: ['乙类'], mem_b: ['乙类'], mem_c: ['乙类'], mem_d: [UNSORTED_TITLE] })
      else expect(where, `第 ${k} 次写之前退出`).toEqual(BEFORE)
      expect(next.journal!.hasPending()).toBe(false)
    }
  })

  describe('撤销写完第一个文件就退出，补做之前索引又被人手改过', () => {
    /** 合并甲类到乙类，再撤销；停在「甲类那一页已经放回来、乙类还没清」的地方。 */
    async function halfUndone() {
      for (let k = 0; k < 20; k++) {
        await rm(root, { recursive: true, force: true })
        await rm(journalDir, { recursive: true, force: true })
        root = await mkdtemp(join(tmpdir(), 'pm-index-ops-root-'))
        journalDir = await mkdtemp(join(tmpdir(), 'pm-index-ops-journal-'))
        await seed()
        const setup = open()
        const plan = applied(await setup.table.applyIndexOp(dir(), { kind: 'merge', from: ['甲类'], into: '乙类' }, OPTS)).plan
        fault.remaining = k
        await setup.table.undoIndexPlan(dir(), plan).catch(() => {})
        fault.remaining = Number.POSITIVE_INFINITY
        fault.isDead = false
        if ((await placement()).mem_a!.length === 2) return
      }
      throw new Error('没找到撤销写了一半的那个点')
    }
    const pathOf = (name: string) => join(dir(), '_index', 'topics', `${name}.md`)

    it('没写的那一页多了手写的备注：留着备注，成员照样挪对', async () => {
      await halfUndone()
      await writeFile(pathOf('乙类'), `${await readFile(pathOf('乙类'), 'utf8')}\n刚手写的备注。\n`)
      const next = await recover()
      expect(await placement()).toEqual(BEFORE)
      expect(await readFile(pathOf('乙类'), 'utf8')).toContain('刚手写的备注。')
      expect(next.journal!.hasPending()).toBe(false)
    })

    it('放回来的那一页被改得成员行不算成员了（前面多了没收尾的代码块）：这些记忆留在还没清的那一页', async () => {
      await halfUndone()
      await writeFile(pathOf('甲类'), (await readFile(pathOf('甲类'), 'utf8')).replace('# 甲类\n', '# 甲类\n\n```\n'))
      await recover()
      expect(await placement()).toMatchObject({ mem_a: ['乙类'], mem_b: ['乙类'], mem_c: ['乙类'] })
    })

    it('放回来的那一页又被删了：补做把它再放回来，每条记忆仍只在一个主题里', async () => {
      await halfUndone()
      await rm(pathOf('甲类'))
      await recover()
      expect(await placement()).toEqual(BEFORE)
    })
  })

  it('整理中途退出：已经提交的操作补完后回执是确认过的、照着它能撤；没提交的操作留下的回执收尾时清掉', async () => {
    const ledger = new InMemoryKvTable<PendingDecision>()
    const run = async (k: number) => {
      await rm(root, { recursive: true, force: true })
      await rm(journalDir, { recursive: true, force: true })
      root = await mkdtemp(join(tmpdir(), 'pm-index-ops-root-'))
      journalDir = await mkdtemp(join(tmpdir(), 'pm-index-ops-journal-'))
      await seed()
      const decisions = new PendingDecisionsStore(ledger)
      const entryId = `pd_${k}`
      await decisions.addIndexRun(entryId, { summary: '整理', workspace: 'global' }, 1)
      const crashed = open()
      for (const [kind, handler] of Object.entries(ledgerSteps(decisions, quiet))) crashed.table.registerStep(kind, handler)
      fault.remaining = k
      await crashed.table.applyIndexOp(dir(), { kind: 'merge', from: ['甲类'], into: '乙类' }, {
        ...OPTS,
        prepare: async (op, plan) => { await decisions.appendIndexReceipt(entryId, { op, plan }); return [indexReceiptStep(entryId)] },
      }).catch(() => {})
      fault.remaining = Number.POSITIVE_INFINITY
      fault.isDead = false
      const isCommitted = (await placement()).mem_a!.includes('乙类')
      // 新实例：登记同样的处理器，进一次写入段
      const next = open()
      for (const [kind, handler] of Object.entries(ledgerSteps(decisions, quiet))) next.table.registerStep(kind, handler)
      await next.table.update('mem_other', global, r => ({ ...r, content: `${r.content}。` }))
      const entry = (await decisions.listSettled()).find(e => e.id === entryId)!
      return { decisions, entryId, entry, isCommitted, next }
    }
    let sawCommitted = false
    let sawUncommitted = false
    for (let k = 0; k < 12; k++) {
      const { decisions, entryId, entry, isCommitted, next } = await run(k)
      expect(entry.indexRun!.receipts.map(r => r.isConfirmed === true), `第 ${k} 次写之前退出`).toEqual([isCommitted])
      const left = await decisions.finishIndexRun(entryId)
      if (isCommitted) {
        sawCommitted = true
        expect(await placement()).toEqual({ mem_a: ['乙类'], mem_b: ['乙类'], mem_c: ['乙类'], mem_d: [UNSORTED_TITLE] })
        expect(await next.table.undoIndexPlan(dir(), left!.indexRun!.receipts[0]!.plan)).toMatchObject({ kind: 'undone' })
        expect(await placement()).toEqual(BEFORE)
      } else {
        sawUncommitted = true
        expect(left).toBeUndefined()
        expect(await placement()).toEqual(BEFORE)
      }
    }
    expect([sawCommitted, sawUncommitted]).toEqual([true, true])
  })
})
