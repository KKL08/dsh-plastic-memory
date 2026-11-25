import { afterEach, beforeEach, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { layerOf, STATE_CHANGE_VERSION } from '../src/storage/history.ts'
import { HISTORY_DIR } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { historyWithMerged } from '../src/merged-history.ts'
import { executeSearch, renderSearchResult, type SearchArgs, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import { createSearchTool } from '../src/tools/search-tool.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { scopeAt } from '../src/scope.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'

const T0 = 1_700_000_000_000
const WS = '/tmp/history-project-a'
const OTHER = '/tmp/history-project-b'
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'history-review-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function env(workspacePath: string | undefined = WS) {
  const now = () => T0
  const sidecar = new SidecarStore({ root, log: quiet, now, schemas: sidecarSchemas })
  const table = new FileTable({ root, stats: sidecar.recallStats, log: quiet, now })
  const store = new MemoryStore(table, quiet, sidecar.recallStats)
  const context: SearchContext = { workspacePath, session: { id: 's1', lastSeq: 1 } }
  const deps: SearchToolDeps = { store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), host: { contextOf: async () => context }, now }
  return { store, deps, context }
}
type Env = ReturnType<typeof env>
const search = (e: Env, args: SearchArgs) => executeSearch(args, fakeExec(), e.deps)

async function made(e: Env, workspacePath?: string) {
  const m = record({ createdAt: T0, updatedAt: T0, ...(workspacePath === undefined ? {} : { scope: 'workspace', workspacePath }) })
  await e.store.create(m)
  return m
}

async function version(e: Env, m: MemoryRecord, versionId = 'v1') {
  const found = (await e.store.locate(m.id, scopeAt(m.workspacePath)))!
  await e.store.history.write(layerOf(found), { versionId, record: m, extras: {}, startedAt: T0, endedAt: T0 + 60_000, kind: STATE_CHANGE_VERSION, writes: [] })
  return join(found.dir, HISTORY_DIR, encodeURIComponent(m.id), `${versionId}.md`)
}

it('其他项目的记忆不能列历史或读一版，返回中不带版本信息', async () => {
  const e = env()
  const m = await made(e, OTHER)
  await version(e, m)
  for (const workspacePath of [WS, undefined]) {
    e.context.workspacePath = workspacePath
    const scopes: SearchArgs['scope'][] = workspacePath === undefined ? [undefined, 'all-visible', 'global'] : [undefined, 'all-visible', 'workspace', 'global']
    for (const scope of scopes) for (const mode of [{ history: true }, { version: 'v1' }]) {
      const r = await search(e, { id: m.id, scope, ...mode })
      expect(r.noteCode).toBe('memory-not-found')
      expect(r.hits).toEqual([])
      expect(r.history).toBeUndefined()
      expect(r.version).toBeUndefined()
      expect(renderSearchResult(r)).not.toContain('v1')
    }
  }
})

it('当前项目和全局记忆仍能列历史并读全文', async () => {
  const e = env()
  for (const workspacePath of [WS, undefined]) {
    const m = await made(e, workspacePath)
    await version(e, m)
    for (const scope of [undefined, 'all-visible', workspacePath === undefined ? 'global' : 'workspace'] as const) {
      expect((await search(e, { id: m.id, history: true, scope })).history?.total).toBe(1)
      expect((await search(e, { id: m.id, version: 'v1', scope })).hits[0]?.content).toBe(m.content)
    }
    if (workspacePath === undefined) {
      e.context.workspacePath = undefined
      expect((await search(e, { id: m.id, history: true })).history?.total).toBe(1)
      expect((await search(e, { id: m.id, version: 'v1' })).hits).toHaveLength(1)
    } else expect((await search(e, { id: m.id, history: true, scope: 'global' })).noteCode).toBe('memory-not-found')
  }
})

it.skipIf(process.getuid?.() === 0)('并入来源所在项目目录不可读时，历史读不全而不是没有历史', async () => {
  const e = env()
  const keeper = await made(e)
  const gone = await made(e, OTHER)
  await version(e, gone)
  const from = (await e.store.locate(gone.id, scopeAt(OTHER)))!
  expect(await e.store.softDeleteUnlessSecret(gone, { at: scopeAt(OTHER), now: T0, mergedInto: { id: keeper.id, scopeKey: 'global', as: 'merge' } })).toBe('deleted')
  const found = (await e.store.locate(keeper.id, scopeAt(undefined)))!
  expect((await historyWithMerged(e.store, found)).versions).toHaveLength(1)
  await chmod(from.dir, 0)
  try {
    expect((await historyWithMerged(e.store, found)).isComplete).toBe(false)
    expect((await search(e, { id: keeper.id, history: true })).noteCode).toBe('history-incomplete')
  } finally { await chmod(from.dir, 0o700) }
})

it.each(['versionEndedAt', 'versionStartedAt'])('%s 超出日期范围时跳过坏版，读这一版返回读不出', async field => {
  const e = env()
  const m = await made(e)
  const path = await version(e, m)
  await version(e, m, 'v2')
  await writeFile(path, (await readFile(path, 'utf8')).replace(new RegExp(`${field}:.*`), `${field}: 10000000000000000`))
  const r = await search(e, { id: m.id, history: true })
  expect(r.noteCode).toBe('history-incomplete')
  expect(r.history?.versions.map(v => v.versionId)).toEqual(['v2'])
  expect((await search(e, { id: m.id, version: 'v1' })).noteCode).toBe('version-unreadable')
})

it('空原因不渲染原因标签，截断说明区分默认条数和上限', async () => {
  const e = env()
  const m = await made(e)
  for (let i = 0; i < 52; i++) await version(e, m, `v${i}`)
  const normal = await search(e, { id: m.id, history: true })
  expect(normal.history?.total).toBe(52)
  expect(normal.history?.versions).toHaveLength(10)
  expect(normal.moreNote).toBe('只列出最新的 10 版，要看更早的版本可以调大 limit（最多 50 版）。')
  const max = await search(e, { id: m.id, history: true, limit: 50 })
  expect(max.history?.versions).toHaveLength(50)
  expect(max.moreNote).toBe('limit 已是上限 50，只列出最新的 50 版。')
  expect(renderSearchResult(normal)).not.toContain('原因：')
  expect(renderSearchResult(await search(e, { id: m.id, version: 'v0' }))).not.toContain('原因：')
})

it('历史读取各失败分支返回约定的说明原文', async () => {
  const e = env()
  const m = await made(e)
  expect((await search(e, { id: m.id, version: 'missing' })).note).toBe('找不到这一版（可能已被清理或撤销，也可能版本标识有误）。可以用 id 配 history: true 列出现有的版本。')
  const path = await version(e, m)
  await writeFile(path, '坏文件')
  expect((await search(e, { id: m.id, history: true })).note).toBe('这次没读出这条记忆的历史，不代表它没有历史版本。需要时可以请用户检查记忆目录；要读当前内容，把 id 填进 query。')
  expect((await search(e, { id: m.id, version: 'v1' })).note).toBe('这一版的文件读不出来。可以用 id 配 history: true 看其他版本，或把 id 填进 query 读当前内容。')
  expect((await search(e, { id: m.id, version: 'missing' })).note).toBe('这次没找到这一版，历史还有读不出的部分，所以不能确定它已经不在。可以用 id 配 history: true 看目前读得到的版本。')
  await version(e, m, 'v2')
  expect((await search(e, { id: m.id, history: true })).note).toBe('有部分历史版本没读出来，下面只列出读到的版本，其余版本可能还在。可以用其中的版本标识配 version 读一版；需要完整历史时，可以请用户检查记忆目录。')
})

it('参数错误和工具说明使用约定的原文', async () => {
  const e = env()
  const cases: Array<[SearchArgs, string]> = [
    [{ id: '', history: true }, '请在 id 中填写记忆 id。'],
    [{ id: 'mem_x', version: 'bad.md' }, 'version 请填写列历史（history: true）返回的版本标识，由 ASCII 字母、数字或连字符组成，不含 .md 后缀。'],
    [{ id: 'mem_x', history: true, source: 'dialogue' }, '按 id 查历史时，source 请设为 memory 或不传。'],
    [{}, '请填写 query、非空 types，或用 id 配 history: true 或 version 查历史。'],
  ]
  for (const [args, note] of cases) expect(await search(e, args)).toMatchObject({ noteCode: 'invalid-args', note })
  const tool = createSearchTool(e.deps)
  expect(tool.description).toContain('用 id 配 history: true 列出历史版本（新的在前，用 limit 控制条数）；用 id 配 version 读一版的全文，正文里的密钥已遮盖。要读当前内容，把 id 填进 query。')
  const parameters = tool.parameters as { properties: Record<string, { description?: string }> }
  expect(parameters.properties.id?.description).toBe('记忆 id。配 history: true 列历史版本，配 version 读一版；要读当前内容，把 id 填进 query')
  expect(parameters.properties.version?.description).toBe('配 id 读一版的全文，填列历史（history: true）返回的版本标识，不含 .md 后缀')
})
