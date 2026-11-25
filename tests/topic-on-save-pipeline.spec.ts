import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { runSavePipeline, type PipelineResult, type SaveDelegation, type SaveWarning } from '../src/pipeline.ts'
import { executeSave, renderSaveResult, type SaveToolDeps } from '../src/tools/save.ts'
import { SAVE_TOPIC_ABOUT_DESCRIPTION, SAVE_TOPIC_DESCRIPTION, createSaveTool } from '../src/tools/save-tool.ts'
import { executeUndo } from '../src/tools/undo.ts'
import { executeSearch, type SearchToolDeps } from '../src/tools/search.ts'
import { scopeAt } from '../src/scope.ts'
import { workspaceDirName } from '../src/storage/paths.ts'
import { INDEX_DIR, INDEX_ENTRY_FILE, INDEX_TOPICS_DIR } from '../src/storage/index-store.ts'
import { OpJournal } from '../src/storage/op-journal.ts'
import { createRootLock } from '../src/storage/root-lock.ts'
import { UNSORTED_TITLE, memberLine, readIndex } from '../src/topic-index.ts'
import { maskSecrets } from '../src/secrets.ts'
import { GATE_CANDIDATE_WINDOW } from '../src/create-gate.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import type { WarningCode } from '../src/contract-codes.ts'
import {
  NEAREST_TOPICS_HINT, NEAREST_TOPICS_LEAD, TOPIC_ABOUT_ALONE_TEXT, TOPIC_ABOUT_IGNORED_TEXT, TOPIC_CREATED_LEAD, TOPIC_DEFERRED_SUBAGENT_TEXT,
  TOPIC_FULL_LEAD, TOPIC_INVALID_LEAD, TOPIC_NAME_PROBLEM_TEXT, TOPIC_NOT_INDEXED_TEXT, TOPIC_ONLY_IGNORED_LEAD, TOPIC_PENDING_TEXT, TOPIC_PLACED_UNSORTED,
  TOPIC_PLACE_KEPT, TOPIC_SKIPPED_TEXT, TOPIC_UNREADABLE_TEXT,
} from '../src/save-signals.ts'
import { candidate, record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { userTurnLog } from './helpers/session-log.ts'
import { indexTree } from './helpers/topic-index.ts'
import { writeTopicIndex } from './helpers/topic-fixture.ts'
import { applied, entryOf, membersOf, placement } from './helpers/topic-placement.ts'

// 保存时归主题：经真实的保存管线，落在真实文件表、操作日志和 .state 侧表上。
// 记忆都放在一个项目里（改全局记忆要确认码，和这里要看的无关）。

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
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
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
  const undo = (decisionId: string) => executeUndo({ decisionId }, { workspacePath: WS }, { store, decisions, snapshots, ignores, now })
  return { table, store, journal, decisions, snapshots, clock, save, undo }
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
const topicCodes = (warnings: readonly SaveWarning[] | undefined) => (warnings ?? []).map(w => w.code).filter(code => code.startsWith('topic'))
function warning(r: { warnings?: SaveWarning[] }, code: WarningCode): string {
  const hit = (r.warnings ?? []).find(w => w.code === code)
  expect(hit, `${code} 应在结果里：${JSON.stringify(r.warnings)}`).toBeDefined()
  return hit!.text
}
/** 把入口文件换成同名目录：读得到目录、读不出入口（不是不存在）。返回原文，修的时候写回。 */
async function breakEntry(): Promise<string> {
  const path = join(dir(), INDEX_DIR, INDEX_ENTRY_FILE)
  const text = await readFile(path, 'utf8')
  await rm(path)
  await mkdir(path)
  return text
}

/** 最相近主题那一段：引导语、每个名字带中文引号、顿号连起来，后面跟改归的说明。 */
const nearestPart = (names: readonly string[]) => `${NEAREST_TOPICS_LEAD}${names.map(n => `「${n}」`).join('、')}`

describe('新建时给主题', () => {
  it('给现有主题（按曾用名、首尾带空白）：存进去插到那一页最前，结果里没有主题相关的说明', async () => {
    const e = env()
    await seed(e)
    const r = saved(await e.save({ name: '新的发版约定', topic: ' 发版 ' }))
    expect(await membersOf(dir(), '上线')).toEqual([r.record.id, 'mem_a'])
    expect(topicCodes(r.warnings)).toEqual([])
  })

  it('给的主题还没有：新建主题，结果说建了，列出名字最相近的两个现有主题和改归的办法', async () => {
    const e = env()
    await seed(e)
    const r = saved(await e.save({ name: '回复的语气', topic: '回复语气', topicAbout: '回复时的语气和措辞。' }))
    expect(await membersOf(dir(), '回复语气')).toEqual([r.record.id])
    expect((await entryOf(dir())).at(-1)).toEqual({ name: '回复语气', about: '回复时的语气和措辞。' })
    const text = warning(r, 'topic-created')
    expect(text).toContain(`${TOPIC_CREATED_LEAD}「回复语气」`)
    expect(text).toContain(nearestPart(['回复语言', '上线']))
    expect(text).toContain(NEAREST_TOPICS_HINT)
    expect(topicCodes(r.warnings)).toEqual(['topic-created'])
  })

  it('这个项目还没有任何主题：建出来，结果里不带最相近主题那一段', async () => {
    const e = env()
    const r = saved(await e.save({ topic: '第一个主题' }))
    expect(await placement(dir())).toEqual({ [r.record.id]: ['第一个主题'] })
    const text = warning(r, 'topic-created')
    expect(text).toContain(`${TOPIC_CREATED_LEAD}「第一个主题」`)
    expect(text).not.toContain(NEAREST_TOPICS_LEAD)
  })

  it('主题数到上限：照常保存，进「未整理」，说明原因并列出最相近的现有主题', async () => {
    const e = env({ maxTopics: 2 })
    await seed(e)
    const entryBefore = await entryOf(dir())
    const r = saved(await e.save({ name: '回复里的称呼', topic: '回复称呼', topicAbout: '说明。' }))
    expect(await membersOf(dir(), UNSORTED_TITLE)).toEqual([r.record.id, 'mem_d'])
    expect(await entryOf(dir())).toEqual(entryBefore)
    const text = warning(r, 'topic-full')
    expect(text).toContain(`${TOPIC_FULL_LEAD}「回复称呼」`)
    expect(text).toContain(TOPIC_PLACED_UNSORTED)
    expect(text).toContain(nearestPart(['回复语言', '上线']))
    expect(text).toContain(NEAREST_TOPICS_HINT)
  })

  it('名字不能用：照常保存，进「未整理」，说明为什么不能用并列出最相近的现有主题', async () => {
    const e = env()
    await seed(e)
    const r = saved(await e.save({ topic: '上线、回复' }))
    expect(await membersOf(dir(), UNSORTED_TITLE)).toEqual([r.record.id, 'mem_d'])
    const text = warning(r, 'topic-invalid')
    expect(text).toContain(TOPIC_INVALID_LEAD)
    expect(text).toContain(TOPIC_NAME_PROBLEM_TEXT['bad-char'])
    expect(text).toContain(TOPIC_PLACED_UNSORTED)
    expect(text).toContain(nearestPart(['上线', '回复语言']))
  })

  it('给的是现有主题又带了 topicAbout：说明不改，结果里说明没生效', async () => {
    const e = env()
    await seed(e)
    const before = (await entryOf(dir())).find(t => t.name === '上线')
    const r = saved(await e.save({ topic: '上线', topicAbout: '想改成别的说明。' }))
    expect(await membersOf(dir(), '上线')).toEqual([r.record.id, 'mem_a'])
    expect((await entryOf(dir())).find(t => t.name === '上线')).toEqual(before)
    expect(warning(r, 'topic-about-ignored')).toBe(TOPIC_ABOUT_IGNORED_TEXT)
  })

  it('只给 topicAbout 不给 topic：照常保存进「未整理」，结果里说明没生效', async () => {
    const e = env()
    await seed(e)
    const r = saved(await e.save({ topicAbout: '一句说明。' }))
    expect(await membersOf(dir(), UNSORTED_TITLE)).toEqual([r.record.id, 'mem_d'])
    expect(warning(r, 'topic-about-alone')).toBe(TOPIC_ABOUT_ALONE_TEXT)
  })

  it('子 agent 带了 topic：不记、不建主题，结果里说接受后再归；接受之后进「未整理」', async () => {
    const e = env()
    await seed(e)
    const entryBefore = await entryOf(dir())
    const r = saved(await e.save({ type: 'knowledge', name: '子任务观察', content: '观察到的事实', summary: '观察', sourceMode: 'environment-observed', force: undefined, topic: '子任务' },
      { session: 'sub-1', delegation: SUBAGENT }))
    expect(warning(r, 'topic-deferred-subagent')).toBe(TOPIC_DEFERRED_SUBAGENT_TEXT)
    expect((await placement(dir()))[r.record.id]).toBeUndefined()
    expect(await entryOf(dir())).toEqual(entryBefore)
    await e.store.update(r.record, rec => ({ ...rec, delegation: { ...rec.delegation!, reviewed: { by: 'main', at: T0 } } }), at())
    expect(await membersOf(dir(), UNSORTED_TITLE)).toEqual([r.record.id, 'mem_d'])
  })

  it('主题名和说明里的密钥：索引文件和操作日志里都是遮过的，结果里回显的名字也是', async () => {
    const e = env()
    await seed(e)
    const r = saved(await e.save({ topic: `部署 ${SECRET}`, topicAbout: `用的 key 是 ${SECRET}` }))
    const masked = maskSecrets(`部署 ${SECRET}`)
    expect(masked).not.toContain(SECRET)
    expect(await membersOf(dir(), masked)).toEqual([r.record.id])
    expect(JSON.stringify(await indexTree(dir()))).not.toContain(SECRET)
    expect(warning(r, 'topic-created')).toContain(`「${masked}」`)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('索引读不出：照常保存，结果里说之后补做；日志行里的主题名和说明已遮盖；修好之后归进去', async () => {
    const e = env()
    await seed(e)
    const entryPath = join(dir(), INDEX_DIR, INDEX_ENTRY_FILE)
    const entry = await readFile(entryPath, 'utf8')
    await rm(entryPath)
    await mkdir(entryPath)
    const r = saved(await e.save({ topic: `上线 ${SECRET}`, topicAbout: `key ${SECRET}` }))
    expect(warning(r, 'topic-pending')).toBe(TOPIC_PENDING_TEXT)
    const pending = JSON.stringify(e.journal.pending())
    expect(pending).toContain(maskSecrets(`上线 ${SECRET}`))
    expect(pending).not.toContain(SECRET)
    await rm(entryPath, { recursive: true })
    await writeFile(entryPath, entry)
    const next = env()
    await next.store.update((await next.store.get('mem_d', at()))!, rec => ({ ...rec, content: `${rec.content}。` }), at())
    expect(await membersOf(dir(), maskSecrets(`上线 ${SECRET}`))).toEqual([r.record.id])
    expect(next.journal.hasPending()).toBe(false)
  })
})

describe('新建闸的候选加上同主题成员', () => {
  it('同主题成员不过罕见词否决：排在检索命中的后面、按字符相似度降序补上，合计五条', async () => {
    const e = env()
    // 和新记忆有一个罕见词相同、不在主题里的一条，检索能命中
    await e.store.create(ws({ id: 'mem_r', name: 'r', summary: 'rr', content: 'qwertyuiop 另一件事' }))
    // 主题成员：和新记忆没有相同的词，正文和新记忆的字符相似度依次降低
    const members = [['mem_m1', 'qwertyuixx'], ['mem_m2', 'qwertyxxxx'], ['mem_m3', 'qwerxxxxxx'], ['mem_m4', 'qwxxxxxxxx'], ['mem_m5', 'xxxxxxxxxx']] as const
    for (const [id, content] of members) await e.store.create(ws({ id, name: id, summary: 'bb', content }))
    await e.table.maintain([dir()])
    await applied(e.table, dir(), { kind: 'assign', memoryIds: members.map(([id]) => id), from: UNSORTED_TITLE, to: '键盘' })
    const r = saved(await e.save({ name: 'n', summary: 'aa', content: 'qwertyuiop', topic: '键盘' }))
    expect((r.similar ?? []).map(s => s.id)).toEqual(['mem_r', 'mem_m1', 'mem_m2', 'mem_m3', 'mem_m4'])
    expect(await membersOf(dir(), '键盘')).toEqual([r.record.id, 'mem_m1', 'mem_m2', 'mem_m3', 'mem_m4', 'mem_m5'])
  })
})

describe('更新时给主题', () => {
  it('整条更新带 topic：内容照改，这条挪到该主题最前', async () => {
    const e = env()
    await seed(e)
    const r = updated(await e.save({ action: 'update', id: 'mem_b', change: 'refine', name: '回复用中文', summary: '摘要', content: '回复一律用中文，代码注释也是', topic: '上线' }))
    expect(r.record.content).toContain('代码注释')
    expect(await membersOf(dir(), '上线')).toEqual(['mem_b', 'mem_a'])
    expect((await placement(dir())).mem_b).toEqual(['上线'])
  })

  it('补证、只挂关联时带 topic：照常写，这条也挪过去', async () => {
    const e = env()
    await seed(e)
    updated(await bare(e, 'mem_b', { change: 'corroborate', topic: '上线' }))
    expect((await placement(dir())).mem_b).toEqual(['上线'])
    const r = updated(await bare(e, 'mem_d', { related: ['mem_a'], topic: '回复语言' }))
    expect(r.record.related).toEqual(['mem_a'])
    expect(await membersOf(dir(), '回复语言')).toEqual(['mem_d'])
  })

  it('整条更新给的主题不能用：内容照改，留在原来那页，结果里说明', async () => {
    const e = env()
    await seed(e)
    const r = updated(await e.save({ action: 'update', id: 'mem_b', change: 'refine', name: '回复用中文', summary: '摘要', content: '回复一律用中文。', topic: '# 坏名字' }))
    expect(r.record.content).toBe('回复一律用中文。')
    const text = warning(r, 'topic-invalid')
    expect(text).toContain(TOPIC_NAME_PROBLEM_TEXT.heading)
    expect(text).toContain(TOPIC_PLACE_KEPT)
    expect((await placement(dir())).mem_b).toEqual(['回复语言'])
  })

  it('只传 topic：不用填 change，不写记忆文件；挪到该主题最前，留一条整理索引的回执，能撤销回原来那页', async () => {
    const e = env()
    await seed(e)
    const found = (await e.table.locate('mem_b', at()))!
    const fileBefore = await readFile(found.filePath, 'utf8')
    const r = updated(await bare(e, 'mem_b', { topic: '发版' }))
    expect(r.record.id).toBe('mem_b')
    expect(await membersOf(dir(), '上线')).toEqual(['mem_b', 'mem_a'])
    expect(await readFile(found.filePath, 'utf8')).toBe(fileBefore)
    const entries = (await e.decisions.listSettled()).filter(d => d.kind === 'index-organize')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.indexRun!.receipts).toHaveLength(1)
    expect(entries[0]!.indexRun!.receipts[0]!.isConfirmed).toBe(true)
    expect(e.journal.hasPending()).toBe(false)
    expect((await e.undo(entries[0]!.id)).kind).toBe('undone')
    expect((await placement(dir())).mem_b).toEqual(['回复语言'])
  })

  it('只传 topic、主题还没有：建出来，结果里说建了', async () => {
    const e = env()
    await seed(e)
    const r = updated(await bare(e, 'mem_d', { topic: '存储', topicAbout: '存储相关。' }))
    expect(await membersOf(dir(), '存储')).toEqual(['mem_d'])
    expect((await entryOf(dir())).at(-1)).toEqual({ name: '存储', about: '存储相关。' })
    expect(warning(r, 'topic-created')).toContain(`${TOPIC_CREATED_LEAD}「存储」`)
  })

  it('只传 topic、已经在那一页（按曾用名也算）：什么都不写、不多留回执', async () => {
    const e = env()
    await seed(e)
    const moved = updated(await bare(e, 'mem_b', { topic: '上线' }))
    expect(await membersOf(dir(), '上线')).toEqual(['mem_b', 'mem_a'])
    expect(topicCodes(moved.warnings)).toEqual([])
    const receipts = (await e.decisions.listSettled()).filter(d => d.kind === 'index-organize')
    expect(receipts).toHaveLength(1)
    const before = await indexTree(dir())
    const r = updated(await bare(e, 'mem_a', { topic: '发版' }))
    expect(r.record.id).toBe('mem_a')
    expect(await indexTree(dir())).toEqual(before)
    expect(topicCodes(r.warnings)).toEqual([])
    expect((await e.decisions.listSettled()).filter(d => d.kind === 'index-organize')).toEqual(receipts)
  })

  it('只传 topic、名字不能用或到上限：不挪，结果里说明并列出最相近的主题', async () => {
    const e = env({ maxTopics: 2 })
    await seed(e)
    const bad = updated(await bare(e, 'mem_d', { topic: '' }))
    expect(warning(bad, 'topic-invalid')).toContain(TOPIC_NAME_PROBLEM_TEXT.empty)
    expect(warning(bad, 'topic-invalid')).toContain(TOPIC_PLACE_KEPT)
    const full = updated(await bare(e, 'mem_d', { topic: '写锁' }))
    expect(warning(full, 'topic-full')).toContain(nearestPart(['上线', '回复语言']))
    expect((await placement(dir())).mem_d).toEqual([UNSORTED_TITLE])
    expect((await e.decisions.listSettled()).filter(d => d.kind === 'index-organize')).toEqual([])
  })

  it('只传 topic 带了 scope、confidence、change：没有生效，结果里列出来，照常挪', async () => {
    const e = env()
    await seed(e)
    const r = updated(await bare(e, 'mem_d', { topic: '上线', scope: 'global', confidence: 0.3, change: 'refine' }))
    const text = warning(r, 'topic-only-params-ignored')
    expect(text.startsWith(TOPIC_ONLY_IGNORED_LEAD)).toBe(true)
    for (const name of ['scope', 'confidence', 'change']) expect(text).toContain(name)
    expect(await membersOf(dir(), '上线')).toEqual(['mem_d', 'mem_a'])
    expect((await e.store.get('mem_d', at()))!.scope).toBe('workspace')
  })

  it('只传 topic、这条还不在索引里：什么都不动，结果里说明', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_x' }))
    expect(await e.store.get('mem_x', at())).toBeDefined()
    const r = updated(await bare(e, 'mem_x', { topic: '上线' }))
    expect(warning(r, 'topic-not-indexed')).toBe(TOPIC_NOT_INDEXED_TEXT)
    expect(await indexTree(dir())).toBeUndefined()
  })

  it('只传 topic、索引读不出：什么都不动，结果里说明', async () => {
    const e = env()
    await seed(e)
    const entryPath = join(dir(), INDEX_DIR, INDEX_ENTRY_FILE)
    await rm(entryPath)
    await mkdir(entryPath)
    const r = updated(await bare(e, 'mem_b', { topic: '上线' }))
    expect(warning(r, 'topic-unreadable')).toBe(TOPIC_UNREADABLE_TEXT)
    expect(e.journal.hasPending()).toBe(false)
  })

  it('只传 topic 的子 agent：不挪，结果里说接受后再归', async () => {
    const e = env()
    await seed(e)
    const own = saved(await e.save({ type: 'knowledge', name: '子任务观察', content: '观察到的事实', summary: '观察', sourceMode: 'environment-observed', force: undefined },
      { session: 'sub-1', delegation: SUBAGENT }))
    const r = updated(await bare(e, own.record.id, { sourceMode: 'environment-observed', topic: '上线' }, { session: 'sub-1', delegation: SUBAGENT }))
    expect(warning(r, 'topic-deferred-subagent')).toBe(TOPIC_DEFERRED_SUBAGENT_TEXT)
    expect(await membersOf(dir(), '上线')).toEqual(['mem_a'])
  })

  it('撤销一次建了主题的改动：记忆回到改前，新建的主题留下', async () => {
    const e = env()
    await seed(e)
    updated(await e.save({ action: 'update', id: 'mem_d', change: 'correct', name: '写锁设计', summary: '摘要', content: '写锁用 SQLite 事务', topic: '存储' }))
    expect(await membersOf(dir(), '存储')).toEqual(['mem_d'])
    const entry = (await e.decisions.listSettled()).find(d => d.memoryIds.includes('mem_d') && d.kind !== 'index-organize')!
    expect((await e.undo(entry.id)).kind).toBe('undone')
    expect((await e.store.get('mem_d', at()))!.content).toBe('写锁用 SQLite')
    expect((await entryOf(dir())).map(t => t.name)).toContain('存储')
  })
})

describe('补充的组合', () => {
  it('主题名里带换行：不折成一行去用，按名字不能用处理，进「未整理」', async () => {
    const e = env()
    await seed(e)
    const r = saved(await e.save({ topic: '发版\n上线' }))
    expect(await membersOf(dir(), UNSORTED_TITLE)).toEqual([r.record.id, 'mem_d'])
    expect(warning(r, 'topic-invalid')).toContain(TOPIC_NAME_PROBLEM_TEXT['bad-char'])
    expect((await entryOf(dir())).map(t => t.name)).not.toContain('发版 上线')
  })

  it('提交前算好要新建主题，落盘时主题页写不进去：只说之后补做，不说建好了', async () => {
    const e = env()
    await seed(e)
    const topics = join(dir(), INDEX_DIR, INDEX_TOPICS_DIR)
    await chmod(topics, 0o555)
    let r: PipelineResult
    try {
      r = await e.save({ topic: '新主题', topicAbout: '说明。' })
    } finally {
      await chmod(topics, 0o755)
    }
    const s = saved(r)
    expect(warning(s, 'topic-pending')).toBe(TOPIC_PENDING_TEXT)
    expect(topicCodes(s.warnings)).toEqual(['topic-pending'])
  })

  it('没有操作日志时索引读不出：照常保存，结果里一样说之后补做', async () => {
    const e = env({ isJournaled: false })
    await seed(e)
    await breakEntry()
    const r = saved(await e.save({ topic: '上线' }))
    expect(await e.store.get(r.record.id, at())).toBeDefined()
    expect(warning(r, 'topic-pending')).toBe(TOPIC_PENDING_TEXT)
  })

  it('补证带新主题和说明：照常补证，建出主题、说明写进入口；说明去掉空白后为空就当没给', async () => {
    const e = env()
    await seed(e)
    updated(await bare(e, 'mem_d', { change: 'corroborate', topic: '存储', topicAbout: '存储相关。' }))
    expect(await membersOf(dir(), '存储')).toEqual(['mem_d'])
    expect((await entryOf(dir())).at(-1)).toEqual({ name: '存储', about: '存储相关。' })
    const r = saved(await e.save({ topicAbout: '   ' }))
    expect(await membersOf(dir(), UNSORTED_TITLE)).toEqual([r.record.id])
    expect(topicCodes(r.warnings)).toEqual([])
  })

  it('精确修改带 topic：改在正文上，这条也挪过去', async () => {
    const e = env()
    await seed(e)
    const r = updated(await bare(e, 'mem_d', { change: 'refine', edits: [{ oldString: '写锁用 SQLite', newString: '写锁用 SQLite 事务' }], topic: '上线' }))
    expect(r.record.content).toBe('写锁用 SQLite 事务')
    expect(await membersOf(dir(), '上线')).toEqual(['mem_d', 'mem_a'])
  })

  it('新建时取代旧记忆又带 topic：新的进该主题，旧的当场去行、不跟着进去', async () => {
    const e = env()
    await seed(e)
    const r = saved(await e.save({ name: '发版步骤（新）', supersedes: ['mem_a'], topic: '回复语言' }))
    expect(await membersOf(dir(), '回复语言')).toEqual([r.record.id, 'mem_b'])
    expect((await placement(dir())).mem_a).toBeUndefined()
  })

  it('只挂关联、关联全都已经挂着、又带了 topic：不写记忆文件，挪到该主题，留整理索引的回执；只出一条参数没生效的说明', async () => {
    const e = env()
    await seed(e)
    updated(await bare(e, 'mem_d', { related: ['mem_a'] }))
    const found = (await e.table.locate('mem_d', at()))!
    const fileBefore = await readFile(found.filePath, 'utf8')
    const r = updated(await bare(e, 'mem_d', { related: ['mem_a'], topic: '上线', scope: 'global' }))
    expect(await membersOf(dir(), '上线')).toEqual(['mem_d', 'mem_a'])
    expect(await readFile(found.filePath, 'utf8')).toBe(fileBefore)
    expect((await e.decisions.listSettled()).filter(d => d.kind === 'index-organize')).toHaveLength(1)
    expect((r.warnings ?? []).map(w => w.code).filter(code => code.endsWith('params-ignored'))).toEqual(['topic-only-params-ignored'])
  })

  it('关联给的是空列表、带了 topic：不回「没有要挂的」，照样挪', async () => {
    const e = env()
    await seed(e)
    const r = updated(await bare(e, 'mem_d', { related: [], topic: '上线' }))
    expect(await membersOf(dir(), '上线')).toEqual(['mem_d', 'mem_a'])
    expect((r.warnings ?? []).map(w => w.code)).not.toContain('links-empty')
  })

  it('子 agent 只挂关联又带了 topic：关联照挂，topic 不生效，结果里说接受后再归', async () => {
    const e = env()
    await seed(e)
    const own = saved(await e.save({ type: 'knowledge', name: '子任务观察', content: '观察到的事实', summary: '观察', sourceMode: 'environment-observed', force: undefined },
      { session: 'sub-1', delegation: SUBAGENT }))
    const r = updated(await bare(e, own.record.id, { sourceMode: 'environment-observed', related: ['mem_a'], topic: '上线' }, { session: 'sub-1', delegation: SUBAGENT }))
    expect(r.record.related).toEqual(['mem_a'])
    expect(warning(r, 'topic-deferred-subagent')).toBe(TOPIC_DEFERRED_SUBAGENT_TEXT)
    expect(await membersOf(dir(), '上线')).toEqual(['mem_a'])
  })

  it('只传 topic 指向现有主题又带了 topicAbout：说明不改，结果里说明没生效（已在那一页时也说）', async () => {
    const e = env()
    await seed(e)
    const before = (await entryOf(dir())).find(t => t.name === '上线')
    const moved = updated(await bare(e, 'mem_b', { topic: '上线', topicAbout: '想改说明。' }))
    expect(await membersOf(dir(), '上线')).toEqual(['mem_b', 'mem_a'])
    expect(warning(moved, 'topic-about-ignored')).toBe(TOPIC_ABOUT_IGNORED_TEXT)
    const stay = updated(await bare(e, 'mem_a', { topic: '上线', topicAbout: '想改说明。' }))
    expect(warning(stay, 'topic-about-ignored')).toBe(TOPIC_ABOUT_IGNORED_TEXT)
    expect((await entryOf(dir())).find(t => t.name === '上线')).toEqual(before)
  })

  it('只传 topic、目标页这时放不进去（标题下面是没闭合的代码围栏）：什么都不动，不留回执，结果里说明', async () => {
    const e = env()
    await seed(e)
    const moved = updated(await bare(e, 'mem_d', { topic: '上线' }))
    expect(await membersOf(dir(), '上线')).toEqual(['mem_d', 'mem_a'])
    const receipts = (await e.decisions.listSettled()).filter(d => d.kind === 'index-organize')
    expect(receipts).toHaveLength(1)
    const files = (await e.store.readIndex(at()))!
    const page = readIndex(files).topics.find(t => t.name === '回复语言')!.fileName
    await writeFile(join(dir(), INDEX_DIR, INDEX_TOPICS_DIR, page), '# 回复语言\n\n```\n')
    const r = updated(await bare(e, 'mem_d', { topic: '回复语言' }))
    expect(warning(r, 'topic-skipped')).toBe(TOPIC_SKIPPED_TEXT)
    expect((await placement(dir())).mem_d).toEqual(['上线'])
    expect((await e.decisions.listSettled()).filter(d => d.kind === 'index-organize')).toEqual(receipts)
    expect(topicCodes(moved.warnings)).toEqual([])
  })
})

describe('新建闸：同主题成员的判重和口径', () => {
  // 两段长度一样、只差最后一个字：字符相似度过了判重线
  const LONG = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'
  const NEAR = `${LONG.slice(0, -1)}X`

  it('不带 force：和同主题里某条几乎一样，检索窗口里排不上它也拦下来说疑似重复', async () => {
    const e = env()
    // 十条整词命中、但长得不像的记忆占满检索窗口
    for (let i = 0; i < GATE_CANDIDATE_WINDOW; i++) {
      await e.store.create(ws({ id: `mem_fill${i}`, name: `f${i}`, summary: `s${i}`, content: `${LONG} 另外一大段完全不同的说明文字第 ${i} 条，长度远超原文` }))
    }
    await e.store.create(ws({ id: 'mem_near', name: 'mm', summary: 'bb', content: NEAR }))
    await e.table.maintain([dir()])
    await applied(e.table, dir(), { kind: 'assign', memoryIds: ['mem_near'], from: UNSORTED_TITLE, to: '字母' })
    const r = await e.save({ name: 'n', summary: 'aa', content: LONG, topic: '字母', force: undefined })
    expect(r.kind, JSON.stringify(r)).toBe('duplicate-suspected')
    expect((r as Extract<PipelineResult, { kind: 'duplicate-suspected' }>).existing.id).toBe('mem_near')
  })

  it('同主题里已过期的、子 agent 还没接受的那条不算：不拦，也不进相近列表；没过期的照常进', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_old', name: 'mm', summary: 'bb', content: NEAR, validTo: T0 - MINUTE }))
    await e.store.create(ws({ id: 'mem_live', name: 'll', summary: 'cc', content: 'zzzz' }))
    await e.table.maintain([dir()])
    await applied(e.table, dir(), { kind: 'assign', memoryIds: ['mem_old', 'mem_live'], from: UNSORTED_TITLE, to: '字母' })
    // 子 agent 存下、还没接受的记录本来不进索引：手改把它的行写进这一页
    const own = saved(await e.save({ type: 'knowledge', name: 'yy', content: 'yyyy', summary: 'dd', sourceMode: 'environment-observed', force: undefined },
      { session: 'sub-1', delegation: SUBAGENT }))
    const files = (await e.store.readIndex(at()))!
    const page = Object.keys(files.pages).find(name => /^# 字母$/m.test(files.pages[name]!))!
    const fileName = basename((await e.table.locate(own.record.id, at()))!.filePath)
    const pagePath = join(dir(), INDEX_DIR, INDEX_TOPICS_DIR, page)
    await writeFile(pagePath, files.pages[page]!.replace('# 字母\n', `# 字母\n\n${memberLine({ id: own.record.id, name: 'yy', summary: 'dd', fileName })}\n`))
    expect(await membersOf(dir(), '字母')).toContain(own.record.id)
    const r = saved(await e.save({ name: 'n', summary: 'aa', content: LONG, topic: '字母', force: undefined }))
    expect((r.similar ?? []).map(s => s.id)).toEqual(['mem_live'])
  })
})

describe('按名字认主题：保存和检索一致', () => {
  it('一个主题的曾用名等于另一个主题的名字：保存归进名字那个，按主题检索也只列它', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_a', name: '发版步骤', content: '先跑测试再打 tag' }))
    await e.store.create(ws({ id: 'mem_b', name: '回复用中文', content: '回复一律用中文' }))
    await e.store.create(ws({ id: 'mem_d', name: '写锁设计', content: '写锁用 SQLite' }))
    // 入口里曾用名是「发布」的「部署」排在前面，后面另有一个主题就叫「发布」
    await writeTopicIndex(dir(), [{ name: '部署', aliases: ['发布'], members: ['mem_a'] }, { name: '发布', members: ['mem_b'] }], ['mem_d'])
    expect((await placement(dir())).mem_b).toEqual(['发布'])
    const r = saved(await e.save({ topic: '发布' }))
    expect(await membersOf(dir(), '发布')).toEqual([r.record.id, 'mem_b'])
    expect(await membersOf(dir(), '部署')).toEqual(['mem_a'])
    const deps: SearchToolDeps = {
      store: e.store, registry, now: () => e.clock.now,
      host: { contextOf: async () => ({ workspacePath: WS, session: { id: 'sess-1', lastSeq: 1 } }) },
    }
    const found = await executeSearch({ topic: ' 发布 ' }, fakeExec(), deps)
    expect(found.browse?.sections.map(s => [s.topic.scope, s.topic.name])).toEqual([['workspace', '发布']])
    expect(found.browse?.sections.flatMap(s => s.rows.map(row => row.id))).toEqual([r.record.id, 'mem_b'])
  })
})

describe('工具层', () => {
  function toolDeps(e: Env, maxTopics?: number): SaveToolDeps {
    return {
      store: e.store, registry, snapshots: e.snapshots, decisions: e.decisions,
      host: { saveContextOf: async () => ({ workspacePath: WS, session: { id: 'sess-1', lastSeq: 9 } }), readSessionLog: userTurnLog },
      ...(maxTopics !== undefined ? { maxTopics: () => maxTopics } : {}),
    }
  }

  it('参数表：topic、topicAbout 是可选字符串，说明取自常量', () => {
    const tool = createSaveTool(toolDeps(env()))
    const schema = tool.parameters as unknown as { required?: string[]; properties: Record<string, { type?: string; description?: string }> }
    expect(schema.properties.topic).toEqual({ type: 'string', description: SAVE_TOPIC_DESCRIPTION })
    expect(schema.properties.topicAbout).toEqual({ type: 'string', description: SAVE_TOPIC_ABOUT_DESCRIPTION })
    expect(schema.required ?? []).not.toContain('topic')
    expect(schema.required ?? []).not.toContain('topicAbout')
    // 各条说明的固定文字互不相同、都不是空的
    const texts = [
      SAVE_TOPIC_DESCRIPTION, SAVE_TOPIC_ABOUT_DESCRIPTION, TOPIC_CREATED_LEAD, TOPIC_FULL_LEAD, TOPIC_INVALID_LEAD, NEAREST_TOPICS_LEAD, NEAREST_TOPICS_HINT,
      TOPIC_PLACED_UNSORTED, TOPIC_PLACE_KEPT, ...Object.values(TOPIC_NAME_PROBLEM_TEXT), TOPIC_ABOUT_IGNORED_TEXT, TOPIC_ABOUT_ALONE_TEXT,
      TOPIC_DEFERRED_SUBAGENT_TEXT, TOPIC_PENDING_TEXT, TOPIC_UNREADABLE_TEXT, TOPIC_NOT_INDEXED_TEXT, TOPIC_ONLY_IGNORED_LEAD, TOPIC_SKIPPED_TEXT,
    ]
    expect(texts.every(text => text.trim() !== '')).toBe(true)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('executeSave 把 topic、topicAbout 和配置里的主题数上限交给管线；结果文字里带主题说明', async () => {
    const e = env()
    await seed(e)
    const full = await executeSave({ action: 'create', type: 'preference', scope: 'workspace', name: '称呼', summary: '称呼', content: '回复时称呼对方为你', sourceMode: 'user-explicit', force: true, topic: '称呼', topicAbout: '说明。' }, fakeExec(), toolDeps(e, 2))
    expect(warning(saved(full), 'topic-full')).toContain(`${TOPIC_FULL_LEAD}「称呼」`)
    expect(renderSaveResult(full)).toContain(TOPIC_FULL_LEAD)
    const placed = await executeSave({ action: 'create', type: 'preference', scope: 'workspace', name: '语气', summary: '语气', content: '回复时语气平和', sourceMode: 'user-explicit', force: true, topic: '回复语言' }, fakeExec(), toolDeps(e))
    expect((await membersOf(dir(), '回复语言'))![0]).toBe(saved(placed).record.id)
  })
})
