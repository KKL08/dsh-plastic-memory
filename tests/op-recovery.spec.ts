import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { newWriteOp, type WriteOp } from '../src/storage/table.ts'
import { ARCHIVE_DIR, STATE_DIR } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { openRelease020Table } from './helpers/release-020.ts'

// 写入中途进程退出：在进程边界（node:fs/promises 的写调用）注入。第 k 次写调用之前「进程没了」，
// 这之后它的写调用一律不落盘（真退出时 catch、finally 也不会跑）。然后换一个新实例（新连接、新锁）进一次写入段，看补做的结果。

const fault = vi.hoisted(() => ({ remaining: Number.POSITIVE_INFINITY, isDead: false, calls: 0 }))
class Crash extends Error {}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writes = new Set(['appendFile', 'copyFile', 'cp', 'link', 'mkdir', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'])
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && writes.has(key)
    ? async (...args: unknown[]) => {
        // 建锁库目录不算：在这里失败会被当成「写锁不可用」，那是另一条路
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
const WS = '/projects/demo'
const STEP = 'test-step'

let root: string
let journalDir: string
beforeEach(async () => {
  fault.remaining = Number.POSITIVE_INFINITY
  fault.isDead = false
  root = await mkdtemp(join(tmpdir(), 'pm-recovery-root-'))
  journalDir = await mkdtemp(join(tmpdir(), 'pm-recovery-journal-'))
})
afterEach(async () => {
  fault.remaining = Number.POSITIVE_INFINITY
  fault.isDead = false
  for (const journal of journals.splice(0)) journal.close()
  await rm(root, { recursive: true, force: true })
  await rm(journalDir, { recursive: true, force: true })
})

const journals: OpJournal[] = []
const journalPath = () => join(journalDir, 'op-journal.sqlite')

/** 一个「进程」：自己的锁、自己的日志连接、自己的步骤记录。 */
function open(opts: { journal?: boolean } = {}) {
  const journal = opts.journal === false ? undefined : new OpJournal({ path: journalPath(), log: quiet })
  if (journal !== undefined) journals.push(journal)
  const ran: Array<{ op: string; id: string | undefined; content: string | undefined; isIntact: boolean }> = []
  const table = new FileTable({
    root, stats: new InMemoryKvTable<RecallStats>(), log: quiet, lock: createRootLock({ root, log: quiet }),
    ...(journal === undefined ? {} : { journal }),
  })
  table.registerStep(STEP, async (_step, ctx) => { ran.push({ op: ctx.op, id: ctx.record?.id, content: ctx.record?.content, isIntact: ctx.isIntact }) })
  return { table, journal, ran }
}

const seed = (partial: Partial<MemoryRecord> = {}) => record({ id: 'mem_a', name: '甲', content: '第一版', ...partial })
const other = () => record({ id: 'mem_other', name: '旁观', content: '旁观的正文' })

/** 根下所有记忆文件里，这个 id 的有几份、各在哪。 */
async function copiesOf(id: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== STATE_DIR) await walk(p) }
      else if (e.name.endsWith('.md') && (await readFile(p, 'utf8')).includes(`\nid: ${id}\n`)) out.push(p)
    }
  }
  await walk(root)
  return out.sort()
}

/** 新实例进一次写入段（改一条不相干的记忆），触发补做。 */
async function recover(next = open()) {
  await next.table.update('mem_other', global, r => ({ ...r, summary: `${r.summary}。` }))
  return next
}

interface Scenario {
  name: string
  seed?: MemoryRecord
  run: (table: FileTable, op: WriteOp) => Promise<unknown>
  /** 写完之后这条记忆该是什么样；undefined 表示不在了。 */
  after: Partial<MemoryRecord> | undefined
}

const scenarios: Scenario[] = [
  { name: '新建', run: (t, op) => t.create(seed(), op), seed: undefined as never, after: { content: '第一版', status: 'active' } },
  { name: '原地改正文', run: (t, op) => t.update('mem_a', global, r => ({ ...r, content: '第二版' }), op), after: { content: '第二版', name: '甲' } },
  { name: '改名（文件跟着换名）', run: (t, op) => t.update('mem_a', global, r => ({ ...r, name: '乙' }), op), after: { name: '乙', content: '第一版' } },
  { name: '软删（搬进归档目录）', run: (t, op) => t.update('mem_a', global, r => ({ ...r, status: 'deleted' }), op), after: { status: 'deleted' } },
  {
    name: '改作用域（搬到项目目录）',
    run: (t, op) => t.update('mem_a', global, r => ({ ...r, scope: 'workspace', workspacePath: WS }), op),
    after: { scope: 'workspace', workspacePath: WS },
  },
  { name: '彻底删除', run: (t, op) => t.delete('mem_a', global, undefined, op), after: undefined },
]

const isCreate = (s: Scenario) => s.name === '新建'

async function prepare(s: Scenario) {
  const setup = open({ journal: false })
  await setup.table.create(other())
  if (!isCreate(s)) await setup.table.create(seed())
}

/** 这条记忆现在在不在、长什么样（不管它在哪个目录）。 */
async function stateOf(table: FileTable): Promise<MemoryRecord | undefined> {
  return (await table.locate('mem_a', global))?.record ?? (await table.locate('mem_a', { kind: 'workspace', workspacePath: WS }))?.record
}

describe('写入中途进程退出后的补做', () => {
  for (const s of scenarios) {
    describe(s.name, () => {
      it('每一个写调用之前退出：补做后要么是改前、要么是改后，同一条只有一份；写成了的补做提交后的步骤，没写成的不做', async () => {
        // 先完整跑一遍，数这次操作有几次写调用
        await prepare(s)
        const dry = open()
        fault.calls = 0
        const dryOp = newWriteOp({ steps: [{ kind: STEP }] })
        await s.run(dry.table, dryOp)
        const total = fault.calls
        expect(total).toBeGreaterThan(0)
        const outcomes = new Set<string>()

        for (let k = 0; k <= total; k++) {
          await rm(root, { recursive: true, force: true })
          await rm(journalDir, { recursive: true, force: true })
          root = await mkdtemp(join(tmpdir(), 'pm-recovery-root-'))
          journalDir = await mkdtemp(join(tmpdir(), 'pm-recovery-journal-'))
          await prepare(s)

          const dying = open()
          const op = newWriteOp({ steps: [{ kind: STEP }] })
          fault.remaining = k
          // k 等于总数：文件都写完了，死在调用方结这次操作（做提交后的步骤）之前
          await s.run(dying.table, op).then(() => { fault.isDead = true }, (err: unknown) => { if (!(err instanceof Crash) && !fault.isDead) throw err })
          expect(dying.ran, `第 ${k} 次之前退出`).toEqual([])
          fault.remaining = Number.POSITIVE_INFINITY
          fault.isDead = false

          const next = await recover()
          const now = await stateOf(next.table)
          const copies = await copiesOf('mem_a')
          const isAfter = s.after === undefined ? now === undefined : now !== undefined && Object.entries(s.after).every(([key, value]) => now[key as keyof MemoryRecord] === value)
          if (isAfter) {
            expect(copies, `第 ${k} 次之前退出：写成了`).toHaveLength(s.after === undefined ? 0 : 1)
            expect(next.ran.map(r => r.op), `第 ${k} 次之前退出：写成了就补做步骤`).toEqual([op.id])
            expect(next.ran[0]!.id).toBe(s.after === undefined ? undefined : 'mem_a')
            expect(next.ran[0]!.isIntact).toBe(true)
          } else {
            // 没写成：和改前一样（新建就是没有），步骤不做
            if (isCreate(s)) expect(now, `第 ${k} 次之前退出：没写成`).toBeUndefined()
            else expect(now, `第 ${k} 次之前退出：没写成`).toMatchObject({ name: '甲', content: '第一版', status: 'active', scope: 'global' })
            expect(copies).toHaveLength(isCreate(s) ? 0 : 1)
            expect(next.ran).toEqual([])
          }
          expect(next.journal!.pending(), `第 ${k} 次之前退出：补做后不留待完成的行`).toEqual([])
          outcomes.add(isAfter ? 'after' : 'before')

          // 补做只做一次：再进一次写入段不重复
          await recover(next)
          expect(next.ran.length).toBeLessThanOrEqual(1)
          for (const journal of journals.splice(0)) journal.close()
        }
        // 两种结局都走到过，说明注入点落在了提交点两边
        expect([...outcomes].sort()).toEqual(['after', 'before'])
      })
    })
  }

  it('调用方自己结这次操作：步骤做一次，行删掉，之后再进写入段不重做', async () => {
    await prepare(scenarios[1]!)
    const p = open()
    const op = newWriteOp({ steps: [{ kind: STEP }] })
    const written = await p.table.update('mem_a', global, r => ({ ...r, content: '第二版' }), op)
    expect(p.journal!.pending().map(row => row.op)).toEqual([op.id])
    await p.table.finishOp(op, written)
    expect(p.ran).toEqual([{ op: op.id, id: 'mem_a', content: '第二版', isIntact: true }])
    expect(p.journal!.pending()).toEqual([])
    await recover(p)
    expect(p.ran).toHaveLength(1)
  })

  it('搬家写完新文件后退出、原来那份随后被别处改过：两份都留，步骤照样补做', async () => {
    const s = scenarios[3]!
    await prepare(s)
    const [before] = await copiesOf('mem_a')
    const op = newWriteOp({ steps: [{ kind: STEP }] })
    // 逐个注入点找「新文件已在归档目录、旧文件还在」的那一刻
    let k = 0
    for (; ; k++) {
      fault.remaining = k
      await s.run(open().table, op).catch(() => {})
      fault.remaining = Number.POSITIVE_INFINITY
      fault.isDead = false
      const copies = await copiesOf('mem_a')
      if (copies.length === 2) break
      expect(copies, '还没走到两份并存').toEqual([before])
      expect(k).toBeLessThan(20)
    }
    await writeFile(before!, (await readFile(before!, 'utf8')).replace('第一版', '别处改过的第一版'))

    const next = await recover()
    const copies = await copiesOf('mem_a')
    expect(copies).toHaveLength(2)
    expect(await readFile(before!, 'utf8')).toContain('别处改过的第一版')
    expect(copies.some(p => p.includes(`${ARCHIVE_DIR}/`))).toBe(true)
    expect(next.ran.map(r => r.op)).toEqual([op.id])
    expect(next.journal!.pending()).toEqual([])
  })

  it('写成之后、补做之前旧版本改过这条：提交标记还在，照样算写成了、步骤补做', async () => {
    await prepare(scenarios[1]!)
    const dying = open()
    const op = newWriteOp({ steps: [{ kind: STEP }] })
    await dying.table.update('mem_a', global, r => ({ ...r, content: '第二版' }), op)   // 文件写完，没结
    const old = await openRelease020Table({ root, stats: new InMemoryKvTable<RecallStats>() })
    await old.update('mem_a', global, r => ({ ...r, content: '旧版本改的第三版', updatedAt: r.updatedAt + 1000 }))

    const next = await recover()
    // 文件已不是这次写下的原样：处理器拿到的是现在的内容，并被告知这一点
    expect(next.ran).toEqual([{ op: op.id, id: 'mem_a', content: '旧版本改的第三版', isIntact: false }])
    expect(next.journal!.pending()).toEqual([])
    expect(await copiesOf('mem_a')).toHaveLength(1)
  })

  it('写成之后日志库被删：不补做也不报错，记忆是改后的样子', async () => {
    await prepare(scenarios[1]!)
    const dying = open()
    const op = newWriteOp({ steps: [{ kind: STEP }] })
    await dying.table.update('mem_a', global, r => ({ ...r, content: '第二版' }), op)
    dying.journal!.close()
    await rm(journalDir, { recursive: true, force: true })

    const next = await recover()
    expect(next.ran).toEqual([])
    expect((await stateOf(next.table))?.content).toBe('第二版')
    expect(await copiesOf('mem_a')).toHaveLength(1)
  })

  it('软删写完归档那份、删原来那份时出错：按提交标记找得到写下的那份，按 id 定位挑到的还是原来那份', async () => {
    const scenario = scenarios[3]!
    await prepare(scenario)
    const dry = open()
    fault.calls = 0
    await scenario.run(dry.table, newWriteOp())
    const total = fault.calls
    let hits = 0
    for (let k = 0; k < total; k++) {
      await rm(root, { recursive: true, force: true })
      await rm(journalDir, { recursive: true, force: true })
      root = await mkdtemp(join(tmpdir(), 'pm-recovery-root-'))
      journalDir = await mkdtemp(join(tmpdir(), 'pm-recovery-journal-'))
      await prepare(scenario)
      const p = open()
      const op = newWriteOp()
      fault.remaining = k
      await scenario.run(p.table, op).catch(() => {})
      // 同一个进程接着跑：出错的只是那一次调用
      fault.remaining = Number.POSITIVE_INFINITY
      fault.isDead = false
      const copies = await copiesOf('mem_a')
      if (copies.length === 2) {
        hits++
        expect((await p.table.locate('mem_a', global))?.record.status).toBe('active')
        const written = await p.table.locateWrittenBy('mem_a', global, op.id)
        expect(written?.record.status, `第 ${k} 次调用出错`).toBe('deleted')
        expect(written?.filePath).toContain(ARCHIVE_DIR)
        // 找的这一下进了写入段，顺带把原来那份删掉了
        expect(await copiesOf('mem_a')).toHaveLength(1)
      } else if (copies.every(path => !path.includes(ARCHIVE_DIR))) {
        expect(await p.table.locateWrittenBy('mem_a', global, op.id), `第 ${k} 次调用出错：没写成`).toBeUndefined()
      }
      for (const journal of journals.splice(0)) journal.close()
    }
    expect(hits).toBeGreaterThan(0)
  })

  it('更新的版本记的行（目标种类不认识）：不动它，也不删任何记忆', async () => {
    await prepare(scenarios[1]!)
    const newer = open()
    newer.journal!.begin({
      op: 'op_newer', at: 1, steps: [],
      target: { kind: 'index-move', memoryId: 'mem_a', dir: join(root, 'global') } as never,
    })
    const next = await recover()
    await recover(next)
    expect(await copiesOf('mem_a')).toHaveLength(1)
    expect(next.journal!.pending().map(row => row.op)).toEqual(['op_newer'])
  })

  it('更新的版本记的行（有一步不认识）：整行留着，认识的步骤也不先做', async () => {
    await prepare(scenarios[1]!)
    const p = open()
    const op = newWriteOp({ steps: [{ kind: STEP }, { kind: 'step-from-newer-version' }] })
    await p.table.update('mem_a', global, r => ({ ...r, content: '第二版' }), op)
    const next = await recover()
    expect(next.ran).toEqual([])
    expect(next.journal!.pending().map(row => row.op)).toEqual([op.id])
  })

  it('一行补做一直失败：这个进程试三次就不再试，写入照常；换一个进程再补', async () => {
    await prepare(scenarios[1]!)
    const p = open()
    const op = newWriteOp({ steps: [{ kind: STEP }] })
    await p.table.update('mem_a', global, r => ({ ...r, content: '第二版' }), op)
    const stuck = open()
    let attempts = 0
    stuck.table.registerStep(STEP, async () => { attempts++; throw new Error('记不上') })
    for (let i = 0; i < 5; i++) await recover(stuck)
    expect(attempts).toBe(3)
    expect(stuck.journal!.pending().map(row => row.op)).toEqual([op.id])
    const next = await recover()
    expect(next.ran.map(r => r.op)).toEqual([op.id])
    expect(next.journal!.pending()).toEqual([])
  })

  it('不带日志库：写入照常，文件照样带提交标记', async () => {
    await prepare(scenarios[1]!)
    const p = open({ journal: false })
    await p.table.update('mem_a', global, r => ({ ...r, content: '第二版' }))
    expect((await p.table.locate('mem_a', global))?.writeOp).toMatch(/^op_/)
  })

  it('日志的行里没有记忆的名字、正文、摘要和标签', async () => {
    const secretish = { name: '独一无二的名字甲乙丙', content: '独一无二的正文丁戊己', summary: '独一无二的摘要庚辛', tags: ['独一无二的标签壬癸'] }
    const setup = open({ journal: false })
    await setup.table.create(other())
    await setup.table.create(record({ id: 'mem_a', ...secretish }))
    const p = open()
    const pendingOps = [
      newWriteOp({ steps: [{ kind: STEP }], initiator: 'main', batch: 'batch_1' }),
      newWriteOp({ steps: [{ kind: STEP }] }),
      newWriteOp({ steps: [{ kind: STEP }] }),
    ]
    // 每次写完看一眼那一行（下一次进写入段会把它补完删掉）
    let rows = ''
    const look = () => {
      expect(p.journal!.pending()).toHaveLength(1)
      rows += JSON.stringify(p.journal!.pending())
    }
    await p.table.update('mem_a', global, r => ({ ...r, content: `${secretish.content}第二版`, tags: [...r.tags, '独一无二的标签子丑'] }), pendingOps[0])
    look()
    await p.table.update('mem_a', global, r => ({ ...r, name: `${secretish.name}改名`, status: 'deleted' }), pendingOps[1])
    look()
    await p.table.delete('mem_a', global, undefined, pendingOps[2])
    look()
    expect(rows).toContain('mem_a')
    p.journal!.close()
    const files = await Promise.all((await readdir(journalDir)).map(name => readFile(join(journalDir, name))))
    const raw = Buffer.concat(files).toString('utf8')
    for (const text of ['独一无二的名字', '独一无二的正文', '独一无二的摘要', '独一无二的标签']) {
      expect(rows).not.toContain(text)
      expect(raw).not.toContain(text)
    }
  })
})
