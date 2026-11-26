import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AsyncResource } from 'node:async_hooks'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FileTable } from '../src/storage/file-table.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { DerivedIndex } from '../src/storage/derived-index.ts'
import { createRootLock, type SqliteModule } from '../src/storage/root-lock.ts'
import { RECENT_CHANGES_PER_SCOPE, withWriteSession, type RecentChangeKind } from '../src/storage/recent-changes.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotCache, type FrozenSnapshotInfo } from '../src/runtime.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { CHANGE_NOTICE_HEADING, NOTICE_ITEM_LIMIT, UNLISTED_CHANGES_LINE, moreChangesLine } from '../src/snapshot-message.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import { TOPIC_MEMBER_LIMIT } from '../src/snapshot-index.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { interleaveRuns, interleaveSeed } from './helpers/interleave.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET, generatePrivateKeyPem } from './helpers/secrets.ts'

// 发送点的变化通知：冻结时注入过的记忆，之后被别的会话、界面或后台改了，下一个发送点补一条通知。
// 用真实的文件表、操作日志库、派生索引和快照缓存；文件调用在进程边界（node:fs/promises）计数，读改动记录失败在 node:sqlite 边界注入。

const fsHook = vi.hoisted(() => ({
  isTracing: false,
  calls: [] as string[],
  /** 每次读文件系统（读文件、读目录、取属性）之前调用；返回 Promise 时等它完成再读。 */
  onRead: undefined as undefined | (() => Promise<unknown> | undefined),
  /** 每次别的文件调用（写、删、建目录……）之前调用，带调用名和第一个参数；返回 Promise 时等它完成再做。 */
  onOther: undefined as undefined | ((key: string, target: unknown) => Promise<unknown> | undefined),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const reads = new Set(['readFile', 'readdir', 'stat', 'lstat', 'open', 'access', 'realpath'])
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' && /^[a-z]/.test(key)
    ? (...args: unknown[]) => {
        if (fsHook.isTracing) fsHook.calls.push(key)
        const call = () => (value as (...a: unknown[]) => unknown)(...args)
        const wait = reads.has(key) ? fsHook.onRead?.() : fsHook.onOther?.(key, args[0])
        return wait === undefined ? call() : wait.then(call)
      }
    : value]))
})

const quiet = { info() {}, warn() {}, error() {} }
const WS = '/projects/demo'
const OTHER_WS = '/projects/other'
const WS_SCOPE = { kind: 'workspace', workspacePath: WS } as const
const SELF = 'sess-a'
const OTHER = 'sess-b'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

/** 读改动记录的查询（SELECT 最近改动表或序号表）在执行时失败：模拟库一时读不出。写和建表不受影响。 */
const flaky = { isFailing: false }
function flakySqlite(): SqliteModule {
  class FlakyDatabase extends DatabaseSync {
    override prepare(sql: string) {
      const statement = super.prepare(sql)
      if (!/^\s*select/i.test(sql) || !/recent_change|sqlite_sequence/i.test(sql)) return statement
      return new Proxy(statement, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            if (flaky.isFailing && (key === 'get' || key === 'all' || key === 'iterate')) throw new Error('disk I/O error')
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        },
      })
    }
  }
  return { DatabaseSync: FlakyDatabase }
}

const opened: Array<{ close(): void }> = []
const dirs: string[] = []
afterEach(async () => {
  fsHook.isTracing = false
  fsHook.calls.length = 0
  fsHook.onRead = undefined
  fsHook.onOther = undefined
  flaky.isFailing = false
  for (const handle of opened.splice(0)) handle.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** 一套真实存储加一个快照缓存；会话属于项目 WS。frozen 收集每次冻结交出的会话视图原料（带入顺序看 injectedIds）。 */
async function rig(opts: { isFlaky?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pm-notice-root-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'pm-notice-state-'))
  dirs.push(root, stateDir)
  const journalPath = join(stateDir, 'op-journal.sqlite')
  const journal = new OpJournal({ path: journalPath, log: quiet, ...(opts.isFlaky === true ? { loadSqlite: flakySqlite } : {}) })
  const index = new DerivedIndex({ path: join(stateDir, 'derived.sqlite'), log: quiet })
  opened.push(journal, index)
  const stats = new InMemoryBatchKvTable<RecallStats>()
  // hintRacyMs 取负数：刚写过的目录也直接用派生库里的文件名提示，不按时间戳粒度临时多列一次目录（读文件的次数才确定）
  const store = new MemoryStore(new FileTable({ root, stats, log: quiet, lock: createRootLock({ root, log: quiet }), journal, index, hintRacyMs: -60_000 }), quiet, stats)
  const frozen: FrozenSnapshotInfo[] = []
  const cache = new SnapshotCache({
    store, registry, budget: 1_000_000, log: quiet, recentChanges: journal,
    onFrozen: (_session, info) => { frozen.push(info) },
  })
  const session = {}
  cache.setWorkspacePath(session, WS)
  return { root, stateDir, journalPath, journal, store, cache, session, frozen }
}

/** 本项目的必读全文记忆（行为偏好）。 */
const inWs = (id: string, partial: Partial<MemoryRecord> = {}) =>
  record({ id, name: `名${id}`, summary: `摘要${id}`, content: `正文${id}`, type: 'preference', scope: 'workspace', workspacePath: WS, ...partial })
/** 全局的必读全文记忆。 */
const inGlobal = (id: string, partial: Partial<MemoryRecord> = {}) =>
  record({ id, name: `名${id}`, summary: `摘要${id}`, content: `正文${id}`, type: 'preference', scope: 'global', ...partial })

let editCount = 0
/** 以某个会话的名义（缺省是界面、后台）跑一段写入。 */
const as = <T>(session: string | undefined, fn: () => Promise<T>) => session === undefined ? fn() : withWriteSession(session, fn)
/** 内容改动：像写入工具那样带上新的最近一次内容改动。 */
function edit(store: MemoryStore, r: MemoryRecord, patch: Partial<MemoryRecord>, session?: string) {
  const op = `op_edit_${++editCount}`
  return as(session, () => store.update(r, cur => ({ ...cur, ...patch, lastChange: { kind: 'refine', at: 2, op, by: 'main' } })))
}

/** 通知正文按行拆开，去掉开头的说明句。 */
function linesOf(text: string): string[] {
  const [heading, ...lines] = text.split('\n')
  expect(heading).toBe(CHANGE_NOTICE_HEADING)
  return lines
}

describe('改了注入过的记忆', () => {
  it('别的会话改了带入全文的记忆：通知列出它现在的名称和摘要；同一处改动下一个发送点不再说', async () => {
    const r = await rig()
    const a = inWs('mem_a')
    await r.store.create(a)
    await r.store.create(inWs('mem_b'))
    expect(await r.cache.assemble(r.session)).toContain('正文mem_a')
    await edit(r.store, a, { name: '新名称', summary: '新摘要', content: '新正文' }, OTHER)
    const notice = await r.cache.changeNotice(r.session, SELF)
    expect(notice).toEqual({ text: [CHANGE_NOTICE_HEADING, '- [mem_a] 新名称（新摘要）'].join('\n'), summary: '1 条记忆有变化' })
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
  })

  it('界面、后台的写入（不带会话）也通知；本会话自己的写入不通知', async () => {
    const r = await rig()
    const own = inWs('mem_own')
    const gui = inGlobal('mem_gui')
    await r.store.create(own)
    await r.store.create(gui)
    await r.cache.assemble(r.session)
    await edit(r.store, own, { summary: '本会话改的' }, SELF)
    // 前提：本会话的这次改动确实记下了（带着本会话）
    expect(r.journal.changesSince([WS], 0)!.rows.map(row => [row.memoryId, row.session])).toEqual([['mem_own', SELF]])
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    await edit(r.store, gui, { summary: '界面改的' })
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_gui] 名mem_gui（界面改的）'])
  })

  it('同一条先被别的会话改、后被本会话改：按最新那次算，本会话改的不通知；反过来按别的会话的算', async () => {
    const r = await rig()
    const x = inWs('mem_x')
    const y = inWs('mem_y')
    await r.store.create(x)
    await r.store.create(y)
    await r.cache.assemble(r.session)
    await edit(r.store, x, { summary: '别的会话先改' }, OTHER)
    await edit(r.store, x, { summary: '本会话后改' }, SELF)
    await edit(r.store, y, { summary: '本会话先改' }, SELF)
    await edit(r.store, y, { summary: '别的会话后改' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_y] 名mem_y（别的会话后改）'])
  })

  it('不给本会话 id 时谁写的都通知', async () => {
    const r = await rig()
    const x = inWs('mem_x')
    await r.store.create(x)
    await r.cache.assemble(r.session)
    await edit(r.store, x, { summary: '改了' }, SELF)
    expect(linesOf((await r.cache.changeNotice(r.session, undefined))!.text)).toEqual(['- [mem_x] 名mem_x（改了）'])
  })

  it('只出成员行的记忆也算注入过；没注入过的（别的项目的、冻结之后新建的）改了不通知', async () => {
    const r = await rig()
    const member = inWs('mem_member', { type: 'knowledge' })
    const elsewhere = record({ id: 'mem_else', type: 'preference', scope: 'workspace', workspacePath: OTHER_WS })
    await r.store.create(member)
    await r.store.create(elsewhere)
    await r.cache.assemble(r.session)
    const view = r.frozen.at(-1)!
    expect(view.injectedIds).toContain('mem_member')
    expect(view.coreIds).not.toContain('mem_member')
    const late = inWs('mem_late')
    await r.store.create(late)
    await edit(r.store, elsewhere, { summary: '别的项目改的' }, OTHER)
    await edit(r.store, late, { summary: '新建后改的' }, OTHER)
    // 前提：这两处改动都记下了
    expect(r.journal.changesSince([WS, OTHER_WS], 0)!.rows.map(row => row.memoryId).sort()).toEqual(['mem_else', 'mem_late'])
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    await edit(r.store, member, { summary: '成员改了' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_member] 名mem_member（成员改了）'])
  })

  it('按「作用域 + id」认：别的项目里同 id 的那份改了，不算本会话注入的这份改了', async () => {
    const r = await rig()
    const mine = inWs('mem_same')
    const theirs = inWs('mem_same', { workspacePath: OTHER_WS, summary: '别的项目那份' })
    await r.store.create(mine)
    await r.store.create(theirs)
    await r.cache.assemble(r.session)
    await edit(r.store, theirs, { summary: '别的项目那份改了' }, OTHER)
    // 前提：别的项目那份的改动记下了
    expect(r.journal.changesSince([OTHER_WS], 0)!.rows.map(row => row.memoryId)).toEqual(['mem_same'])
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    // 多走一步：本会话注入的这份改了照常通知
    await edit(r.store, mine, { summary: '本项目这份改了' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_same] 名mem_same（本项目这份改了）'])
  })

  it('删除（软删、彻底删除）、被取代、移走各用一句话说，不带内容；移到别的项目不写路径', async () => {
    const r = await rig()
    const soft = inWs('mem_soft')
    const hard = inWs('mem_hard')
    const old = inWs('mem_old')
    const up = inWs('mem_up')
    const down = inGlobal('mem_down')
    const away = inWs('mem_away')
    for (const x of [soft, hard, old, up, down, away]) await r.store.create(x)
    await r.cache.assemble(r.session)
    await as(OTHER, () => r.store.softDelete(soft))
    await as(OTHER, () => r.store.hardDelete(hard))
    await as(OTHER, () => r.store.update(old, cur => ({ ...cur, status: 'superseded' })))
    await as(OTHER, () => r.store.update(up, ({ workspacePath: _ws, ...cur }) => ({ ...cur, scope: 'global' })))
    await as(OTHER, () => r.store.update(down, cur => ({ ...cur, scope: 'workspace', workspacePath: WS })))
    await as(OTHER, () => r.store.update(away, cur => ({ ...cur, workspacePath: OTHER_WS, content: '搬走时顺手改了正文', lastChange: { kind: 'refine', at: 2, op: 'op_away', by: 'main' } })))
    expect(await r.store.get('mem_away', { kind: 'workspace', workspacePath: OTHER_WS })).toMatchObject({ status: 'active' })
    const notice = (await r.cache.changeNotice(r.session, SELF))!
    expect(linesOf(notice.text).sort()).toEqual([
      '- [mem_soft] 已删除', '- [mem_hard] 已删除', '- [mem_old] 已被取代',
      '- [mem_up] 已移到全局记忆', '- [mem_down] 已移到本项目记忆', '- [mem_away] 已移到别的项目',
    ].sort())
    expect(notice.summary).toBe('6 条记忆有变化')
    expect(notice.text).not.toContain(OTHER_WS)
    expect(notice.text).not.toContain('正文')
  })

  it('软删之后又在最近删除里彻底删掉：只在软删时通知一次已删除', async () => {
    const r = await rig()
    const x = inWs('mem_x')
    await r.store.create(x)
    await r.cache.assemble(r.session)
    expect(await as(OTHER, () => r.store.softDelete(x))).toBe(true)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_x] 已删除'])
    expect(await as(OTHER, () => r.store.hardDelete(x))).toBe(true)
    // 前提：确实彻底删掉了
    expect(await r.store.locate('mem_x', WS_SCOPE)).toBeUndefined()
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
  })

  it('内容改动的条目先按整条记录遮盖密钥，再折成一行；概括里没有记忆内容', async () => {
    const r = await rig()
    const key = generatePrivateKeyPem('rsa')
    const x = inWs('mem_key')
    await r.store.create(x)
    await r.cache.assemble(r.session)
    await edit(r.store, x, { name: `部署 ${FAKE_SECRET.sk}`, summary: `私钥：\n${key.pem}\n第二行说明` }, OTHER)
    const notice = (await r.cache.changeNotice(r.session, SELF))!
    const lines = linesOf(notice.text)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.startsWith('- [mem_key] ')).toBe(true)
    expect(lines[0]).toContain(SECRET_MASK)
    expect(lines[0]).toContain('第二行说明')
    expect(notice.text).not.toContain(FAKE_SECRET.sk)
    for (const body of key.bodyLines) expect(notice.text).not.toContain(body)
    expect(notice.summary).toBe('1 条记忆有变化')
  })

  it('改了、但现在读不到（文件被手动删掉）：说读不到，不说已删除', async () => {
    const r = await rig()
    const x = inWs('mem_gone')
    await r.store.create(x)
    await r.cache.assemble(r.session)
    await edit(r.store, x, { summary: '改过' }, OTHER)
    const located = await r.store.locate('mem_gone', { kind: 'workspace', workspacePath: WS })
    await rm(located!.filePath)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_gone] 有改动，这次读不到现在的内容'])
  })

  it(`逐条最多 ${NOTICE_ITEM_LIMIT} 条：带入全文的排前，其余按注入顺序，和改动先后无关；超出的只给条数`, async () => {
    const r = await rig()
    // 成员行每个主题最多 TOPIC_MEMBER_LIMIT 条：成员放 4 条，其余用全文记忆凑过逐条上限
    const core = Array.from({ length: 9 }, (_, i) => inWs(`mem_c${i}`))
    const members = Array.from({ length: 4 }, (_, i) => inWs(`mem_m${i}`, { type: 'knowledge' }))
    for (const x of [...core, ...members]) await r.store.create(x)
    await r.cache.assemble(r.session)
    const view = r.frozen.at(-1)!
    const all = [...core, ...members]
    expect(view.injectedIds).toEqual(expect.arrayContaining(all.map(x => x.id)))
    expect(members.length).toBeLessThanOrEqual(TOPIC_MEMBER_LIMIT)
    expect(view.coreIds).toEqual(expect.arrayContaining(core.map(x => x.id)))
    // 倒着改：改动先后和注入顺序相反
    for (const x of [...all].reverse()) await edit(r.store, x, { summary: `改${x.id}` }, OTHER)
    const expectedOrder = [...view.injectedIds.filter(id => view.coreIds.includes(id)), ...view.injectedIds.filter(id => !view.coreIds.includes(id))]
      .filter(id => all.some(x => x.id === id))
    const notice = (await r.cache.changeNotice(r.session, SELF))!
    expect(linesOf(notice.text)).toEqual([
      ...expectedOrder.slice(0, NOTICE_ITEM_LIMIT).map(id => `- [${id}] 名${id}（改${id}）`),
      moreChangesLine(all.length - NOTICE_ITEM_LIMIT),
    ])
    expect(notice.summary).toBe(`${all.length} 条记忆有变化`)
  })

  it('没冻结过的会话、冻结之后什么都没改：不发', async () => {
    const r = await rig()
    const a = inWs('mem_a')
    await r.store.create(a)
    await edit(r.store, a, { summary: '冻结之前改的' }, OTHER)
    // 前提：冻结之前的这次改动记下了
    expect(r.journal.changesSince([WS], 0)!.rows.map(row => row.memoryId)).toEqual(['mem_a'])
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    await r.cache.assemble(r.session)
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    // 多走一步：冻结之后改了照常通知
    await edit(r.store, a, { summary: '冻结之后改的' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_a] 名mem_a（冻结之后改的）'])
  })

  it('重新冻结（压缩后、配置变化后的重建）从新的起点算：冻结之前的改动已经在新快照里，不再通知', async () => {
    const r = await rig()
    const x = inWs('mem_x')
    await r.store.create(x)
    await r.cache.assemble(r.session)
    await edit(r.store, x, { summary: '改过', content: '改过的正文' }, OTHER)
    r.cache.markStale(r.session)
    expect(await r.cache.assemble(r.session)).toContain('改过的正文')
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    // 配置热更新（全体标过期）同样从新的起点算
    await edit(r.store, x, { summary: '又改过', content: '又改过的正文' }, OTHER)
    r.cache.markAllStale()
    expect(await r.cache.assemble(r.session)).toContain('又改过的正文')
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    // 多走一步：重新冻结之后再改照常通知
    await edit(r.store, x, { summary: '冻结后改的' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_x] 名mem_x（冻结后改的）'])
  })

  it('发送点只读：不写记忆目录', async () => {
    const r = await rig()
    const x = inWs('mem_x')
    await r.store.create(x)
    await r.cache.assemble(r.session)
    await edit(r.store, x, { summary: '改过' }, OTHER)
    fsHook.isTracing = true
    const notice = await r.cache.changeNotice(r.session, SELF)
    fsHook.isTracing = false
    // 前提：这个发送点确实读了、发了通知
    expect(linesOf(notice!.text)).toEqual(['- [mem_x] 名mem_x（改过）'])
    expect(fsHook.calls.length).toBeGreaterThan(0)
    const writes = new Set(['appendFile', 'copyFile', 'cp', 'link', 'mkdir', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile', 'open'])
    expect(fsHook.calls.filter(call => writes.has(call))).toEqual([])
  })
})

describe('记录不全时', () => {
  it('起点之后这个作用域的记录被挤掉过：列出还在的，末尾说另有改动未列出', async () => {
    const r = await rig()
    const a = inWs('mem_a')
    const b = inWs('mem_b')
    await r.store.create(a)
    await r.store.create(b)
    await r.cache.assemble(r.session)
    await edit(r.store, a, { summary: '会被挤掉' }, OTHER)
    for (let i = 0; i < RECENT_CHANGES_PER_SCOPE; i++) r.journal.recordChange({ op: `op_fill_${i}`, scope: WS, memoryId: `mem_fill_${i}`, change: 'content', at: 3 })
    await edit(r.store, b, { summary: '还在' }, OTHER)
    const notice = (await r.cache.changeNotice(r.session, SELF))!
    expect(linesOf(notice.text)).toEqual(['- [mem_b] 名mem_b（还在）', UNLISTED_CHANGES_LINE])
    expect(notice.summary).toBe('1 条记忆有变化')
  })

  it('挤掉的都在起点之前：不说另有改动', async () => {
    const r = await rig()
    const b = inWs('mem_b')
    await r.store.create(b)
    for (let i = 0; i < RECENT_CHANGES_PER_SCOPE + 5; i++) r.journal.recordChange({ op: `op_fill_${i}`, scope: WS, memoryId: `mem_fill_${i}`, change: 'content', at: 3 })
    await r.cache.assemble(r.session)
    await edit(r.store, b, { summary: '改了' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_b] 名mem_b（改了）'])
  })

  it('操作日志库换了新库（库里最大序号小于起点）：列出新库里注入过的改动，末尾说另有改动未列出', async () => {
    const r = await rig()
    const a = inWs('mem_a')
    const elsewhere = record({ id: 'mem_else', type: 'preference', scope: 'workspace', workspacePath: OTHER_WS })
    await r.store.create(a)
    await r.store.create(elsewhere)
    for (let i = 0; i < 3; i++) await edit(r.store, elsewhere, { summary: `别处第 ${i} 次` })
    await r.cache.assemble(r.session)
    r.journal.close()
    for (const suffix of ['', '-wal', '-shm']) await rm(r.journalPath + suffix, { force: true })
    await edit(r.store, a, { summary: '新库里记的' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_a] 名mem_a（新库里记的）', UNLISTED_CHANGES_LINE])
    // 起点已经改成新库的位置：下一个发送点没有新改动就不发，不再重复报换库
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    // 多走一步：新库里接着改的照常列出，不带另有改动
    await edit(r.store, a, { summary: '新库里又改的' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_a] 名mem_a（新库里又改的）'])
  })

  it('冻结时没读到起点：之后第一次读得到的发送点只说记忆可能有变化，从那里接着算', async () => {
    const r = await rig({ isFlaky: true })
    const a = inWs('mem_a')
    await r.store.create(a)
    flaky.isFailing = true
    expect(await r.cache.assemble(r.session)).toContain('正文mem_a')
    flaky.isFailing = false
    await edit(r.store, a, { summary: '起点不明时改的' }, OTHER)
    expect(await r.cache.changeNotice(r.session, SELF)).toEqual({ text: [CHANGE_NOTICE_HEADING, UNLISTED_CHANGES_LINE].join('\n'), summary: '记忆可能有变化' })
    await edit(r.store, a, { summary: '接着改的' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_a] 名mem_a（接着改的）'])
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
  })

  it('发送点读不出改动记录：这次不发、不推进起点，读得出的下一个发送点补上', async () => {
    const r = await rig({ isFlaky: true })
    const a = inWs('mem_a')
    await r.store.create(a)
    await r.cache.assemble(r.session)
    await edit(r.store, a, { summary: '改了' }, OTHER)
    flaky.isFailing = true
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    flaky.isFailing = false
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_a] 名mem_a（改了）'])
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
  })

  it('读到不认识的改动（更新的版本写的）：碰上注入过的记忆就说另有改动未列出；没注入过的不管', async () => {
    const r = await rig()
    await r.store.create(inWs('mem_a'))
    await r.cache.assemble(r.session)
    r.journal.recordChange({ op: 'op_future_1', scope: WS, memoryId: 'mem_nobody', change: 'reshaped' as RecentChangeKind, at: 3 })
    // 前提：这一行确实在记录里
    expect(r.journal.changesSince([WS], 0)!.rows.map(row => [row.memoryId, row.change])).toEqual([['mem_nobody', 'reshaped']])
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    r.journal.recordChange({ op: 'op_future_2', scope: WS, memoryId: 'mem_a', change: 'reshaped' as RecentChangeKind, at: 3 })
    expect(await r.cache.changeNotice(r.session, SELF)).toEqual({ text: [CHANGE_NOTICE_HEADING, UNLISTED_CHANGES_LINE].join('\n'), summary: '记忆可能有变化' })
  })
})

describe('注入清单决定查哪些、发不发', () => {
  it('读到缺去向的移走行（读不出的行）：碰上注入过的记忆就说另有改动未列出；没注入过的不管', async () => {
    const r = await rig()
    await r.store.create(inWs('mem_a'))
    await r.cache.assemble(r.session)
    r.journal.recordChange({ op: 'op_bad_1', scope: WS, memoryId: 'mem_nobody', change: 'moved', at: 3 })
    // 前提：这一行确实在记录里，没有去向
    const [bad] = r.journal.changesSince([WS], 0)!.rows
    expect([bad!.memoryId, bad!.change, bad!.movedTo]).toEqual(['mem_nobody', 'moved', undefined])
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    r.journal.recordChange({ op: 'op_bad_2', scope: WS, memoryId: 'mem_a', change: 'moved', at: 3 })
    expect(await r.cache.changeNotice(r.session, SELF)).toEqual({ text: [CHANGE_NOTICE_HEADING, UNLISTED_CHANGES_LINE].join('\n'), summary: '记忆可能有变化' })
  })

  it('冻结时什么都没注入（冷启动）、又没读到起点：之后不发「记忆可能有变化」', async () => {
    const r = await rig({ isFlaky: true })
    flaky.isFailing = true
    await r.cache.assemble(r.session)
    flaky.isFailing = false
    // 前提：确实冻结过、什么都没注入；之后确实有改动记下
    expect(r.frozen.at(-1)!.injectedIds).toEqual([])
    const late = inWs('mem_late')
    await r.store.create(late)
    await edit(r.store, late, { summary: '冻结之后改的' }, OTHER)
    expect(r.journal.changesSince([WS], 0)!.rows.map(row => row.memoryId)).toEqual(['mem_late'])
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
  })

  it('只注入了全局记忆：项目作用域的记录被挤掉不说另有改动；全局的改动照常列出', async () => {
    const r = await rig()
    const g = inGlobal('mem_g')
    await r.store.create(g)
    await r.cache.assemble(r.session)
    expect(r.frozen.at(-1)!.injectedIds).toEqual(['mem_g'])
    const atFreeze = r.journal.latestChangeSeq()!
    for (let i = 0; i < RECENT_CHANGES_PER_SCOPE + 5; i++) r.journal.recordChange({ op: `op_fill_${i}`, scope: WS, memoryId: `mem_fill_${i}`, change: 'content', at: 3 })
    // 前提：冻结之后项目作用域确实挤掉过
    expect(r.journal.changesSince([WS], atFreeze)!.prunedThrough[WS]).toBeGreaterThan(atFreeze)
    expect(await r.cache.changeNotice(r.session, SELF)).toBeUndefined()
    // 多走一步：全局的改动照常列出，同样不带另有改动
    await edit(r.store, g, { summary: '全局改了' }, OTHER)
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_g] 名mem_g（全局改了）'])
  })
})

describe('规模与并发', () => {
  it('发送点的文件读取次数和注入了多少条无关', async () => {
    const costOf = async (count: number) => {
      const r = await rig()
      const all = Array.from({ length: count }, (_, i) => inWs(`mem_${String(i).padStart(4, '0')}`))
      for (const x of all) await r.store.create(x)
      await r.cache.assemble(r.session)
      expect(r.frozen.at(-1)!.coreIds).toHaveLength(count)
      await edit(r.store, all[7]!, { summary: '改了' }, OTHER)
      fsHook.calls.length = 0
      fsHook.isTracing = true
      const notice = await r.cache.changeNotice(r.session, SELF)
      fsHook.isTracing = false
      expect(linesOf(notice!.text)).toEqual(['- [mem_0007] 名mem_0007（改了）'])
      return [...fsHook.calls].sort()
    }
    const small = await costOf(20)
    const large = await costOf(300)
    expect(large).toEqual(small)
  }, 60_000)

  it('冻结读盘期间别的会话提交的改动：要么已经在快照里，要么出现在下一条通知里', async () => {
    await fc.assert(fc.asyncProperty(fc.nat({ max: 40 }), fc.nat({ max: 3 }), fc.boolean(), async (k, pick, isBlocking) => {
      const r = await rig()
      const all = ['mem_r0', 'mem_r1', 'mem_r2', 'mem_r3'].map(id => inWs(id))
      for (const x of all) await r.store.create(x)
      const target = all[pick]!
      // 只观察维护什么时候做完（维护在写锁里：那之前等一次写入做完会卡住自己）
      let isMaintained = false
      const maintain = r.store.maintain.bind(r.store)
      r.store.maintain = async (scope) => { try { await maintain(scope) } finally { isMaintained = true } }
      let reads = 0
      let write: Promise<unknown> | undefined
      // 名称不变：原地覆盖（先写临时文件再换名），读的一方看到的要么是改前、要么是改后的整份
      // 绑在测试自己的异步上下文上：在冻结的读调用里发起，也不继承冻结那一侧的上下文（写入段按异步上下文认重入）
      const start = AsyncResource.bind(() => (write ??= edit(r.store, target, { summary: '新摘要', content: '新正文' }, OTHER)))
      fsHook.onRead = isBlocking
        // 维护做完之后的第 k 次读之前，另一个会话整次写完（提交、记下最近改动）再接着读：落在读起点前后、预读的各个位置
        ? () => (isMaintained && reads++ === k ? start() : undefined)
        // 任意第 k 次读时另一个会话开始写，不等它：和维护、预读交错
        : () => { if (reads++ === k) void start(); return undefined }
      const text = await r.cache.assemble(r.session)
      fsHook.onRead = undefined
      await start()
      const notice = await r.cache.changeNotice(r.session, SELF)
      const isInSnapshot = text!.includes('新正文')
      const isNoticed = notice?.text.split('\n').includes(`- [${target.id}] 名${target.id}（新摘要）`) === true
      expect(r.frozen.at(-1)!.injectedIds).toContain(target.id)
      expect(isInSnapshot || isNoticed).toBe(true)
      for (const handle of opened.splice(0)) handle.close()
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
    }), { seed: interleaveSeed(), numRuns: interleaveRuns(60) })
  }, 180_000)

  it('冻结正好落在软删写下新文件之后、删旧文件之前：快照里还是旧的那份，下一条通知说已删除', async () => {
    const r = await rig()
    const target = inWs('mem_t')
    await r.store.create(target)
    await r.store.create(inWs('mem_u'))
    const oldPath = (await r.store.locate('mem_t', WS_SCOPE))!.filePath
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let parked!: () => void
    const isParked = new Promise<void>(resolve => { parked = resolve })
    let hasParked = false
    // 另一个会话的软删删旧文件之前停住，等冻结做完再接着删
    fsHook.onOther = (key, path) => {
      if (key !== 'rm' || path !== oldPath || hasParked) return undefined
      hasParked = true
      parked()
      return released
    }
    let write: Promise<unknown> | undefined
    // 绑在测试自己的异步上下文上（写入段按异步上下文认重入），同上一条随机用例
    const start = AsyncResource.bind(() => (write ??= as(OTHER, () => r.store.softDelete(target))))
    const maintain = r.store.maintain.bind(r.store)
    // 维护放开写锁之后再开始软删，等它停在删旧文件之前，冻结才接着读起点、预读
    r.store.maintain = async (scope) => {
      await maintain(scope)
      await Promise.race([isParked, start()])
    }
    const text = await r.cache.assemble(r.session)
    release()
    await start()
    // 前提：软删确实停在删旧文件之前、冻结时旧的那份还在用；软删最后做成了
    expect(hasParked).toBe(true)
    expect(text).toContain('正文mem_t')
    expect(r.frozen.at(-1)!.injectedIds).toContain('mem_t')
    expect(await r.store.get('mem_t', WS_SCOPE)).toMatchObject({ status: 'deleted' })
    expect(linesOf((await r.cache.changeNotice(r.session, SELF))!.text)).toEqual(['- [mem_t] 已删除'])
  })

  it('本会话、别的会话、界面交替写，中间穿插发送点和重新冻结：每条通知恰好列出上个发送点以来别处改过的注入记忆', async () => {
    type Step = { kind: 'edit'; who: 'self' | 'other' | 'gui'; idx: number } | { kind: 'send' } | { kind: 'refreeze' }
    const step: fc.Arbitrary<Step> = fc.oneof(
      { arbitrary: fc.record({ kind: fc.constant('edit' as const), who: fc.constantFrom('self' as const, 'other' as const, 'gui' as const), idx: fc.nat({ max: 4 }) }), weight: 4 },
      { arbitrary: fc.constant({ kind: 'send' as const }), weight: 2 },
      { arbitrary: fc.constant({ kind: 'refreeze' as const }), weight: 1 },
    )
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 16 }), async (steps) => {
      const r = await rig()
      const all = [inWs('mem_s0'), inWs('mem_s1'), inWs('mem_s2'), inGlobal('mem_g0'), inGlobal('mem_g1')]
      for (const x of all) await r.store.create(x)
      await r.cache.assemble(r.session)
      let order = r.frozen.at(-1)!.injectedIds
      expect([...order].sort()).toEqual(all.map(x => x.id).sort())
      const lastWriter = new Map<string, Step & { kind: 'edit' }>()
      const version = new Map<string, number>()
      let n = 0
      for (const s of steps) {
        if (s.kind === 'edit') {
          const target = all[s.idx]!
          n++
          await edit(r.store, target, { name: `名${n}`, summary: `摘要${n}` }, s.who === 'self' ? SELF : s.who === 'other' ? OTHER : undefined)
          lastWriter.set(target.id, s)
          version.set(target.id, n)
        } else if (s.kind === 'send') {
          const notice = await r.cache.changeNotice(r.session, SELF)
          const expected = order.filter(id => lastWriter.has(id) && lastWriter.get(id)!.who !== 'self').map(id => `- [${id}] 名${version.get(id)}（摘要${version.get(id)}）`)
          expect(notice === undefined ? [] : linesOf(notice.text)).toEqual(expected)
          lastWriter.clear()
        } else {
          r.cache.markStale(r.session)
          await r.cache.assemble(r.session)
          order = r.frozen.at(-1)!.injectedIds
          lastWriter.clear()
        }
      }
      for (const handle of opened.splice(0)) handle.close()
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
    }), { seed: interleaveSeed(), numRuns: interleaveRuns(30) })
  }, 180_000)
})
