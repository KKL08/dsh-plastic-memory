import { sidecarSchemas } from './helpers/sidecar-schemas.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { MemoryStore } from '../src/store.ts'
import { commitChange } from '../src/commit-change.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { finalizeSearch } from '../src/tools/search-budget.ts'
import { executeSearch, renderSearchResult, type SearchArgs, type SearchContext, type SearchToolDeps } from '../src/tools/search.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { scopeAt } from '../src/scope.ts'
import { layerOf, newVersionId, STATE_CHANGE_VERSION } from '../src/storage/history.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'

// 历史模式的输出按预算收尾：列表先省各行的原因（最旧的先），再从最旧往前省整行，最后一行只留版本标识；读一版是全文例外。

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const points = (text: string) => [...text].length

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-search-budget-history-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function env(threshold: number | 'none') {
  const clock = { now: T0 }
  const now = () => clock.now
  const sidecar = new SidecarStore({ root, log: quiet, now, schemas: sidecarSchemas })
  const table = new FileTable({ root, stats: sidecar.recallStats, log: quiet, now })
  const store = new MemoryStore(table, quiet, sidecar.recallStats)
  const context: SearchContext = { workspacePath: undefined, session: { id: 's1', lastSeq: 1 } }
  const host = { contextOf: async () => context, toolResultPrunerOf: () => threshold === 'none' ? undefined : { config: { thresholdChars: threshold } } }
  const deps: SearchToolDeps = { store, registry, host, now }
  const search = async (args: SearchArgs) => {
    const result = await executeSearch(args, fakeExec(), deps)
    return { result, text: renderSearchResult(result) }
  }
  const snapshots = new SnapshotStore(sidecar.snapshots)
  return { clock, store, snapshots, search }
}

/** 建一条记忆再做 n 次状态变化，每次的原因由 reasonOf 给。 */
async function withVersions(e: ReturnType<typeof env>, n: number, reasonOf: (i: number) => string, partial: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  const m = record({ name: '部署方式', summary: '部署方式', content: '第一版', createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...partial })
  await e.store.create(m)
  for (let i = 0; i < n; i++) {
    e.clock.now += MINUTE
    const scope = scopeAt(m.workspacePath)
    const target = (await e.store.get(m.id, scope))!
    const r = await commitChange({ target, scope, kind: 'state-change', fields: { content: `第 ${i + 2} 版 ${partial.content ?? ''}` }, by: 'main', reason: reasonOf(i), at: e.clock.now }, { store: e.store, snapshots: e.snapshots })
    if (r.kind !== 'written') throw new Error(JSON.stringify(r))
  }
  return m
}

/**
 * 直接把 n 个历史版本写进历史目录（第 i 个在 T0 + i + 1 分钟结束），不走 n 次保存，读的路径和保存留下的一样。
 * 版本标识可以带一段后缀（合法写法里更长的标识）。返回新的在前的版本标识。
 */
async function seedVersions(e: ReturnType<typeof env>, n: number, reasonOf: (i: number) => string, idSuffix = ''): Promise<{ id: string; newestFirst: string[] }> {
  const m = record({ name: '部署方式', summary: '部署方式', content: '当前版', createdAt: T0, updatedAt: T0, lastConfirmedAt: T0 })
  await e.store.create(m)
  const layer = layerOf((await e.store.locate(m.id, { workspacePath: undefined }))!)
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const endedAt = T0 + (i + 1) * MINUTE
    const versionId = `${newVersionId(endedAt, ids)}${idSuffix}`
    ids.push(versionId)
    await e.store.history.write(layer, { versionId, record: m, extras: {}, startedAt: endedAt - MINUTE, endedAt, kind: STATE_CHANGE_VERSION, writes: [{ op: 'update', at: endedAt, reason: reasonOf(i) }] })
  }
  return { id: m.id, newestFirst: [...ids].reverse() }
}

describe('历史列表按预算收尾', () => {
  it('真实读 51 版、limit 50、放得下：给出最新的 50 版，版本标识逐个对上', async () => {
    const e = env('none')
    const { id, newestFirst } = await seedVersions(e, 51, i => `原因${i}`)
    const { result, text } = await e.search({ id, history: true, limit: 50 })
    expect(result.history!.versions.map(v => v.versionId)).toEqual(newestFirst.slice(0, 50))
    expect(text.split('\n')[0]).toBe(`记忆 ${id} 的历史：共读到 51 版，给出 50 版。`)
    expect(result.moreNote).toBe('limit 已是上限 50，只列出最新的 50 版。')
    expect(result.budgetNote).toBeUndefined()
  })

  it('真实读 51 版、每版原因 500 字、预算 3000：标题、limit 说明和省略说明的版数互相对得上，不让调大 limit', async () => {
    const e = env(3000)
    const { id, newestFirst } = await seedVersions(e, 51, i => `原因${i}：${'因'.repeat(500)}`, `-${'v'.repeat(48)}`)
    const { result, text } = await e.search({ id, history: true, limit: 50 })
    expect(points(text)).toBeLessThanOrEqual(3000)
    const kept = result.history!.versions
    expect(kept.length).toBeLessThan(50)
    expect(kept.map(v => v.versionId)).toEqual(newestFirst.slice(0, kept.length))
    expect(text.split('\n')[0]).toBe(`记忆 ${id} 的历史：共读到 51 版，给出 ${kept.length} 版。`)
    expect(result.moreNote).toBe('limit 选入了最新的 50 版，更早的 1 版没选入。')
    const reasonless = kept.filter(v => v.reason === '').length
    expect(text).toContain(`本次输出上限 3000 字：${reasonless} 个版本的原因已省略，要看原因用 id 配 version 读那一版，最早的 ${50 - kept.length} 个版本因输出长度没列出，历史列表不支持 offset 翻页。`)
    expect(text).not.toContain('调大 limit')
  })

  it('limit 没选全、又因长度省掉几行：limit 说明按选入的算，省略说明按留下的算', () => {
    // 标题行占去大半预算，原因都省了还放不下 15 行
    const memoryId = `mem_${'h'.repeat(2600)}`
    const versions = Array.from({ length: 15 }, (_, i) => ({ versionId: `v${String(20 - i).padStart(3, '0')}`, endedAt: new Date(T0 + (20 - i) * MINUTE).toISOString(), reason: `原因${20 - i}：${'因'.repeat(500)}` }))
    const listing = { hits: [], history: { memoryId, versions, total: 20, isComplete: true }, moreNote: '只列出最新的 15 版，要看更早的版本可以调大 limit（最多 50 版）。' }
    const finalized = finalizeSearch(listing, { chars: 3000, threshold: { kind: 'known', chars: 3000 } }, renderSearchResult)
    const text = renderSearchResult(finalized)
    const kept = finalized.history!.versions
    expect(kept.length).toBeLessThan(15)
    expect(text.split('\n')[0]).toBe(`记忆 ${memoryId} 的历史：共读到 20 版，给出 ${kept.length} 版。`)
    expect(finalized.moreNote).toBe('limit 选入了最新的 15 版，更早的 5 版没选入。')
    expect(text).toContain(`${kept.filter(v => v.reason === '').length} 个版本的原因已省略`)
    expect(text).toContain(`最早的 ${15 - kept.length} 个版本因输出长度没列出`)
    expect(text).not.toContain('调大 limit')
  })

  it('只剩一行、只留版本标识：说明里写出来，不留空的冒号', () => {
    const memoryId = `mem_${'k'.repeat(7790)}`
    const finalized = finalizeSearch({ hits: [], history: { memoryId, versions: [{ versionId: 'v001', endedAt: new Date(T0).toISOString(), reason: '' }], total: 1, isComplete: true } }, { chars: 7782, threshold: { kind: 'known', chars: 8192 } }, renderSearchResult)
    expect(renderSearchResult(finalized).split('\n')[1]).toBe('本次输出上限 7782 字：1 个版本只留版本标识。')
  })

  it('50 版、每版原因 500 字：从最旧的一版往前先省原因，说明里的数字对，最新几版原因还在', () => {
    // 50 版真走一遍保存要几秒：直接给收尾一个列表结果，接线由下一条真实读历史的用例验
    const memoryId = 'mem_h50'
    const versions = Array.from({ length: 50 }, (_, i) => ({ versionId: `v${String(50 - i).padStart(3, '0')}`, endedAt: new Date(T0 + (50 - i) * MINUTE).toISOString(), reason: `原因${50 - i}：${'因'.repeat(500)}` }))
    const finalized = finalizeSearch({ hits: [], history: { memoryId, versions, total: 50, isComplete: true } }, { chars: 7782, threshold: { kind: 'known', chars: 8192 } }, renderSearchResult)
    const text = renderSearchResult(finalized)
    expect(points(text)).toBeLessThanOrEqual(7782)
    const kept = finalized.history!.versions
    expect(kept).toHaveLength(50)
    const dropped = kept.filter(v => v.reason === '').length
    expect(dropped).toBeGreaterThan(0)
    // 省掉原因的都在列表末尾（最旧），留下原因的都在前面
    expect(kept.slice(0, 50 - dropped).every(v => v.reason !== '')).toBe(true)
    expect(kept.slice(50 - dropped).every(v => v.reason === '')).toBe(true)
    expect(kept[0]!.reason.startsWith('原因50：')).toBe(true)
    expect(text).toContain(`本次输出上限 7782 字：${dropped} 个版本的原因已省略，要看原因用 id 配 version 读那一版。`)
    expect(text.split('\n')[0]).toBe(`记忆 ${memoryId} 的历史：共读到 50 版，给出 50 版。`)
  })

  it('真实读历史：8 版、每版原因 500 字、预算 3000，按同样的顺序先省最旧几版的原因', async () => {
    const e = env(3000)
    const m = await withVersions(e, 8, i => `原因${i}：${'因'.repeat(500)}`)
    const { result, text } = await e.search({ id: m.id, history: true })
    expect(points(text)).toBeLessThanOrEqual(3000)
    const versions = result.history!.versions
    expect(versions).toHaveLength(8)
    const dropped = versions.filter(v => v.reason === '').length
    expect(dropped).toBeGreaterThan(0)
    expect(versions.slice(0, 8 - dropped).every(v => v.reason !== '')).toBe(true)
    expect(versions[0]!.reason.startsWith('原因7：')).toBe(true)
    expect(text).toContain(`本次输出上限 3000 字：${dropped} 个版本的原因已省略，要看原因用 id 配 version 读那一版。`)
  })

  it('原因都省了仍超：从最旧往前省整行，标题行的版数和说明都按留下的算', () => {
    // 文件名有长度上限，造不出标题行这么长的记忆：直接给收尾一个列表结果
    const memoryId = `mem_${'h'.repeat(2000)}`
    const versions = Array.from({ length: 50 }, (_, i) => ({ versionId: `v${String(50 - i).padStart(3, '0')}`, endedAt: new Date(T0 + (50 - i) * MINUTE).toISOString(), reason: `原因${50 - i}` }))
    const finalized = finalizeSearch({ hits: [], history: { memoryId, versions, total: 50, isComplete: true } }, { chars: 3000, threshold: { kind: 'known', chars: 3000 } }, renderSearchResult)
    const text = renderSearchResult(finalized)
    expect(points(text)).toBeLessThanOrEqual(3000)
    const kept = finalized.history!.versions
    expect(kept.length).toBeLessThan(50)
    // 留下的是最新的几版，原因都已省掉
    expect(kept.map(v => v.versionId)).toEqual(versions.slice(0, kept.length).map(v => v.versionId))
    expect(kept.every(v => v.reason === '')).toBe(true)
    expect(text.split('\n')[0]).toBe(`记忆 ${memoryId} 的历史：共读到 50 版，给出 ${kept.length} 版。`)
    expect(text).toContain(`${kept.length} 个版本的原因已省略，要看原因用 id 配 version 读那一版，最早的 ${50 - kept.length} 个版本因输出长度没列出，历史列表不支持 offset 翻页`)
  })

  it('最小终态：标题行 + 最新一版的版本标识行', () => {
    // 文件名有长度上限，造不出标题行本身就占满预算的记忆：直接给收尾一个列表结果
    const memoryId = `mem_${'q'.repeat(2950)}`
    const versions = [3, 2, 1].map(n => ({ versionId: `2026010${n}T000000000Z`, endedAt: new Date(T0 + n * MINUTE).toISOString(), reason: `原因${n}` }))
    const finalized = finalizeSearch({ hits: [], history: { memoryId, versions, total: 3, isComplete: true } }, { chars: 3000, threshold: { kind: 'known', chars: 3000 } }, renderSearchResult)
    const text = renderSearchResult(finalized)
    expect(finalized.history!.versions).toHaveLength(1)
    expect(text.split('\n')[0]).toBe(`记忆 ${memoryId} 的历史：共读到 3 版，给出 1 版。`)
    expect(text.split('\n').at(-1)).toBe('版本 20260103T000000000Z')
  })
})

describe('按版本读一版：全文例外', () => {
  it('9000 字的一版：全文照给，说明超出上限、可能被裁', async () => {
    const e = env(8192)
    const big = '旧'.repeat(9000)
    const m = await withVersions(e, 1, () => '换掉', { content: big })
    const listed = await e.search({ id: m.id, history: true })
    const versionId = listed.result.history!.versions[0]!.versionId
    const { result, text } = await e.search({ id: m.id, version: versionId })
    expect(result.hits[0]!.content).toBe(big)
    expect(text).toContain('按 id 查的这条全文照给，超出本次输出上限 7782 字')
    expect(text).toContain('可能被裁掉中间部分')
  })

  it('8050 字的一版、阈值 8192：正文没到阈值，加上说明后超过，说可能被裁', async () => {
    const e = env(8192)
    const m = await withVersions(e, 1, () => '换掉', { content: '旧'.repeat(8050) })
    const listed = await e.search({ id: m.id, history: true })
    const { text } = await e.search({ id: m.id, version: listed.result.history!.versions[0]!.versionId })
    expect(points(text)).toBeGreaterThan(8192)
    expect(text).toContain('超出本次输出上限 7782 字，DeepSeek Harness 压缩上下文时可能被裁掉中间部分。')
  })
})
