import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { runSavePipeline, type PipelineResult, type SaveDelegation } from '../src/pipeline.ts'
import { scopeAt } from '../src/scope.ts'
import { workspaceDirName } from '../src/storage/paths.ts'
import { INDEX_DIR, INDEX_ENTRY_FILE, INDEX_TOPICS_DIR, readIndexFiles } from '../src/storage/index-store.ts'
import { DerivedIndex } from '../src/storage/derived-index.ts'
import { newWriteOp } from '../src/storage/table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { InMemoryKvTable } from './helpers/in-memory-kv.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { UNSORTED_PAGE, UNSORTED_TITLE, readIndex } from '../src/topic-index.ts'
import { applyPlan, planIndexOp } from '../src/topic-ops.ts'
import { maskSecrets } from '../src/secrets.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { candidate, record } from './helpers/record.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { writeTopicIndex } from './helpers/topic-fixture.ts'
import { applied, entryOf, membersOf, placement, rowOf, expectedRow } from './helpers/topic-placement.ts'

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const WS = '/tmp/pm-topic-pipeline'
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const registry = buildTypeRegistry({ template: 'office', customTypes: {} })
const SECRET = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(5)
const SUBAGENT: SaveDelegation = { depth: 1, parentSessionId: 'sess-1', mode: 'one-shot' }

let root: string
const journals: OpJournal[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-topic-pipeline-')) })
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close()
  await rm(root, { recursive: true, force: true })
})

/** isJournaled：缺省带操作日志和写锁；false 时两样都不接（退回进程内保护的那一档）。 */
function env(opts: { maxTopics?: number; isJournaled?: boolean } = {}) {
  const clock = { now: T0 }
  const now = () => clock.now
  const isJournaled = opts.isJournaled !== false
  const journal = new OpJournal({ path: join(root, '.state', 'op-journal.sqlite'), log: quietLog })
  journals.push(journal)
  const lock = createRootLock({ root, log: quietLog })
  const sidecar = new SidecarStore({ root, log: quietLog, now, schemas: sidecarSchemas, ...(isJournaled ? { lock } : {}) })
  const table = new FileTable({ root, stats: sidecar.recallStats, log: quietLog, now, ...(isJournaled ? { journal, lock } : {}) })
  const store = new MemoryStore(table, quietLog, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending, sidecar.lock)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  let seq = 0
  const save = async (partial: object, o: { session?: string; delegation?: SaveDelegation } = {}): Promise<PipelineResult> => {
    clock.now += MINUTE
    return runSavePipeline(candidate({ scope: 'workspace', force: true, sourceMode: 'agent-inferred', ...partial }), {
      store, registry, workspacePath: WS,
      session: { id: o.session ?? 'sess-1', lastSeq: ++seq, turnStartSeq: seq },
      snapshots, decisions, callId: `call-${seq}`, now,
      ...(opts.maxTopics !== undefined ? { maxTopics: opts.maxTopics } : {}),
      ...(o.delegation !== undefined ? { delegation: o.delegation } : {}),
    })
  }
  return { table, store, journal, decisions, snapshots, clock, save }
}
type Env = ReturnType<typeof env>

const dir = () => join(root, workspaceDirName(WS))
const at = () => scopeAt(WS)
const ws = (partial: Partial<MemoryRecord>) => record({ scope: 'workspace', workspacePath: WS, ...partial })

/** 项目目录：mem_a 在「上线」（曾用名「发版」），mem_b 在「回复语言」，mem_d 在「未整理」。 */
async function seed(e: Env) {
  await e.store.create(ws({ id: 'mem_a', name: '发版步骤', content: '先跑测试再打 tag' }))
  await e.store.create(ws({ id: 'mem_b', name: '回复用中文', content: '回复一律用中文' }))
  await e.store.create(ws({ id: 'mem_d', name: '写锁设计', content: '写锁用 SQLite' }))
  await e.table.maintain([dir()])
  await applied(e.table, dir(), { kind: 'assign', memoryIds: ['mem_a'], from: UNSORTED_TITLE, to: '发版', about: '发版的说明。' })
  await applied(e.table, dir(), { kind: 'rename', topic: '发版', name: '上线' })
  await applied(e.table, dir(), { kind: 'assign', memoryIds: ['mem_b'], from: UNSORTED_TITLE, to: '回复语言' })
}

/** update 只带给的这几个参数：不套新建的缺省字段（名称、正文、摘要、类型、标签、作用域、force）。 */
const bare = (e: Env, id: string, partial: object, opts?: Parameters<Env['save']>[1]) =>
  e.save({ action: 'update', id, name: undefined, type: undefined, scope: undefined, content: undefined, summary: undefined, tags: undefined, force: undefined, ...partial }, opts)

function saved(r: PipelineResult) {
  expect(r.kind, JSON.stringify(r)).toBe('saved')
  return r as Extract<PipelineResult, { kind: 'saved' }>
}
function updated(r: PipelineResult) {
  expect(r.kind, JSON.stringify(r)).toBe('updated')
  return r as Extract<PipelineResult, { kind: 'updated' }>
}
/** 把入口文件换成同名目录：读得到目录、读不出入口（不是不存在）。返回原文，修的时候写回。 */
async function breakEntry(): Promise<string> {
  const path = join(dir(), INDEX_DIR, INDEX_ENTRY_FILE)
  const text = await readFile(path, 'utf8')
  await rm(path)
  await mkdir(path)
  return text
}


const codes = (r: PipelineResult) => 'warnings' in r ? (r.warnings ?? []).map(w => w.code) : []

describe('保存时归主题的边界', () => {
  it.each(['主会话', '全局', '已取代'])('子会话只改主题时拒绝%s的记录', async kind => {
    const e = env()
    const target = kind === '全局' ? record({ id: 'mem_target' }) : ws({ id: 'mem_target', ...(kind === '已取代' ? { status: 'superseded' as const } : {}) })
    await e.store.create(target)
    const r = await bare(e, target.id, { topic: '上线' }, { session: 'sub-1', delegation: SUBAGENT })
    expect(r.kind).toBe('rejected')
    expect(r).toMatchObject({ code: 'subagent-restricted' })
  })

  it('子会话只改自己的待确认记录时仍说明接受后再归主题', async () => {
    const e = env()
    const own = saved(await e.save({ type: 'knowledge', name: '子任务观察', content: '观察到的事实', summary: '观察', sourceMode: 'environment-observed', force: undefined }, { session: 'sub-1', delegation: SUBAGENT }))
    const r = updated(await bare(e, own.record.id, { topic: '上线' }, { session: 'sub-1', delegation: SUBAGENT }))
    expect(codes(r)).toContain('topic-deferred-subagent')
  })

  it('新增关联并归主题时说明作用域和把握参数未生效', async () => {
    const e = env()
    await seed(e)
    const r = updated(await bare(e, 'mem_d', { related: ['mem_a'], topic: '上线', scope: 'global', confidence: 0.3 }))
    expect(r.record.related).toEqual(['mem_a'])
    expect(codes(r)).toContain('link-only-params-ignored')
  })

  it('只改主题写页失败时清掉没有确认且不待补做的账本条目', async () => {
    const e = env()
    await seed(e)
    const topics = join(dir(), INDEX_DIR, INDEX_TOPICS_DIR)
    await chmod(topics, 0o555)
    try { await expect(bare(e, 'mem_d', { topic: '新主题' })).rejects.toThrow() }
    finally { await chmod(topics, 0o755) }
    expect((await e.decisions.listSettled()).filter(d => d.kind === 'index-organize')).toEqual([])
    expect(e.journal.hasPending()).toBe(false)
  })

  it.each([undefined, '独立说明'])('索引读不出且没有主题时保留原有说明：%s', async topicAbout => {
    const e = env()
    await seed(e)
    await breakEntry()
    const r = saved(await e.save({ topicAbout }))
    expect(codes(r)).not.toContain('topic-pending')
    if (topicAbout !== undefined) expect(codes(r)).toContain('topic-about-alone')
  })

  it('主题页已有但入口未补时保存会写入说明且不称说明被忽略', async () => {
    const e = env()
    await seed(e)
    await writeFile(join(dir(), INDEX_DIR, INDEX_ENTRY_FILE), '# 记忆索引\n')
    const r = saved(await e.save({ topic: '上线', topicAbout: '补入的说明。' }))
    expect(await entryOf(dir())).toContainEqual({ name: '上线', about: '补入的说明。' })
    expect(codes(r)).not.toContain('topic-about-ignored')
  })

  it('用遮过密钥的主题名保存与只改主题都认到原来的页', async () => {
    const e = env()
    await seed(e)
    const name = `部署 ${SECRET}`
    await writeTopicIndex(dir(), [{ name, members: ['mem_a'] }], ['mem_b', 'mem_d'])
    const moved = updated(await bare(e, 'mem_b', { topic: maskSecrets(name) }))
    expect(codes(moved)).not.toContain('topic-created')
    const r = saved(await e.save({ topic: maskSecrets(name) }))
    expect(codes(r)).not.toContain('topic-created')
    expect(await membersOf(dir(), maskSecrets(name))).toContain(r.record.id)
  })

  it.each(['mem"q', 'mem\\q'])('只改主题认得属性里转义的记忆标识：%s', async id => {
    const e = env()
    await e.store.create(ws({ id }))
    await writeTopicIndex(dir(), [{ name: '上线', members: [] }], [id])
    const r = updated(await bare(e, id, { topic: '上线' }))
    expect(codes(r)).not.toContain('topic-not-indexed')
    expect(await membersOf(dir(), '上线')).toContain(id)
  })
})

// 只在入口原子替换之前中断：主题页已落盘，日志仍保留索引行步骤。
const entryFault = vi.hoisted(() => ({ path: '' }))
const removeFault = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === removeFault.path) throw new Error('删不掉')
      return actual.rm(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (entryFault.path !== '' && String(args[1]) === entryFault.path) throw new Error('入口写入前退出')
      return actual.rename(...args)
    },
  }
})
afterEach(() => { entryFault.path = '' })
afterEach(() => { removeFault.path = '' })

const topicOp = (name: string) => newWriteOp({ topic: { kind: 'choose', name, maxTopics: 30 } })

describe('索引行随文件变化', () => {
  it('保存与整理新建同名主题页时页面文字逐字相同', async () => {
    const e = env()
    const rec = ws({ id: 'mem_a', name: '甲' })
    await e.store.create(rec)
    await e.table.maintain([dir()])
    const before = (await readIndexFiles(dir()))!
    const planned = planIndexOp(before, { kind: 'assign', memoryIds: [rec.id], from: UNSORTED_TITLE, to: '部署' }, {
      maxTopics: 30, activeIds: new Set([rec.id]), now: e.clock.now,
    })
    expect(planned.kind).toBe('planned')
    if (planned.kind !== 'planned') throw new Error(planned.reason)
    const organized = applyPlan(before, planned.plan).files
    const op = topicOp('部署')
    const r = await e.table.update(rec.id, at(), r => r, op)
    await e.table.finishOp(op, r)
    const saved = (await readIndexFiles(dir()))!
    const page = readIndex(saved).topics.find(t => t.name === '部署')!.fileName
    expect(saved.pages[page]).toBe(organized.pages[page])
  })

  it('已有索引页使用 CRLF 时新建主题页的成员行也使用 CRLF', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_a', name: '甲' }))
    await e.table.maintain([dir()])
    const before = (await readIndexFiles(dir()))!
    await writeFile(join(dir(), INDEX_DIR, INDEX_ENTRY_FILE), before.entry.replace(/\n/g, '\r\n'))
    await writeFile(join(dir(), INDEX_DIR, INDEX_TOPICS_DIR, UNSORTED_PAGE), before.pages[UNSORTED_PAGE]!.replace(/\n/g, '\r\n'))
    const op = topicOp('部署')
    const r = await e.table.update('mem_a', at(), r => r, op)
    await e.table.finishOp(op, r)
    const files = (await readIndexFiles(dir()))!
    const page = readIndex(files).topics.find(t => t.name === '部署')!.fileName
    expect(files.pages[page]).toContain(`# 部署\r\n\r\n${await expectedRow(e.table, 'mem_a', at())}\r\n`)
    expect(files.pages[page]!.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it.each(['回复语言', '新主题', '上线'])('更新名称和摘要并归进%s时刷新链接且排在成员首位', async topic => {
    const e = env()
    await seed(e)
    await applied(e.table, dir(), { kind: 'assign', memoryIds: ['mem_d'], from: UNSORTED_TITLE, to: '上线' })
    const op = topicOp(topic)
    const r = await e.table.update('mem_a', at(), r => ({ ...r, name: '新的发布步骤', summary: '新的发布摘要' }), op)
    await e.table.finishOp(op, r)
    expect(await rowOf(dir(), 'mem_a')).toBe(await expectedRow(e.table, 'mem_a', at()))
    expect((await membersOf(dir(), topic))?.[0]).toBe('mem_a')
    expect((await placement(dir())).mem_a).toEqual([topic])
  })

  it('旧目录没有主题索引时彻底删除也清掉总览中的名称和摘要', async () => {
    const e = env()
    for (const id of ['mem_a', 'mem_b', 'mem_c']) await e.store.create(ws({ id, name: `${id}名称`, summary: `${id}摘要`, content: id === 'mem_b' ? FAKE_SECRET.sk : '正文' }))
    await writeFile(join(dir(), 'MEMORY.md'), '# 记忆\nmem_a名称 mem_a摘要\nmem_b名称 mem_b摘要\nmem_c名称 mem_c摘要\n')
    expect(await readIndexFiles(dir())).toBeUndefined()
    await e.table.delete('mem_b', at())
    const text = await readFile(join(dir(), 'MEMORY.md'), 'utf8')
    expect(text).not.toContain('mem_b名称')
    expect(text).not.toContain('mem_b摘要')
    expect((await placement(dir())).mem_a).toEqual([UNSORTED_TITLE])
    expect((await placement(dir())).mem_c).toEqual([UNSORTED_TITLE])
  })

  it('保存到手写含密钥的主题时入口和派生库只保留遮盖后的标题', async () => {
    const e = env()
    await seed(e)
    const derived = new DerivedIndex({ path: join(root, '.state', 'review-derived.sqlite'), log: quietLog })
    const stats = new InMemoryKvTable<RecallStats>()
    const table = new FileTable({ root, stats, index: derived, log: quietLog, now: () => T0 })
    const name = `部署 ${FAKE_SECRET.sk}`
    try {
      await writeTopicIndex(dir(), [{ name, members: ['mem_a'] }], ['mem_b', 'mem_d'])
      // 页已写好而入口未补，保存必须从标题生成入口。
      await writeFile(join(dir(), INDEX_DIR, INDEX_ENTRY_FILE), '# 记忆索引\n')
      const op = topicOp(maskSecrets(name))
      await table.create(ws({ id: 'mem_new', name: '新记录' }), op)
      await table.finishOp(op)
      const files = (await readIndexFiles(dir()))!
      expect(files.entry).not.toContain(FAKE_SECRET.sk)
      expect(JSON.stringify(derived.topicPages(dir()))).not.toContain(FAKE_SECRET.sk)
      expect(await membersOf(dir(), maskSecrets(name))).toEqual(['mem_new', 'mem_a'])
      expect(Object.keys(files.pages)).toEqual(['_unsorted.md', 't0.md'])
    } finally { derived.close() }
  })

  it.each(['mem"q', 'mem\\q'])('保存时归主题认得转义后的成员标识：%s', async id => {
    const e = env()
    await e.store.create(ws({ id }))
    await writeTopicIndex(dir(), [{ name: '上线', members: [] }], [id])
    const op = topicOp('上线')
    const r = await e.table.update(id, at(), r => ({ ...r, summary: '更新摘要' }), op)
    await e.table.finishOp(op, r)
    expect(await membersOf(dir(), '上线')).toEqual([id])
    expect((await placement(dir()))[id]).toEqual(['上线'])
  })

  it('原位更新只替换目标行并保留其他行的换行和列表符', async () => {
    const e = env()
    await seed(e)
    await writeTopicIndex(dir(), [{ name: '上线', members: ['mem_a', 'mem_d'] }, { name: '回复语言', members: ['mem_b'] }])
    const page = join(dir(), INDEX_DIR, INDEX_TOPICS_DIR, 't0.md')
    const other = join(dir(), INDEX_DIR, INDEX_TOPICS_DIR, 't1.md')
    const old = (await readFile(page, 'utf8')).replace(/^- /gm, '* ').replace(/\n/g, '\r\n')
    const untouched = (await readFile(other, 'utf8')).replace(/^- /gm, '+ ').replace(/\n/g, '\r\n')
    await writeFile(page, old)
    await writeFile(other, untouched)
    await utimes(other, T0 / 1000, T0 / 1000)
    const stamp = (await stat(other)).mtimeMs
    await e.table.update('mem_a', at(), r => ({ ...r, summary: '换过的摘要' }))
    expect(await readFile(other, 'utf8')).toBe(untouched)
    expect((await stat(other)).mtimeMs).toBe(stamp)
    const expected = old.split('\r\n').map(line => line.includes('"mem_a"') ? undefined : line)
    const actual = (await readFile(page, 'utf8')).split('\r\n').map(line => line.includes('"mem_a"') ? undefined : line)
    expect(actual).toEqual(expected)
    expect(await rowOf(dir(), 'mem_a')).toBe((await expectedRow(e.table, 'mem_a', at())) + '\r')
  })

  it('首次建页后入口写入前退出再补做与不中断的索引逐字一致', async () => {
    const e = env()
    const rec = ws({ id: 'mem_first', name: '首条记忆' })
    const op = topicOp('上线')
    await e.table.create(rec, op)
    await e.table.finishOp(op)
    const expected = await readIndexFiles(dir())
    await rm(join(dir(), INDEX_DIR), { recursive: true })
    entryFault.path = join(dir(), INDEX_DIR, INDEX_ENTRY_FILE)
    const interrupted = topicOp('上线')
    await e.table.update(rec.id, at(), r => r, interrupted)
    await e.table.finishOp(interrupted)
    expect(e.journal.hasPending()).toBe(true)
    expect((await readIndexFiles(dir()))!.entry).toBe('')
    entryFault.path = ''
    const resumed = env()
    await resumed.table.update(rec.id, at(), r => ({ ...r, content: '继续正文' }))
    expect(await readIndexFiles(dir())).toEqual(expected)
    expect(resumed.journal.hasPending()).toBe(false)
  })
})

describe('手写索引的保存回归', () => {
  it('未整理页围栏未闭合时连续更新两次不追加索引行', async () => {
    const e = env()
    await seed(e)
    await writeTopicIndex(dir(), [{ name: '上线', members: ['mem_a'] }])
    const path = join(dir(), INDEX_DIR, INDEX_TOPICS_DIR, UNSORTED_PAGE)
    const before = '# 未整理\n\n```md\n手写内容\n'
    await writeFile(path, before)
    for (const summary of ['第一次摘要', '第二次摘要']) {
      await e.table.update('mem_d', at(), r => ({ ...r, summary }))
      expect(await readFile(path, 'utf8')).toBe(before)
    }
  })

  it('手写密钥标题尚未遮盖时新建闸仍列出同主题成员', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_member', name: 'm', summary: 'bb', content: 'qwertyuixx' }))
    const name = `部署 ${SECRET}`
    await writeTopicIndex(dir(), [{ name, members: ['mem_member'] }])
    const r = saved(await e.save({ name: 'n', summary: 'aa', content: 'qwertyuiop', topic: maskSecrets(name) }))
    expect((r.similar ?? []).map(s => s.id)).toEqual(['mem_member'])
  })

  it('直接向尚未遮盖的手写主题新建时不提示新建主题且沿用原页', async () => {
    const e = env()
    await seed(e)
    const name = `部署 ${SECRET}`
    await writeTopicIndex(dir(), [{ name, members: ['mem_a'] }], ['mem_b', 'mem_d'])
    const r = saved(await e.save({ topic: maskSecrets(name) }))
    expect(codes(r)).not.toContain('topic-created')
    const files = (await readIndexFiles(dir()))!
    expect(Object.keys(files.pages).sort()).toEqual(['_unsorted.md', 't0.md'])
    expect(readIndex(files).topics.find(t => t.fileName === 't0.md')!.memberIds).toEqual([r.record.id, 'mem_a'])
  })
})

describe('不完整清单中的彻底删除', () => {
  it('彻底删除后同层仍有在用副本时保留原主题并更新成员行', async () => {
    const e = env()
    const target = ws({ id: 'mem_twin', name: '选中的名称', summary: '选中的摘要', updatedAt: T0 })
    await e.store.create(target)
    await writeTopicIndex(dir(), [{ name: '上线', members: [target.id] }])
    await e.table.maintain([dir()])
    const selected = (await e.table.locate(target.id, at()))!
    const twin = join(dir(), '另一份.md')
    const survivor = { ...target, name: '剩余副本名称', summary: '剩余副本摘要', updatedAt: T0 - MINUTE }
    const text = encodeRecord(survivor, {})
    await writeFile(twin, text)
    expect((await e.table.locate(target.id, at()))!.filePath).toBe(selected.filePath)
    expect((await placement(dir()))[target.id]).toEqual(['上线'])
    removeFault.path = twin
    try { await expect(e.table.delete(target.id, at())).rejects.toThrow('删不掉') }
    finally { removeFault.path = '' }
    await expect(readFile(selected.filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(e.journal.hasPending()).toBe(true)
    const resumed = env()
    await resumed.table.maintain([])
    expect(resumed.journal.hasPending()).toBe(false)
    expect(await readFile(twin, 'utf8')).toBe(text)
    expect((await resumed.table.locate(target.id, at()))!.filePath).toBe(twin)
    expect((await placement(dir()))[target.id]).toEqual(['上线'])
    expect(await membersOf(dir(), UNSORTED_TITLE)).not.toContain(target.id)
    const row = await rowOf(dir(), target.id)
    expect(row).toBe(await expectedRow(resumed.table, target.id, at()))
    expect(row).toContain(encodeURIComponent('另一份.md'))
    expect(row).toContain(survivor.name)
    expect(row).toContain(survivor.summary)
  })

  it('已有主题索引且另有文件解析失败时只清掉明确删除的成员', async () => {
    const e = env()
    const target = ws({ id: 'mem_purged', name: '待清除的名称', summary: '待清除的摘要' })
    await e.store.create(target)
    await e.store.create(ws({ id: 'mem_broken', name: '损坏记录', summary: '仍需保留的摘要' }))
    await writeTopicIndex(dir(), [{ name: '上线', members: [target.id, 'mem_broken'] }], [target.id, 'mem_broken'])
    await e.table.maintain([dir()])
    const files = (await readIndexFiles(dir()))!
    const row = await expectedRow(e.table, target.id, at())
    // 同一个成员手写进两个页面，彻底删除要把两处和总览一起清掉。
    await writeFile(join(dir(), INDEX_DIR, INDEX_TOPICS_DIR, UNSORTED_PAGE), files.pages[UNSORTED_PAGE]! + row + '\n')
    await writeFile(join(dir(), 'MEMORY.md'), '# 记忆索引\n' + row + '\n')
    const broken = await e.table.locate('mem_broken', at())
    await writeFile(broken!.filePath, '无法解析的记忆文件')
    expect(await e.store.hardDelete(target, { at: at() })).toBe(true)
    const after = (await readIndexFiles(dir()))!
    const overview = await readFile(join(dir(), 'MEMORY.md'), 'utf8')
    for (const text of [...Object.values(after.pages), overview]) {
      for (const value of [target.id, target.name, target.summary]) expect(text).not.toContain(value)
    }
    expect(after.pages['t0.md']).toContain('mem_broken')
    expect(after.pages['t0.md']).toContain('仍需保留的摘要')
    expect(overview).toContain('## [上线](_index/topics/t0.md)\n\n1 条')
  })
})
