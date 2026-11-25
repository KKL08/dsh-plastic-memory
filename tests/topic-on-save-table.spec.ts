import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { FileTable, INDEX_ROW_STEP, type IndexRowStep } from '../src/storage/file-table.ts'
import { DerivedIndex } from '../src/storage/derived-index.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { GLOBAL_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { INDEX_DIR, INDEX_ENTRY_FILE, INDEX_TOPICS_DIR, readIndexFiles } from '../src/storage/index-store.ts'
import { newWriteOp, type LocateTarget, type TopicIntent, type WriteOp } from '../src/storage/table.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { ENTRY_TITLE, UNSORTED_TITLE, createdAtOf } from '../src/topic-index.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { indexText, indexTree, isIndexPath } from './helpers/topic-index.ts'
import { applied, entryOf, expectedRow, membersOf, placement, rowOf } from './helpers/topic-placement.ts'

// 记忆写入之后改它在主题索引里的那一行：真文件、真操作日志、真写锁。
// 在进程边界（node:fs/promises）记下读写调用，必要时在读完某个文件之后插一次「用户手改」。

const io = vi.hoisted(() => ({
  recording: false,
  calls: [] as string[],
  /** 读完一个文件之后调用一次（拿到路径），用来模拟读到之后、写之前别处改了文件；调用后自动清掉。 */
  afterRead: undefined as ((path: string) => Promise<boolean>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writes = new Set(['appendFile', 'copyFile', 'cp', 'link', 'mkdir', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'])
  const reads = new Set(['readFile', 'readdir', 'stat', 'lstat', 'open'])
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && (writes.has(key) || reads.has(key))
    ? async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>)(...args)
        if (io.recording && !(key === 'mkdir' && /[\\/]\.state[\\/]lock$/.test(String(args[0])))) io.calls.push(`${key}(${String(args[0])})`)
        if (key === 'readFile' && io.afterRead !== undefined) {
          const hook = io.afterRead
          if (await hook(String(args[0]))) io.afterRead = undefined
        }
        return result
      }
    : value]))
})

const quiet = { info() {}, warn() {}, error() {} }
const G = { kind: 'global' } as const
const WS = '/tmp/pm-topic-on-save-ws'
const W = { kind: 'workspace', workspacePath: WS } as const

let root: string
let journalDir: string
const journals: OpJournal[] = []
beforeEach(async () => {
  io.recording = false
  io.calls = []
  io.afterRead = undefined
  root = await mkdtemp(join(tmpdir(), 'pm-topic-save-'))
  journalDir = await mkdtemp(join(tmpdir(), 'pm-topic-save-journal-'))
})
afterEach(async () => {
  io.afterRead = undefined
  for (const journal of journals.splice(0)) journal.close()
  await rm(root, { recursive: true, force: true })
  await rm(journalDir, { recursive: true, force: true })
})

/** 一个「进程」：自己的锁、自己的日志连接。 */
function open() {
  const journal = new OpJournal({ path: join(journalDir, 'op-journal.sqlite'), log: quiet })
  journals.push(journal)
  const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }), journal })
  return { table, journal }
}

const gdir = () => join(root, GLOBAL_DIR)
const wdir = () => join(root, workspaceDirName(WS))
const choose = (name: string, opts: { about?: string; maxTopics?: number } = {}): TopicIntent => ({ kind: 'choose', name, ...(opts.about !== undefined ? { about: opts.about } : {}), maxTopics: opts.maxTopics ?? 30 })
const opWith = (topic: TopicIntent) => newWriteOp({ topic })

/** 带着 op 写，写完把它结掉（调用方给的 op 由调用方 finishOp）。 */
async function createWith(table: FileTable, r: MemoryRecord, op?: WriteOp) {
  await table.create(r, op)
  if (op !== undefined) await table.finishOp(op, r)
}
async function updateWith(table: FileTable, id: string, at: LocateTarget, fn: (r: MemoryRecord) => MemoryRecord, op?: WriteOp) {
  const written = await table.update(id, at, fn, op)
  if (op !== undefined) await table.finishOp(op, written)
  return written
}

/**
 * 全局目录：mem_a 在「上线」（曾用名「发版」），mem_b 在「回复语言」，mem_c 在「Deploy」，mem_d 在「未整理」。
 * 入口里三个主题按这个先后。
 */
async function seedGlobal(table: FileTable) {
  for (const [id, name] of [['mem_a', '发版步骤'], ['mem_b', '回复用中文'], ['mem_c', 'deploy steps'], ['mem_d', '写锁设计']] as const) {
    await table.create(record({ id, name, summary: `${name}的摘要`, content: `${name}的正文` }))
  }
  await table.maintain([gdir()])
  await applied(table, gdir(), { kind: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '发版', about: '发版的说明。' })
  await applied(table, gdir(), { kind: 'rename', topic: '发版', name: '上线' })
  await applied(table, gdir(), { kind: 'assign', memoryIds: ['mem_b'], from: UNSORTED_TITLE, to: '回复语言' })
  await applied(table, gdir(), { kind: 'assign', memoryIds: ['mem_c'], from: UNSORTED_TITLE, to: 'Deploy' })
}

/** 一页的文件名（按主题名找）。 */
async function pageFile(dir: string, topic: string): Promise<string> {
  const files = (await readIndexFiles(dir))!
  const hit = Object.entries(files.pages).find(([, text]) => text.startsWith(`# ${topic}\n`) || new RegExp(`^---[\\s\\S]*?---\\r?\\n# ${topic}\\n`).test(text))
  expect(hit, `应有主题页「${topic}」`).toBeDefined()
  return join(dir, INDEX_DIR, INDEX_TOPICS_DIR, hit![0])
}

describe('保存时给了主题', () => {
  it('给现有主题：名字或曾用名都认，去首尾空白、不分大小写；插到那一页最前，别处没有它，入口不动', async () => {
    const { table } = open()
    await seedGlobal(table)
    const entryBefore = await entryOf(gdir())
    await createWith(table, record({ id: 'mem_n', name: '新的发版约定', summary: '新的摘要' }), opWith(choose('  发版 ')))
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_n', 'mem_a'])
    expect((await placement(gdir())).mem_n).toEqual(['上线'])
    expect(await rowOf(gdir(), 'mem_n')).toBe(await expectedRow(table, 'mem_n', G))
    await createWith(table, record({ id: 'mem_m', name: '另一条' }), opWith(choose('DEPLOY')))
    expect(await membersOf(gdir(), 'Deploy')).toEqual(['mem_m', 'mem_c'])
    expect((await placement(gdir())).mem_m).toEqual(['Deploy'])
    expect(await entryOf(gdir())).toEqual(entryBefore)
  })

  it('给的主题还没有：建出主题页、入口最后加一节带说明；这条是新页唯一的一行', async () => {
    const { table } = open()
    await seedGlobal(table)
    await createWith(table, record({ id: 'mem_n', name: '锁的超时' }), opWith(choose('写锁', { about: '写锁怎么设计的。' })))
    const entry = await entryOf(gdir())
    expect(entry.map(t => t.name)).toEqual(['上线', '回复语言', 'Deploy', '写锁'])
    expect(entry.at(-1)).toEqual({ name: '写锁', about: '写锁怎么设计的。' })
    expect(await membersOf(gdir(), '写锁')).toEqual(['mem_n'])
    expect((await placement(gdir())).mem_n).toEqual(['写锁'])
  })

  it('新主题的说明带换行折成一行；折完以标题记号或代码围栏开头就不写说明，主题照样建', async () => {
    const { table } = open()
    await seedGlobal(table)
    await createWith(table, record({ id: 'mem_1' }), opWith(choose('甲', { about: '第一行\n\n第二行\n' })))
    await createWith(table, record({ id: 'mem_2' }), opWith(choose('乙', { about: '# 标题\n正文' })))
    await createWith(table, record({ id: 'mem_3' }), opWith(choose('丙', { about: '```js\nx\n```' })))
    const about = Object.fromEntries((await entryOf(gdir())).map(t => [t.name, t.about]))
    expect(about).toMatchObject({ 甲: '第一行 第二行', 乙: '', 丙: '' })
    expect(await membersOf(gdir(), '乙')).toEqual(['mem_2'])
    expect(await membersOf(gdir(), '丙')).toEqual(['mem_3'])
  })

  it('主题数到上限、名字不能用：不建页，这条进「未整理」最前', async () => {
    const { table } = open()
    await seedGlobal(table)
    const entryBefore = await entryOf(gdir())
    await createWith(table, record({ id: 'mem_full' }), opWith(choose('新主题', { about: '说明。', maxTopics: 3 })))
    expect(await membersOf(gdir(), UNSORTED_TITLE)).toEqual(['mem_full', 'mem_d'])
    await createWith(table, record({ id: 'mem_bad' }), opWith(choose('甲、乙')))
    expect(await membersOf(gdir(), UNSORTED_TITLE)).toEqual(['mem_bad', 'mem_full', 'mem_d'])
    expect((await placement(gdir())).mem_bad).toEqual([UNSORTED_TITLE])
    expect(await entryOf(gdir())).toEqual(entryBefore)
    expect(Object.keys((await readIndexFiles(gdir()))!.pages)).toHaveLength(4)
  })

  it('带主题的 update：把这条挪到该主题最前，原来那页不留它；给的主题用不了就留在原来那页', async () => {
    const { table } = open()
    await seedGlobal(table)
    await updateWith(table, 'mem_b', G, r => ({ ...r, content: '改过的正文' }), opWith(choose('上线')))
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_b', 'mem_a'])
    expect((await placement(gdir())).mem_b).toEqual(['上线'])
    // 排在第二位的那条带着用不了的主题更新：留在原位，不挪到最前
    await updateWith(table, 'mem_a', G, r => ({ ...r, content: '又改了一次' }), opWith(choose('# 坏名字')))
    expect((await placement(gdir())).mem_a).toEqual(['上线'])
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_b', 'mem_a'])
  })
})

describe('保存时给了主题：边界', () => {
  it('入口里还没有这一节的主题页（建到一半）：照样归进去，并把入口那一节和说明补上', async () => {
    const { table } = open()
    await seedGlobal(table)
    await writeFile(join(gdir(), INDEX_DIR, INDEX_TOPICS_DIR, '写锁.md'), '# 写锁\n\n')
    await createWith(table, record({ id: 'mem_n' }), opWith(choose('写锁', { about: '写锁怎么设计的。' })))
    expect(await membersOf(gdir(), '写锁')).toEqual(['mem_n'])
    expect((await entryOf(gdir())).filter(t => t.name === '写锁')).toEqual([{ name: '写锁', about: '写锁怎么设计的。' }])
  })

  it('新建的主题页带建立时刻，派生库记下这条在哪一页', async () => {
    const derived = new DerivedIndex({ path: join(journalDir, 'derived-index.sqlite'), log: quiet })
    const journal = new OpJournal({ path: join(journalDir, 'op-journal.sqlite'), log: quiet })
    journals.push(journal)
    const at = 1_800_000_000_000
    const table = new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }), journal, index: derived, now: () => at })
    try {
      await seedGlobal(table)
      await createWith(table, record({ id: 'mem_n' }), opWith(choose('写锁')))
      const page = await pageFile(gdir(), '写锁')
      expect(createdAtOf(await readFile(page, 'utf8'))).toBe(at)
      expect(derived.pagesOf(gdir(), 'mem_n')).toEqual([basename(page)])
      // 换到项目：原目录那一页在派生库里也不再有它
      await updateWith(table, 'mem_n', G, r => ({ ...r, scope: 'workspace', workspacePath: WS }), newWriteOp({ topic: { kind: 'carry' } }))
      expect(derived.pagesOf(gdir(), 'mem_n')).toEqual([])
    } finally {
      derived.close()
    }
  })

  it('目标页被手改成标题下面就是没闭合的代码围栏：放进去认不出来的这条不从索引里丢掉，恰好在一页里', async () => {
    const { table } = open()
    await seedGlobal(table)
    await createWith(table, record({ id: 'mem_n' }), opWith(choose('上线')))
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_n', 'mem_a'])
    const page = await pageFile(gdir(), '回复语言')
    await writeFile(page, '# 回复语言\n\n```\n')
    await updateWith(table, 'mem_d', G, r => ({ ...r, content: '改了正文' }), opWith(choose('回复语言')))
    expect((await placement(gdir())).mem_d).toHaveLength(1)
  })

  it('写回的内容和磁盘上一样、只带了主题：照样挪过去', async () => {
    const { table } = open()
    await seedGlobal(table)
    await updateWith(table, 'mem_b', G, r => r, opWith(choose('上线')))
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_b', 'mem_a'])
  })

  it('同一次写入的另一步失败、整行补做时，带过去的主题不被打回「未整理」', async () => {
    let isBroken = true
    const flaky = async () => { if (isBroken) throw new Error('这一步暂时做不成') }
    const first = open()
    first.table.registerStep('test-flaky', flaky)
    await seedGlobal(first.table)
    await first.table.create(record({ id: 'mem_w1', scope: 'workspace', workspacePath: WS }))
    await first.table.maintain([wdir()])
    await applied(first.table, wdir(), { kind: 'assign', memoryIds: ['mem_w1'], from: UNSORTED_TITLE, to: '上线' })
    const op = newWriteOp({ topic: { kind: 'carry' }, steps: [{ kind: 'test-flaky' }] })
    const written = await first.table.update('mem_a', G, r => ({ ...r, scope: 'workspace', workspacePath: WS }), op)
    await first.table.finishOp(op, written).catch(() => {})
    expect(await membersOf(wdir(), '上线')).toEqual(['mem_a', 'mem_w1'])
    expect(first.journal.pending().map(p => p.op)).toContain(op.id)
    isBroken = false
    const next = open()
    next.table.registerStep('test-flaky', flaky)
    await next.table.update('mem_d', G, r => ({ ...r, content: `${r.content}。` }))
    expect(next.journal.hasPending()).toBe(false)
    expect(await membersOf(wdir(), '上线')).toEqual(['mem_a', 'mem_w1'])
    expect((await placement(wdir())).mem_a).toEqual(['上线'])
  })
})

describe('没给主题的写入', () => {
  it('新建：进「未整理」最前，不用等维护；行和磁盘上的文件对得上', async () => {
    const { table } = open()
    await seedGlobal(table)
    await table.create(record({ id: 'mem_n', name: '新记忆', summary: '新摘要' }))
    expect(await membersOf(gdir(), UNSORTED_TITLE)).toEqual(['mem_n', 'mem_d'])
    expect(await rowOf(gdir(), 'mem_n')).toBe(await expectedRow(table, 'mem_n', G))
  })

  it('目录里还没有索引：带主题的写入建出索引；不带主题的不建，维护时再补进「未整理」', async () => {
    const { table } = open()
    await createWith(table, record({ id: 'mem_t', scope: 'global' }), opWith(choose('发版', { about: '说明。' })))
    expect(await placement(gdir())).toEqual({ mem_t: ['发版'] })
    expect(await entryOf(gdir())).toEqual([{ name: '发版', about: '说明。' }])
    expect((await readIndexFiles(gdir()))!.entry.startsWith(`# ${ENTRY_TITLE}\n`)).toBe(true)
    // 不带主题、主题名不能用、主题数到上限：都不在没有索引的目录里建索引
    await table.create(record({ id: 'mem_w', scope: 'workspace', workspacePath: WS }))
    await createWith(table, record({ id: 'mem_w2', scope: 'workspace', workspacePath: WS }), opWith(choose('甲、乙')))
    await createWith(table, record({ id: 'mem_w3', scope: 'workspace', workspacePath: WS }), opWith(choose('满了', { maxTopics: 0 })))
    expect(await table.locate('mem_w3', W)).toBeDefined()
    expect(await indexTree(wdir())).toBeUndefined()
    // 有了索引、还没有「未整理」页：不带主题的新建建出这一页，放在最前
    await table.create(record({ id: 'mem_g', scope: 'global' }))
    expect(await membersOf(gdir(), UNSORTED_TITLE)).toEqual(['mem_g'])
    await table.maintain([gdir()])
    expect(await placement(gdir())).toEqual({ mem_t: ['发版'], mem_g: [UNSORTED_TITLE] })
  })

  it('改名、改摘要、换了文件名：行在原位同步，那一页其余文字不动', async () => {
    const { table } = open()
    await seedGlobal(table)
    await createWith(table, record({ id: 'mem_n', name: '第二条' }), opWith(choose('上线')))
    const page = await pageFile(gdir(), '上线')
    await writeFile(page, `${await readFile(page, 'utf8')}\n手写的备注。\n`)
    const before = await readFile(page, 'utf8')
    const oldRow = (await rowOf(gdir(), 'mem_a'))!
    await table.update('mem_a', G, r => ({ ...r, name: '发版步骤（新）', summary: '改过的摘要' }))
    const newRow = await expectedRow(table, 'mem_a', G)
    expect(newRow).not.toBe(oldRow)
    expect(await rowOf(gdir(), 'mem_a')).toBe(newRow)
    expect(await readFile(page, 'utf8')).toBe(before.replace(oldRow, newRow))
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_n', 'mem_a'])
  })

  it('只改正文、只刷新确认时间、只挂关联：不读也不写索引', async () => {
    const { table } = open()
    await seedGlobal(table)
    await createWith(table, record({ id: 'mem_n' }), opWith(choose('上线')))
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_n', 'mem_a'])
    io.calls = []
    io.recording = true
    await table.update('mem_n', G, r => ({ ...r, content: '只改了正文' }))
    await table.update('mem_n', G, r => ({ ...r, lastConfirmedAt: r.lastConfirmedAt + 1 }))
    await table.update('mem_n', G, r => ({ ...r, related: ['mem_a'] }))
    io.recording = false
    expect(io.calls.some(call => call.includes(`${sep}mem`) || call.includes('.md'))).toBe(true)
    expect(io.calls.filter(call => isIndexPath(call.slice(call.indexOf('(') + 1, -1)))).toEqual([])
  })

  it('软删和彻底删除去掉行', async () => {
    const { table } = open()
    await seedGlobal(table)
    await createWith(table, record({ id: 'mem_n' }), opWith(choose('上线')))
    expect((await placement(gdir())).mem_n).toEqual(['上线'])
    await table.update('mem_n', G, r => ({ ...r, status: 'deleted' }))
    expect((await placement(gdir())).mem_n).toBeUndefined()
    expect((await placement(gdir())).mem_a).toEqual(['上线'])
    await table.delete('mem_b', G)
    expect((await placement(gdir())).mem_b).toBeUndefined()
    expect(await membersOf(gdir(), '回复语言')).toEqual([])
  })

  it('子 agent 存下、还没接受的记录不进索引；接受之后进「未整理」最前', async () => {
    const { table } = open()
    await seedGlobal(table)
    await table.create(record({ id: 'mem_main' }))
    expect(await membersOf(gdir(), UNSORTED_TITLE)).toEqual(['mem_main', 'mem_d'])
    const delegation = { sessionId: 'child', depth: 1, parentSessionId: 'main' }
    await table.create(record({ id: 'mem_p', delegation }))
    expect((await placement(gdir())).mem_p).toBeUndefined()
    await table.update('mem_p', G, r => ({ ...r, delegation: { ...delegation, reviewed: { by: 'main', at: 2 } } }))
    expect(await membersOf(gdir(), UNSORTED_TITLE)).toEqual(['mem_p', 'mem_main', 'mem_d'])
  })
})

describe('换作用域', () => {
  /** 项目目录：mem_w1 在「上线」，mem_w2 在「语言」（曾用名「回复语言」）。 */
  async function seedWorkspace(table: FileTable) {
    await table.create(record({ id: 'mem_w1', scope: 'workspace', workspacePath: WS }))
    await table.create(record({ id: 'mem_w2', scope: 'workspace', workspacePath: WS }))
    await table.maintain([wdir()])
    await applied(table, wdir(), { kind: 'assign', memoryIds: ['mem_w1'], from: UNSORTED_TITLE, to: '上线' })
    await applied(table, wdir(), { kind: 'assign', memoryIds: ['mem_w2'], from: UNSORTED_TITLE, to: '回复语言' })
    await applied(table, wdir(), { kind: 'rename', topic: '回复语言', name: '语言' })
  }
  const toWorkspace = (r: MemoryRecord): MemoryRecord => ({ ...r, scope: 'workspace', workspacePath: WS })

  it('带上原来的主题：目标里有同名主题（含曾用名）就插到最前，原目录不留它', async () => {
    const { table } = open()
    await seedGlobal(table)
    await seedWorkspace(table)
    await updateWith(table, 'mem_a', G, toWorkspace, newWriteOp({ topic: { kind: 'carry' } }))
    expect(await membersOf(wdir(), '上线')).toEqual(['mem_a', 'mem_w1'])
    expect((await placement(gdir())).mem_a).toBeUndefined()
    await updateWith(table, 'mem_b', G, toWorkspace, newWriteOp({ topic: { kind: 'carry' } }))
    expect(await membersOf(wdir(), '语言')).toEqual(['mem_b', 'mem_w2'])
    expect(await rowOf(wdir(), 'mem_b')).toBe(await expectedRow(table, 'mem_b', W))
  })

  it('目标里没有同名主题：进「未整理」最前，不在目标里建主题', async () => {
    const { table } = open()
    await seedGlobal(table)
    await seedWorkspace(table)
    const entryBefore = await entryOf(wdir())
    await updateWith(table, 'mem_c', G, toWorkspace, newWriteOp({ topic: { kind: 'carry' } }))
    expect(await membersOf(wdir(), UNSORTED_TITLE)).toEqual(['mem_c'])
    expect(await entryOf(wdir())).toEqual(entryBefore)
    expect((await placement(gdir())).mem_c).toBeUndefined()
  })

  it('没带主题的换作用域：进目标的「未整理」，原目录不留它', async () => {
    const { table } = open()
    await seedGlobal(table)
    await seedWorkspace(table)
    await table.update('mem_a', G, toWorkspace)
    expect(await membersOf(wdir(), UNSORTED_TITLE)).toEqual(['mem_a'])
    expect((await placement(gdir())).mem_a).toBeUndefined()
  })

  it('同 id 在全局和项目各一份：只动这次写的那一份所在目录的索引', async () => {
    const { table } = open()
    await seedGlobal(table)
    await seedWorkspace(table)
    const located = (await table.locate('mem_d', G))!
    await writeFile(join(wdir(), basename(located.filePath)), encodeRecord({ ...located.record, scope: 'workspace', workspacePath: WS }, {}))
    await table.maintain([wdir()])
    expect((await placement(wdir())).mem_d).toEqual([UNSORTED_TITLE])
    const globalBefore = await indexTree(gdir())
    await updateWith(table, 'mem_d', W, r => ({ ...r, content: '项目里那份改了' }), opWith(choose('上线')))
    expect(await membersOf(wdir(), '上线')).toEqual(['mem_d', 'mem_w1'])
    expect(await indexTree(gdir())).toEqual(globalBefore)
    expect(await table.locate('mem_d', G)).toBeDefined()
  })
})

describe('索引读不出、被别处改过', () => {
  async function breakEntry(dir: string): Promise<string> {
    const path = join(dir, INDEX_DIR, INDEX_ENTRY_FILE)
    const text = await readFile(path, 'utf8')
    await rm(path)
    await mkdir(path)
    return text
  }
  async function fixEntry(dir: string, text: string) {
    const path = join(dir, INDEX_DIR, INDEX_ENTRY_FILE)
    await rm(path, { recursive: true })
    await writeFile(path, text)
  }
  const rowSteps = (journal: OpJournal) => journal.pending().flatMap(p => p.steps).filter(s => s.kind === INDEX_ROW_STEP)

  it('读不出：记忆照存，这一步留在日志里；修好之后下一次进写入段归进所选主题，别处（含「未整理」）不留它', async () => {
    const first = open()
    await seedGlobal(first.table)
    const entry = await breakEntry(gdir())
    await createWith(first.table, record({ id: 'mem_n', name: '读不出时存的' }), opWith(choose('上线')))
    expect(await first.table.locate('mem_n', G)).toBeDefined()
    expect(rowSteps(first.journal)).toHaveLength(1)
    // 修好时这条已经被别人放进了「未整理」
    await fixEntry(gdir(), entry)
    const unsorted = join(gdir(), INDEX_DIR, INDEX_TOPICS_DIR, '_unsorted.md')
    await writeFile(unsorted, (await readFile(unsorted, 'utf8')).replace(`# ${UNSORTED_TITLE}\n\n`, `# ${UNSORTED_TITLE}\n\n${await expectedRow(first.table, 'mem_n', G)}\n`))
    const next = open()
    await next.table.update('mem_d', G, r => ({ ...r, content: `${r.content}。` }))
    expect((await placement(gdir())).mem_n).toEqual(['上线'])
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_n', 'mem_a'])
    expect(next.journal.hasPending()).toBe(false)
  })

  it('一直读不出：同一进程连着补几次都失败后不再试，日志行不作废；换一个进程修好之后补上', async () => {
    const first = open()
    await seedGlobal(first.table)
    const entry = await breakEntry(gdir())
    await createWith(first.table, record({ id: 'mem_n' }), opWith(choose('上线')))
    for (let i = 0; i < 5; i++) await first.table.update('mem_d', G, r => ({ ...r, content: `第 ${i} 次` }))
    expect(rowSteps(first.journal)).toHaveLength(1)
    await fixEntry(gdir(), entry)
    await first.table.update('mem_d', G, r => ({ ...r, content: '修好之后' }))
    expect(rowSteps(first.journal)).toHaveLength(1)
    expect((await placement(gdir())).mem_n).toBeUndefined()
    const next = open()
    await next.table.update('mem_d', G, r => ({ ...r, content: '换了进程' }))
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_n', 'mem_a'])
    expect(next.journal.hasPending()).toBe(false)
  })

  it('读到之后、写之前主题页被手改：不盖掉手改，按新内容重来，这条仍在最前', async () => {
    const { table } = open()
    await seedGlobal(table)
    const page = await pageFile(gdir(), '上线')
    let isEdited = false
    io.afterRead = async (path) => {
      if (path !== page) return false
      const { appendFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      await appendFile(page, '\n读完之后用户写的一句。\n')
      isEdited = true
      return true
    }
    await createWith(table, record({ id: 'mem_n' }), opWith(choose('上线')))
    expect(isEdited).toBe(true)
    expect(await readFile(page, 'utf8')).toContain('读完之后用户写的一句。')
    expect(await membersOf(gdir(), '上线')).toEqual(['mem_n', 'mem_a'])
  })

  it('新建主题：先写主题页，再写入口', async () => {
    const { table } = open()
    await seedGlobal(table)
    io.calls = []
    io.recording = true
    await createWith(table, record({ id: 'mem_n' }), opWith(choose('写锁', { about: '说明。' })))
    io.recording = false
    // 原子写先写临时文件再改名，改名才是落盘的那一刻：主题页改名完成之后，入口才开始写
    const writes = io.calls.filter(call => /^(writeFile|rename|link|copyFile)\(/.test(call))
    const pageCommitted = writes.findIndex(call => call.startsWith('rename(') && call.includes(`${sep}${INDEX_TOPICS_DIR}${sep}`))
    const entryStarted = writes.findIndex(call => call.includes(`${sep}${INDEX_DIR}${sep}${INDEX_ENTRY_FILE}`))
    expect(pageCommitted).toBeGreaterThanOrEqual(0)
    expect(entryStarted).toBeGreaterThan(pageCommitted)
  })
})

describe('彻底删除', () => {
  async function breakEntry(dir: string): Promise<string> {
    const path = join(dir, INDEX_DIR, INDEX_ENTRY_FILE)
    const text = await readFile(path, 'utf8')
    await rm(path)
    await mkdir(path)
    return text
  }
  async function fixEntry(dir: string, text: string) {
    const path = join(dir, INDEX_DIR, INDEX_ENTRY_FILE)
    await rm(path, { recursive: true })
    await writeFile(path, text)
  }
  const purgeSteps = (journal: OpJournal) => journal.pending().flatMap(p => p.steps).filter(s => s.kind === INDEX_ROW_STEP && (s as IndexRowStep).isPurge === true)

  it('索引读不出：删照样删，整份核对这一步留在日志里；修好之后补做，索引里没有它的名字和摘要', async () => {
    const first = open()
    await seedGlobal(first.table)
    const entry = await breakEntry(gdir())
    expect(await first.table.delete('mem_a', G)).toBe(true)
    expect(await first.table.locate('mem_a', G)).toBeUndefined()
    expect(purgeSteps(first.journal)).toHaveLength(1)
    await fixEntry(gdir(), entry)
    const next = open()
    await next.table.update('mem_d', G, r => ({ ...r, content: `${r.content}。` }))
    expect((await placement(gdir())).mem_a).toBeUndefined()
    expect(await indexText(gdir())).not.toContain('发版步骤')
    expect(next.journal.hasPending()).toBe(false)
  })

  it('按会话定位删掉项目和全局两份：两个目录都在这一步里，全局索引读不出时修好之后也补上', async () => {
    const first = open()
    await seedGlobal(first.table)
    const located = (await first.table.locate('mem_d', G))!
    await first.table.create(record({ id: 'mem_w1', scope: 'workspace', workspacePath: WS }))
    await writeFile(join(wdir(), basename(located.filePath)), encodeRecord({ ...located.record, scope: 'workspace', workspacePath: WS }, {}))
    await first.table.maintain([wdir()])
    expect((await placement(gdir())).mem_d).toEqual([UNSORTED_TITLE])
    const entry = await breakEntry(gdir())
    expect(await first.table.delete('mem_d', { workspacePath: WS })).toBe(true)
    const steps = purgeSteps(first.journal) as IndexRowStep[]
    expect(steps).toHaveLength(1)
    expect([...steps[0]!.dirs].sort()).toEqual([gdir(), wdir()].sort())
    await fixEntry(gdir(), entry)
    const next = open()
    await next.table.update('mem_b', G, r => ({ ...r, content: `${r.content}。` }))
    expect((await placement(gdir())).mem_d).toBeUndefined()
    expect((await placement(wdir())).mem_d).toBeUndefined()
    expect(next.journal.hasPending()).toBe(false)
  })

  it('目录里还没有索引：彻底删除不借机建索引', async () => {
    const { table } = open()
    await table.create(record({ id: 'mem_w', scope: 'workspace', workspacePath: WS }))
    expect(await table.delete('mem_w', W)).toBe(true)
    expect(await table.locate('mem_w', W)).toBeUndefined()
    expect(await indexTree(wdir())).toBeUndefined()
  })
})
