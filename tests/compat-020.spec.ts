import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { anchorsOf, type MemoryRecord } from '../src/record-schema.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { splitFrontmatter } from '../src/storage/frontmatter.ts'
import { STATE_CHANGE_VERSION, type HistoryVersion } from '../src/storage/history.ts'
import { GLOBAL_DIR, HISTORY_DIR, workspaceDirName } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { record } from './helpers/record.ts'
import { openRelease020Config, openRelease020Pending, openRelease020Table } from './helpers/release-020.ts'
import { Config } from '../src/index.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'

// 新旧版本共用一个记忆根：用 0.2.0 发布包对同一个临时记忆根读写，再由新版本读，对照 spec「兼容与迁移」的表。
// 这里覆盖格式定稿涉及的两行和历史版本涉及的「删除」「提升或移动」两行，后面的票各自补自己那一行。

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const global = { kind: 'global' } as const
const NEW_KEYS = ['sourceTrail', 'stateSince', 'factTime', 'lastChange', 'related', 'premises', 'recall', 'locked', 'lockedUntil'] as const

let root: string
let stats: InMemoryKvTable<RecallStats>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-compat-020-'))
  stats = new InMemoryKvTable<RecallStats>()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const current = () => new FileTable({ root, stats, log: quiet })
const withNewKeys = (): MemoryRecord => record({
  name: '发版步骤', type: 'project', createdAt: Date.UTC(2026, 10, 1), updatedAt: Date.UTC(2026, 10, 2), lastConfirmedAt: Date.UTC(2026, 10, 2),
  source: { sessionId: 's2', eventRange: [5, 9], sourceMode: 'user-explicit' },
  sourceTrail: [{ sessionId: 's2', eventRange: [5, 9], sourceMode: 'user-explicit', at: Date.UTC(2026, 10, 2), initiator: 'user', evidence: { user: true, tool: false }, change: 'refine', by: 'main' }],
  stateSince: Date.UTC(2026, 10, 1), factTime: '2026-11', lastChange: { kind: 'refine', at: Date.UTC(2026, 10, 2), op: 'op_1', by: 'main' },
  related: ['mem_rel'], premises: [{ id: 'mem_pre', digest: 'd1:0123456789abcdef' }], recall: 'unlisted',
  locked: true, lockedUntil: Date.UTC(2027, 0, 1),
})
/** 一条记忆状态变化前的样子：直接放进它那一层的历史目录。 */
const versionOf = (r: MemoryRecord): HistoryVersion => ({ versionId: '20261101T000000000Z', record: r, extras: {}, startedAt: r.createdAt, endedAt: r.updatedAt + 1, kind: STATE_CHANGE_VERSION, writes: [] })
const exists = (path: string) => stat(path).then(() => true, () => false)
const pick = (r: MemoryRecord) => Object.fromEntries(NEW_KEYS.map(k => [k, r[k]]))
/** 文件上的提交标记：不在记录里，随定位结果带出来。 */
const stampOf = async (id: string) => (await current().locate(id, global))?.writeOp
const globalFile = async () => {
  const dir = join(root, 'global')
  const name = (await readdir(dir)).find(f => f.endsWith('.md') && f !== 'MEMORY.md')!
  return join(dir, name)
}

describe('新旧版本共用一个记忆根（0.2.0 发布包）', () => {
  it('0.2.0 整条更新一条记忆：顶层的新键原样保留', async () => {
    const rec = withNewKeys()
    await current().create(rec)
    const stamp = await stampOf(rec.id)
    expect(stamp).toMatch(/^op_/)
    const old = await openRelease020Table({ root, stats })
    await old.update(rec.id, global, r => ({ ...r, content: '旧版本改过的正文', updatedAt: r.updatedAt + 1000 }))
    const after = await current().locate(rec.id, global)
    expect(after?.record.content).toBe('旧版本改过的正文')
    expect(pick(after!.record)).toEqual(pick(rec))
    expect(after?.writeOp).toBe(stamp)
  })

  it('0.2.0 整条替换一条记忆并换了出处：新键照旧保留，换上的出处补成出处清单最前一个没有发起方的锚', async () => {
    const rec = withNewKeys()
    await current().create(rec)
    const stamp = await stampOf(rec.id)
    const old = await openRelease020Table({ root, stats })
    const seen = (await old.locate(rec.id, global))!.record
    expect(seen).not.toHaveProperty('sourceTrail')
    const replaced = { sessionId: 's9', eventRange: [20, 22] as [number, number], sourceMode: 'agent-inferred' as const }
    await old.put({ ...seen, content: '旧版本整条替换的正文', source: replaced, updatedAt: Date.UTC(2026, 10, 3) }, global)
    const after = (await current().locate(rec.id, global))!.record
    expect(after.content).toBe('旧版本整条替换的正文')
    expect(pick(after)).toEqual(pick(rec))
    expect(await stampOf(rec.id)).toBe(stamp)
    const anchors = anchorsOf(after)
    expect(anchors[0]).toEqual({ ...replaced, at: Date.UTC(2026, 10, 3) })
    expect(anchors.slice(1)).toEqual(rec.sourceTrail)
  })

  it('0.2.0 写入一条记忆：新版本照读，不带新键', async () => {
    const old = await openRelease020Table({ root, stats })
    const rec = record({ name: '旧版本写的', createdAt: 5, updatedAt: 5, lastConfirmedAt: 5 })
    await old.create(rec)
    const after = await current().locate(rec.id, global)
    expect(after?.record.name).toBe('旧版本写的')
    expect(pick(after!.record)).toEqual(Object.fromEntries(NEW_KEYS.map(k => [k, undefined])))
  })

  it('两边同时改同一条（各 10 次，交错发起）：一次都不丢，跨版本共用同一把写锁', async () => {
    const rec = record({ name: '交替写入', tags: [] })
    const table = current()
    await table.create(rec)
    const old = await openRelease020Table({ root, stats })
    const addTag = (tag: string) => (r: MemoryRecord): MemoryRecord => ({ ...r, tags: [...r.tags, tag] })
    const writes = Array.from({ length: 10 }, (_, i) => [
      old.update(rec.id, global, addTag(`old-${i}`)),
      table.update(rec.id, global, addTag(`new-${i}`)),
    ]).flat()
    await Promise.all(writes)
    const tags = (await table.locate(rec.id, global))!.record.tags
    expect([...tags].sort()).toEqual([...Array.from({ length: 10 }, (_, i) => [`new-${i}`, `old-${i}`]).flat()].sort())
  })

  it('两边轮流写同一条：键的顺序一致，只改正文时文件里只有正文、digest 和提交标记三行变', async () => {
    const rec = withNewKeys()
    await current().create(rec)
    const old = await openRelease020Table({ root, stats })
    await old.update(rec.id, global, r => ({ ...r, content: '旧版本改过的正文' }))
    const byOld = await readFile(await globalFile(), 'utf8')
    await current().update(rec.id, global, r => ({ ...r, content: '新版本改过的正文' }))
    const byNew = await readFile(await globalFile(), 'utf8')
    expect(Object.keys(splitFrontmatter(byNew).data)).toEqual(Object.keys(splitFrontmatter(byOld).data))
    const oldLines = byOld.split('\n')
    const changed = byNew.split('\n').flatMap((line, i) => line === oldLines[i] ? [] : [line.split(':')[0]])
    expect(changed).toEqual(['digest', 'lastWriteOp', '新版本改过的正文'])
  })

  it('0.2.0 彻底删除一条记忆：历史版本留着，下次整份核对清掉', async () => {
    const rec = record({ name: '发版步骤' })
    const table = current()
    await table.create(rec)
    const dir = join(root, GLOBAL_DIR)
    await table.history.write({ dir, loc: { scope: 'global' } }, versionOf(rec))
    const old = await openRelease020Table({ root, stats })
    expect(await old.delete(rec.id, global)).toBe(true)
    expect(await exists(join(dir, HISTORY_DIR, rec.id))).toBe(true)
    await current().maintain([dir])
    expect(await exists(join(dir, HISTORY_DIR, rec.id))).toBe(false)
  })

  it('0.2.0 提升一条记忆：只搬记忆文件，历史版本留在项目里；下次整份核对按 id 找到全局那份，把历史目录迁过去', async () => {
    const WS = '/tmp/pm-compat-020-ws'
    const rec = record({ name: '发版步骤', scope: 'workspace', workspacePath: WS })
    const table = current()
    await table.create(rec)
    const wsDir = join(root, workspaceDirName(WS))
    const globalDir = join(root, GLOBAL_DIR)
    await table.history.write({ dir: wsDir, loc: { scope: 'workspace', workspacePath: WS } }, versionOf(rec))
    const old = await openRelease020Table({ root, stats })
    await old.update(rec.id, { kind: 'workspace', workspacePath: WS }, ({ workspacePath: _w, ...r }) => ({ ...r, scope: 'global' }))
    expect((await current().locate(rec.id, global))?.record.scope).toBe('global')
    expect(await exists(join(wsDir, HISTORY_DIR, rec.id))).toBe(true)
    await current().maintain([wsDir])
    expect(await exists(join(wsDir, HISTORY_DIR, rec.id))).toBe(false)
    expect((await current().history.list({ dir: globalDir, loc: { scope: 'global' } }, rec.id)).map(v => v.record.content)).toEqual([rec.content])
  })

  it('0.2.0 丢掉 source 里它不认识的子字段，所以锚的新字段放在出处清单里', async () => {
    const rec = withNewKeys()
    await current().create(rec)
    const file = await globalFile()
    const raw = await readFile(file, 'utf8')
    await writeFile(file, raw.replace('sourceMode: user-explicit\n', 'sourceMode: user-explicit\n  initiator: user\n'))
    expect(splitFrontmatter(await readFile(file, 'utf8')).data.source).toHaveProperty('initiator', 'user')
    const old = await openRelease020Table({ root, stats })
    await old.update(rec.id, global, r => ({ ...r, summary: '旧版本改过的摘要' }))
    const fm = splitFrontmatter(await readFile(await globalFile(), 'utf8')).data
    expect(fm.source).not.toHaveProperty('initiator')
    expect((fm.sourceTrail as Array<Record<string, unknown>>)[0]).toMatchObject({ initiator: 'user', by: 'main' })
  })

  it('0.2.0 读待决账本：整理索引留的记录它解析不了，跳过并记日志；它认得的条目照读，那条记录原样留在盘上', async () => {
    const decisions = new PendingDecisionsStore(new SidecarStore({ root, schemas: sidecarSchemas, log: quiet }).pending)
    const { entry: conflict } = await decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '两条说法相反', fingerprint: 'fp' }, 1)
    await decisions.addIndexRun('pd_organize', { summary: '整理了一次主题索引', workspace: 'global' }, 2)
    await decisions.appendIndexReceipt('pd_organize', { op: 'op_1', plan: { kind: 'describe', page: '发版.md', about: '新说明。', before: '旧说明。' } })
    await decisions.confirmIndexReceipt('pd_organize', 'op_1')
    const warnings: string[] = []
    const old = await openRelease020Pending({ root, warnings })
    expect((await old.list()).map(([, e]) => e.id)).toEqual([conflict.id])
    expect(warnings).toHaveLength(1)
    expect((await decisions.listSettled()).map(e => [e.id, e.indexRun?.receipts.length])).toEqual([['pd_organize', 1]])
  })
})

describe('共享配置里的新键', () => {
  const written = { userDictionaryPath: '/dict/user.txt', source: 'both', memoryQuotes: true, dialogueTokenBudget: 1800, queryExpansion: false, dialogueToolResults: true }

  it('0.2.0 读到检索来源、带原话、原话上限等新键时照常加载、不报错，自己认得的键照旧', async () => {
    const Release020Config = await openRelease020Config()
    const value = new Release020Config({ search: written })
    expect((value.search.userDictionaryPath as { get(): unknown }).get()).toBe('/dict/user.txt')
    // 新键原样留着、不校验，0.2.0 的代码不读它们：写成它不认识的值也照常加载
    expect(() => new Release020Config({ search: { ...written, source: 42, memoryQuotes: 'yes' } })).not.toThrow()
  })

  it('新版读到这两个键写过的值照旧，没写的用新的默认值', () => {
    const value = new Config({ search: { source: 'memory', memoryQuotes: false } } as never)
    expect(value.search.source.get()).toBe('memory'); expect(value.search.memoryQuotes.get()).toBe(false)
    const defaults = new Config({} as never)
    expect(defaults.search.source.get()).toBe('both'); expect(defaults.search.memoryQuotes.get()).toBe(true)
  })
})
