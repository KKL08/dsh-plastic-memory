import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { STATE_CHANGE_VERSION, VERSION_ID_PATTERN, layerOf } from '../src/storage/history.ts'
import { GLOBAL_DIR, HISTORY_DIR } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { commitChange } from '../src/commit-change.ts'
import { executeSearch, renderSearchResult, versionCountNote, type SearchArgs, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import { createSearchTool } from '../src/tools/search-tool.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import { scopeAt, type Scope } from '../src/scope.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { FAKE_SECRET, generatePrivateKeyPem } from './helpers/secrets.ts'

// memory_search 的历史模式：按 id 列历史版本、按版本标识读一版，参数组合的合法表，以及普通检索结果标历史版本数。
// 走工具执行器 executeSearch 和渲染 renderSearchResult；真实临时目录上的文件表和侧表。

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const WS = '/tmp/pm-search-history'
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const session = { id: 's1', lastSeq: 1 }
const GLOBAL = { kind: 'global' } as const
const VERSION_ID_RE = new RegExp(`^${VERSION_ID_PATTERN}$`)

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-search-history-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function env(context: SearchContext = { workspacePath: WS, session }) {
  const clock = { now: T0 }
  const now = () => clock.now
  const sidecar = new SidecarStore({ root, log: quiet, now, schemas: sidecarSchemas })
  const table = new FileTable({ root, stats: sidecar.recallStats, log: quiet, now })
  const store = new MemoryStore(table, quiet, sidecar.recallStats)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const deps: SearchToolDeps = { store, registry, host: { contextOf: async () => context }, now }
  return { clock, now, store, snapshots, sidecar, deps }
}
type Env = ReturnType<typeof env>

const globalDir = () => join(root, GLOBAL_DIR)
const historyDir = (dir: string, id: string) => join(dir, HISTORY_DIR, encodeURIComponent(id))
const search = (e: Env, args: SearchArgs) => executeSearch(args, fakeExec(), e.deps)

/** 建一条记忆（不经保存管线，正文可以带密钥）。 */
async function made(e: Env, partial: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  const r = record({ name: '部署方式', summary: '部署方式', content: '第一版', createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial })
  await e.store.create(r)
  return r
}

/** 过一分钟做一次状态变化。不带会话：每次都另留一版。 */
async function changeState(e: Env, m: Pick<MemoryRecord, 'id' | 'workspacePath'>, content: string, reason: string, scope: Scope = scopeAt(m.workspacePath)): Promise<MemoryRecord> {
  e.clock.now += MINUTE
  const target = (await e.store.get(m.id, scope))!
  const r = await commitChange({ target, scope, kind: 'state-change', fields: { content }, by: 'main', reason, at: e.clock.now }, e)
  if (r.kind !== 'written') throw new Error(JSON.stringify(r))
  return r.record
}

/** 在历史目录里放一个名字合版本写法、内容解析不了的文件。 */
async function putGarbage(dir: string, id: string, versionId = '19990101T000000000Z') {
  await mkdir(historyDir(dir, id), { recursive: true })
  await writeFile(join(historyDir(dir, id), `${versionId}.md`), '这不是一个版本文件\n')
}

/** 让这条记忆的历史目录列不出：在它的位置放一个普通文件。 */
async function blockHistoryDir(dir: string, id: string) {
  await mkdir(join(dir, HISTORY_DIR), { recursive: true })
  await writeFile(historyDir(dir, id), '不是目录')
}

async function mergedAway(e: Env, from: MemoryRecord, into: MemoryRecord) {
  const mergedInto = { id: into.id, scopeKey: into.workspacePath ?? 'global', as: 'merge' as const }
  expect(await e.store.softDeleteUnlessSecret(from, { at: scopeAt(from.workspacePath), now: e.now(), mergedInto })).toBe('deleted')
}

const linesOf = (text: string) => text.split('\n')

describe('按 id 列历史版本', () => {
  it('列出各版，新的在前，每版带版本标识、结束时间和变化原因；不计召回', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '换成乙')
    await changeState(e, m, '第三版', '换成丙')
    const statsBefore = await e.sidecar.recallStats.get(m.id)
    const r = await search(e, { id: m.id, history: true })
    expect(r.noteCode).toBeUndefined()
    expect(r.hits).toEqual([])
    expect(r.history).toMatchObject({ memoryId: m.id, total: 2, isComplete: true })
    expect(r.history!.versions.map(v => [v.endedAt, v.reason])).toEqual([
      [new Date(T0 + 2 * MINUTE).toISOString(), '换成丙'],
      [new Date(T0 + MINUTE).toISOString(), '换成乙'],
    ])
    for (const v of r.history!.versions) expect(v.versionId).toMatch(VERSION_ID_RE)
    const text = renderSearchResult(r)
    for (const v of r.history!.versions) expect(linesOf(text).some(l => l.includes(v.versionId) && l.includes(v.reason))).toBe(true)
    // 列历史不计召回：查询前后召回统计不变（建记忆时就有一行零次的统计）
    expect(await e.sidecar.recallStats.get(m.id)).toEqual(statsBefore)
  })

  it('limit 只截版本列表：留新的几版，并说明一共有几版', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '一')
    await changeState(e, m, '第三版', '二')
    await changeState(e, m, '第四版', '三')
    const r = await search(e, { id: m.id, history: true, limit: 2 })
    expect(r.history!.versions.map(v => v.reason)).toEqual(['三', '二'])
    expect(r.history!.total).toBe(3)
    expect(r.moreNote).toBeDefined()
  })

  it('读全了一版都没有：说没有历史版本，不说读不全', async () => {
    const e = env()
    const m = await made(e)
    const r = await search(e, { id: m.id, history: true })
    expect(r.noteCode).toBe('no-history')
    expect(r.history).toMatchObject({ versions: [], total: 0, isComplete: true })
  })

  it('历史里有读不出的版本文件：给出读到的几版并说读不全，不说没有', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '换成乙')
    await putGarbage(globalDir(), m.id)
    const r = await search(e, { id: m.id, history: true })
    expect(r.noteCode).toBe('history-incomplete')
    expect(r.history!.isComplete).toBe(false)
    expect(r.history!.versions.map(v => v.reason)).toEqual(['换成乙'])
  })

  it('历史目录本身列不出：说读不全，不说没有历史版本', async () => {
    const e = env()
    const m = await made(e)
    await blockHistoryDir(globalDir(), m.id)
    const r = await search(e, { id: m.id, history: true })
    expect(r.noteCode).toBe('history-incomplete')
    expect(r.history).toMatchObject({ versions: [], isComplete: false })
  })

  it('被取代的记忆照样能列历史', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '换成乙')
    await e.store.update(m, cur => ({ ...cur, status: 'superseded' }), GLOBAL)
    const r = await search(e, { id: m.id, history: true })
    expect(r.history!.versions.map(v => v.reason)).toEqual(['换成乙'])
  })

  it('软删期间读不到它的历史：说找不到这条记忆', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '换成乙')
    expect(await e.store.softDelete(m, { at: GLOBAL, now: e.now() })).toBe(true)
    const r = await search(e, { id: m.id, history: true })
    expect(r.noteCode).toBe('memory-not-found')
    expect(r.history).toBeUndefined()
  })

  it('范围里没有这个 id：说找不到这条记忆', async () => {
    const e = env()
    const m = await made(e, { scope: 'workspace', workspacePath: WS })
    expect((await search(e, { id: 'mem_nowhere', history: true })).noteCode).toBe('memory-not-found')
    expect((await search(e, { id: m.id, history: true, scope: 'global' })).noteCode).toBe('memory-not-found')
  })

  it('同 id 在全局和本项目各有一份：缺省按会话视角只列本项目那份的历史，scope 为 global 时只列全局那份', async () => {
    const e = env()
    const g = await made(e, { id: 'mem_dup', content: '全局一' })
    const w = await made(e, { id: 'mem_dup', content: '项目一', scope: 'workspace', workspacePath: WS })
    await changeState(e, g, '全局二', '全局换了', GLOBAL)
    await changeState(e, w, '项目二', '项目换了', scopeAt(WS))
    expect((await search(e, { id: 'mem_dup', history: true })).history!.versions.map(v => v.reason)).toEqual(['项目换了'])
    expect((await search(e, { id: 'mem_dup', history: true, scope: 'global' })).history!.versions.map(v => v.reason)).toEqual(['全局换了'])
  })

  it('scope 为 workspace 而会话没有工作目录：照普通检索说明限定不了项目范围', async () => {
    const e = env({ workspacePath: undefined, session })
    const m = await made(e)
    expect((await search(e, { id: m.id, history: true, scope: 'workspace' })).noteCode).toBe('no-workspace')
  })

  it('合并过别的记忆：被合并方软删期间和物理删除之后列出的版本一样，并进来的标出原记忆 id', async () => {
    const e = env()
    const keeper = await made(e, { name: '留下的', content: '甲一' })
    await changeState(e, keeper, '甲二', '甲换了')
    const gone = await made(e, { name: '并进去的', content: '乙一', scope: 'workspace', workspacePath: WS })
    await changeState(e, gone, '乙二', '乙换了')
    await mergedAway(e, gone, keeper)
    const shape = async () => (await search(e, { id: keeper.id, history: true })).history!.versions.map(v => [v.versionId, v.endedAt, v.reason, v.mergedFrom ?? null])
    const during = await shape()
    expect(during.map(([, , reason, from]) => [reason, from])).toEqual([['乙换了', gone.id], ['甲换了', null]])
    expect(renderSearchResult(await search(e, { id: keeper.id, history: true }))).toContain(gone.id)
    e.clock.now += RETENTION_MS + MINUTE
    await e.store.maintain(scopeAt(WS))
    expect(await e.store.get(gone.id, scopeAt(WS))).toBeUndefined()
    expect(await shape()).toEqual(during)
  })

  it('变化原因带换行、标题行和代码围栏：每版仍是一行，不改变外层结构', async () => {
    const e = env()
    const m = await made(e)
    const located = (await e.store.locate(m.id, GLOBAL))!
    const reason = '第一行\n# 标题行\n```\n代码\n```'
    await e.store.history.write(layerOf(located), {
      versionId: '20231114T221400000Z', record: { ...m, content: '旧' }, extras: {}, startedAt: T0, endedAt: T0 + MINUTE,
      kind: STATE_CHANGE_VERSION, writes: [{ op: 'op-hand', at: T0 + MINUTE, reason }],
    })
    const r = await search(e, { id: m.id, history: true })
    const [entry] = r.history!.versions
    expect(entry!.reason).not.toMatch(/[\r\n]/)
    expect(entry!.reason).toContain('第一行')
    expect(entry!.reason).toContain('代码')
    const text = renderSearchResult(r)
    expect(linesOf(text).filter(l => l.startsWith('#') || l.startsWith('```'))).toEqual([])
  })

  it('变化原因里的密钥先遮盖再折成一行：跨行的私钥也认得出', async () => {
    const e = env()
    const m = await made(e)
    const located = (await e.store.locate(m.id, GLOBAL))!
    const { pem, bodyLines } = generatePrivateKeyPem()
    await e.store.history.write(layerOf(located), {
      versionId: '20231114T221400000Z', record: { ...m, content: '旧' }, extras: {}, startedAt: T0, endedAt: T0 + MINUTE,
      kind: STATE_CHANGE_VERSION, writes: [{ op: 'op-hand', at: T0 + MINUTE, reason: `换 key ${FAKE_SECRET.sk}\n${pem}` }],
    })
    const r = await search(e, { id: m.id, history: true })
    const text = renderSearchResult(r)
    for (const leaked of [FAKE_SECRET.sk, ...bodyLines]) {
      expect(r.history!.versions[0]!.reason).not.toContain(leaked)
      expect(text).not.toContain(leaked)
    }
  })

  it('子 agent 会话也能列历史，可见范围和它用普通检索时一样', async () => {
    const e = env({ workspacePath: WS, session, delegation: { depth: 1 } })
    const m = await made(e, { scope: 'workspace', workspacePath: WS })
    await changeState(e, m, '第二版', '换成乙')
    expect((await search(e, { id: m.id, history: true })).history!.versions.map(v => v.reason)).toEqual(['换成乙'])
  })
})

describe('按版本标识读一版', () => {
  it('读出那一版的整条记录，正文全文，密钥先遮盖', async () => {
    const e = env()
    const m = await made(e, { name: '网关', summary: `网关 key ${FAKE_SECRET.sk}`, content: `部署用 ${FAKE_SECRET.github}` })
    await changeState(e, m, '换了新的部署方式', '换网关')
    const [listed] = (await search(e, { id: m.id, history: true })).history!.versions
    const r = await search(e, { id: m.id, version: listed!.versionId })
    expect(r.noteCode).toBeUndefined()
    expect(r.version).toMatchObject({ memoryId: m.id, versionId: listed!.versionId, endedAt: listed!.endedAt, reason: '换网关' })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]).toMatchObject({ id: m.id, content: `部署用 ${SECRET_MASK}`, summary: `网关 key ${SECRET_MASK}` })
    expect(r.hits[0]!.isExcerpt).toBeUndefined()
    const text = renderSearchResult(r)
    expect(text).toContain(listed!.versionId)
    expect(text).not.toContain(FAKE_SECRET.sk)
    expect(text).not.toContain(FAKE_SECRET.github)
  })

  it('读一版不按节选截断：长正文给全文', async () => {
    const e = env()
    const long = '很长的旧正文。'.repeat(600)
    const m = await made(e, { content: long })
    await changeState(e, m, '短的新正文', '缩短')
    const [listed] = (await search(e, { id: m.id, history: true })).history!.versions
    expect((await search(e, { id: m.id, version: listed!.versionId })).hits[0]!.content).toBe(long)
  })

  it('这条记忆没有这一版：说找不到这一版', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '换成乙')
    const r = await search(e, { id: m.id, version: '20000101T000000000Z' })
    expect(r.noteCode).toBe('version-not-found')
    expect(r.hits).toEqual([])
  })

  it('这一版的文件在，但解析不了：说读不出', async () => {
    const e = env()
    const m = await made(e)
    await putGarbage(globalDir(), m.id, '20000101T000000000Z')
    const r = await search(e, { id: m.id, version: '20000101T000000000Z' })
    expect(r.noteCode).toBe('version-unreadable')
    expect(r.hits).toEqual([])
  })

  it('列出之后这一版被撤掉了：读时如实说已不在', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '换成乙')
    const [listed] = (await search(e, { id: m.id, history: true })).history!.versions
    const located = (await e.store.locate(m.id, GLOBAL))!
    await e.store.history.remove(layerOf(located), m.id, listed!.versionId)
    expect((await search(e, { id: m.id, version: listed!.versionId })).noteCode).toBe('version-not-found')
  })

  it('读并进来的那一版：被合并方软删期间和物理删除之后读到的一样', async () => {
    const e = env()
    const keeper = await made(e, { name: '留下的', content: '甲一' })
    await changeState(e, keeper, '甲二', '甲换了')
    const gone = await made(e, { name: '并进去的', content: '乙一', scope: 'workspace', workspacePath: WS })
    await changeState(e, gone, '乙二', '乙换了')
    await mergedAway(e, gone, keeper)
    const merged = (await search(e, { id: keeper.id, history: true })).history!.versions.find(v => v.mergedFrom === gone.id)!
    const read = async () => {
      const r = await search(e, { id: keeper.id, version: merged.versionId })
      return [r.hits.map(h => h.content), r.version?.mergedFrom]
    }
    const during = await read()
    expect(during).toEqual([['乙一'], gone.id])
    e.clock.now += RETENTION_MS + MINUTE
    await e.store.maintain(scopeAt(WS))
    expect(await read()).toEqual(during)
  })

  it('软删期间按版本也读不到：说找不到这条记忆', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '换成乙')
    const [listed] = (await search(e, { id: m.id, history: true })).history!.versions
    expect(await e.store.softDelete(m, { at: GLOBAL, now: e.now() })).toBe(true)
    expect((await search(e, { id: m.id, version: listed!.versionId })).noteCode).toBe('memory-not-found')
  })

  it.each(['../x', 'a/b', 'a.md', '', '版本一', '20231114T221400000Z.md'])('版本标识不合写法（%j）：参数错误，指出 version 不对', async version => {
    const e = env()
    const m = await made(e)
    const r = await search(e, { id: m.id, version })
    expect(r.noteCode).toBe('invalid-args')
    expect(r.note).toContain('version')
    expect(r.hits).toEqual([])
  })
})

describe('参数组合', () => {
  const invalid: Array<[string, SearchArgs, string[]]> = [
    ['一个都没给', {}, ['query', 'types', 'id']],
    ['只给空的 types', { types: [] }, ['query', 'types', 'id']],
    ['history 没带 id', { history: true }, ['history', 'id']],
    ['history 没带 id、带了 query', { query: '部署', history: true }, ['history', 'id']],
    ['version 没带 id', { version: '20231114T221400000Z' }, ['version', 'id']],
    ['history 和 version 同时给', { id: 'mem_x', history: true, version: '20231114T221400000Z' }, ['history', 'version']],
    ['id 和 query 同时给', { id: 'mem_x', history: true, query: '部署' }, ['id', 'query']],
    ['id 和空串 query 同时给', { id: 'mem_x', history: true, query: '' }, ['id', 'query']],
    ['id 和 types 同时给', { id: 'mem_x', history: true, types: ['knowledge'] }, ['id', 'types']],
    ['只给 id', { id: 'mem_x' }, ['history', 'version']],
    ['id 配 history: false', { id: 'mem_x', history: false }, ['history', 'version']],
    ['id 配了 match', { id: 'mem_x', history: true, match: 'all' }, ['id', 'match']],
    ['id 配了查原话的 source', { id: 'mem_x', history: true, source: 'dialogue' }, ['id', 'source']],
    ['id 配了两者都查的 source', { id: 'mem_x', history: true, source: 'both' }, ['id', 'source']],
    ['version 配了 limit', { id: 'mem_x', version: '20231114T221400000Z', limit: 3 }, ['version', 'limit']],
    ['id 是空串', { id: '', history: true }, ['id']],
  ]

  it.each(invalid)('%s：参数错误，说明里点出冲突的参数，不悄悄忽略', async (_name, args, names) => {
    const e = env()
    await made(e, { id: 'mem_x' })
    const r = await search(e, args)
    expect(r.noteCode).toBe('invalid-args')
    for (const name of names) expect(r.note).toContain(name)
    expect(r.hits).toEqual([])
    expect(r.history).toBeUndefined()
  })

  it('合法组合：id 配 history 可以带 scope、limit 和 source: memory', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '换成乙')
    const r = await search(e, { id: m.id, history: true, scope: 'all-visible', limit: 5, source: 'memory' })
    expect(r.noteCode).toBeUndefined()
    expect(r.history!.versions.map(v => v.reason)).toEqual(['换成乙'])
  })

  it('只给 types 不给 query：照旧列出这几类的记忆', async () => {
    const e = env()
    const m = await made(e, { type: 'knowledge' })
    const r = await search(e, { types: ['knowledge'] })
    expect(r.noteCode).toBeUndefined()
    expect(r.hits.map(h => h.id)).toEqual([m.id])
  })

  it('history: false 和不传一样：关键词检索照常', async () => {
    const e = env()
    const m = await made(e)
    const r = await search(e, { query: '部署方式', history: false })
    expect(r.noteCode).toBeUndefined()
    expect(r.hits.map(h => h.id)).toEqual([m.id])
  })

  it('工具参数：query 不再必填，新增 id、history、version', () => {
    const e = env()
    const tool = createSearchTool(e.deps)
    const parameters = tool.parameters as { properties: Record<string, { type?: string }>; required?: string[] }
    expect(parameters.properties.id).toMatchObject({ type: 'string' })
    expect(parameters.properties.history).toMatchObject({ type: 'boolean' })
    expect(parameters.properties.version).toMatchObject({ type: 'string' })
    expect(parameters.required ?? []).not.toContain('query')
    expect(parameters.required ?? []).not.toContain('id')
  })
})

describe('普通检索结果标历史版本数', () => {
  it('检索只返回当前版，历史版本不进结果；有历史版本的命中标出版本数，没有的不标，头行带上版本数', async () => {
    const e = env()
    const changed = await made(e, { name: '部署方式甲' })
    await changeState(e, changed, '部署方式第二版', '一')
    await changeState(e, changed, '部署方式第三版', '二')
    const plain = await made(e, { name: '部署方式乙', content: '部署方式没变过' })
    const r = await search(e, { query: '部署方式' })
    expect(r.hits.map(h => [h.id, h.content]).sort()).toEqual([[changed.id, '部署方式第三版'], [plain.id, '部署方式没变过']].sort())
    expect(r.hits.find(h => h.id === changed.id)!.versionCount).toBe(2)
    expect(r.hits.find(h => h.id === plain.id)!.versionCount).toBeUndefined()
    const text = renderSearchResult(r)
    const head = linesOf(text).find(l => l.startsWith(`[${changed.id}]`))!
    expect(head).toContain(versionCountNote(2))
  })

  it('只数文件名不解析：读不出的版本文件也算一版，写到一半的临时文件不算', async () => {
    const e = env()
    const m = await made(e, { content: '部署方式第一版' })
    await changeState(e, m, '部署方式第二版', '一')
    await putGarbage(globalDir(), m.id)
    await writeFile(join(historyDir(globalDir(), m.id), '20231114T221500000Z.md.tmp-1-abcdef'), '半截')
    expect((await search(e, { query: '部署方式' })).hits[0]!.versionCount).toBe(2)
  })

  it('历史目录列不出：这条不标版本数，不标成 0；别的命中照常标', async () => {
    const e = env()
    const blocked = await made(e, { name: '部署方式甲', content: '部署方式' })
    await blockHistoryDir(globalDir(), blocked.id)
    const other = await made(e, { name: '部署方式乙', content: '部署方式一' })
    await changeState(e, other, '部署方式二', '一')
    const r = await search(e, { query: '部署方式' })
    expect(r.hits.find(h => h.id === blocked.id)!.versionCount).toBeUndefined()
    expect(r.hits.find(h => h.id === other.id)!.versionCount).toBe(1)
  })

  it('按 id 直达的那条也标', async () => {
    const e = env()
    const m = await made(e)
    await changeState(e, m, '第二版', '一')
    expect((await search(e, { query: m.id })).hits[0]!.versionCount).toBe(1)
  })

  it('软删窗口里并进来、还没搬过来的版本不计：只数这条自己目录里的', async () => {
    const e = env()
    const keeper = await made(e, { name: '部署方式', content: '部署方式甲一' })
    await changeState(e, keeper, '部署方式甲二', '甲换了')
    const gone = await made(e, { name: '并进去的', content: '乙一', scope: 'workspace', workspacePath: WS })
    await changeState(e, gone, '乙二', '乙换了')
    await mergedAway(e, gone, keeper)
    expect((await search(e, { query: '部署方式' })).hits.find(h => h.id === keeper.id)!.versionCount).toBe(1)
    expect((await search(e, { id: keeper.id, history: true })).history!.total).toBe(2)
  })
})
