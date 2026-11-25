import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { layerOf } from '../src/storage/history.ts'
import { describe, expect, it, vi } from 'vitest'
import { runSavePipeline } from '../src/pipeline.ts'
import { isExpired, isInEffect, withinValidity } from '../src/record-freshness.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { scanFingerprint } from '../src/governance/changeset.ts'
import { runRuleScan } from '../src/governance/rule-scan.ts'
import { assembleSnapshot } from '../src/snapshot.ts'
import { executeSearch } from '../src/tools/search.ts'
import { renderSaveResult } from '../src/tools/save.ts'
import { formatValidity } from '../src/validity.ts'
import { createSaveTool } from '../src/tools/save-tool.ts'
import { candidate, record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { userTurnLog } from './helpers/session-log.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

const NOW = new Date(2030, 0, 1, 12).getTime()
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
function setup() {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  return { store, registry, workspacePath: '/proj', session: { id: 's', lastSeq: 1 }, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), now: () => NOW }
}

describe('事实时间与有效期', () => {
  it.each([[undefined, false], [NOW, true], [NOW + 1, false], [NOW - 1, true]] as const)('截止时间为 %s 时过期判断为 %s', (validTo, expected) => {
    expect(isExpired(record({ validTo }), NOW)).toBe(expected)
  })
  it.each([[undefined, true], [NOW, true], [NOW + 1, false], [NOW - 1, true]] as const)('起始时间为 %s 时生效判断为 %s', (validFrom, expected) => {
    expect(isInEffect(record({ validFrom }), NOW)).toBe(expected)
  })
  it.each([[true, true], [true, false], [false, true], [false, false]])('生效为 %s 且过期为 %s 时仅生效未过期才有效', (effective, expired) => {
    expect(withinValidity(record({ validFrom: NOW + (effective ? 0 : 1), validTo: NOW + (expired ? 0 : 1) }), NOW)).toBe(effective && !expired)
  })
  it('未来生效的记忆不注入不检索也不报过期，推进时钟后出现', async () => {
    const d = setup()
    let now = NOW
    const r = record({ id: 'mem_future', content: 'magicword', validFrom: NOW + 1000, validTo: NOW + 2000 })
    const expired = record({ id: 'mem_expired', content: 'magicword', validTo: NOW })
    await d.store.put(r)
    await d.store.put(expired)
    const snapshot = () => assembleSnapshot({ records: [r, expired], registry, workspacePath: undefined, budget: 4000, now }).text
    const search = () => executeSearch({ query: 'magicword' }, fakeExec(), { store: d.store, registry, now: () => now, host: { contextOf: async () => ({ workspacePath: undefined, session: d.session }) } })
    expect(snapshot()).not.toContain(r.id)
    expect((await search()).hits).toEqual([])
    expect(runRuleScan([r, expired], () => undefined, now).map(f => f.memoryIds)).toEqual([[expired.id]])
    now += 1000
    expect(snapshot()).toContain(r.id)
    expect(snapshot()).not.toContain(expired.id)
    expect((await search()).hits.map(h => h.id)).toEqual([r.id])
  })
  it.each(['2024', '2024-03', '2024-03-15', '2024-03-15T12:34:56.123+08:00'])('新建原样保存事实时间 %s', async factTime => {
    const d = setup()
    const result = await runSavePipeline(candidate({ factTime }), d)
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect((await d.store.get(result.record.id, { workspacePath: '/proj' }))!.factTime).toBe(factTime)
  })
  it.each(['2026-02-30', '三月', '2024/03/15', '24-3-15', ''])('新建拒绝无效事实时间 %s 且不写入', async factTime => {
    const d = setup()
    const result = await runSavePipeline(candidate({ factTime }), d)
    expect(result).toMatchObject({ kind: 'rejected', code: 'validity-format' })
    if (result.kind !== 'rejected') throw new Error(result.kind)
    for (const format of ['YYYY', 'YYYY-MM', 'YYYY-MM-DD', 'ISO 8601']) expect(result.reason).toContain(format)
    expect(await d.store.query({ scope: { kind: 'visible', workspacePath: '/proj' } })).toEqual([])
  })
  it('只改事实时间遵守改动性质规则并更新指纹、保留历史和其他内容', async () => {
    const d = setup()
    const created = await runSavePipeline(candidate({ factTime: '2024' }), d)
    if (created.kind !== 'saved') throw new Error(created.kind)
    const input = { action: 'update' as const, id: created.record.id, sourceMode: 'user-explicit' as const, factTime: '2025' }
    expect(await runSavePipeline(input, d)).toMatchObject({ kind: 'rejected', code: 'change-kind-missing' })
    const result = await runSavePipeline({ ...input, change: 'state-change' }, { ...d, now: () => NOW + 1000 })
    if (result.kind !== 'updated') throw new Error(result.kind)
    expect(result.record.factTime).toBe('2025')
    expect(scanFingerprint(result.record)).not.toBe(scanFingerprint(created.record))
    for (const key of ['name', 'content', 'summary', 'tags', 'type', 'createdAt'] as const) expect(result.record[key]).toEqual(created.record[key])
    expect(result.record.lastChange?.kind).toBe('state-change')
    const located = await d.store.locate(result.record.id, { workspacePath: '/proj' })
    const versions = await d.store.history.list(layerOf(located!), result.record.id)
    expect(versions[0]!.record.factTime).toBe('2024')
  })
  it('更新省略事实时间保留原值，空字符串清除，快照恢复原值', async () => {
    const d = setup()
    const created = await runSavePipeline(candidate({ factTime: '2024' }), d)
    if (created.kind !== 'saved') throw new Error(created.kind)
    const input = candidate({ action: 'update', scope: 'workspace', change: 'correct', id: created.record.id })
    expect(await runSavePipeline(input, d)).toMatchObject({ record: { factTime: '2024' } })
    const result = await runSavePipeline({ ...input, factTime: '' }, d)
    if (result.kind !== 'updated') throw new Error(result.kind)
    expect(await d.store.get(result.record.id, { workspacePath: '/proj' })).not.toHaveProperty('factTime')
    const snapshot = (await d.snapshots.list())[0]!
    const restored = await d.snapshots.restore(snapshot, undefined, d.store, { target: 'exact', overwrite: true, now: () => NOW })
    expect(restored.restored).toContain(result.record.id)
    expect(await d.store.get(result.record.id, { workspacePath: '/proj' })).toMatchObject({ factTime: '2024' })
  })
  it.each(['2024', '2040'])('事实时间 %s 可以在有效期之外', async factTime => {
    expect(await runSavePipeline(candidate({ factTime, validFrom: '2030-01-02', validTo: '2030-01-03' }), setup())).toMatchObject({ kind: 'saved', record: { factTime } })
  })
  it('补证忽略传入的事实时间并保留原值', async () => {
    const d = setup()
    const created = await runSavePipeline(candidate({ factTime: '2024' }), d)
    if (created.kind !== 'saved') throw new Error(created.kind)
    expect(await runSavePipeline({ action: 'update', change: 'corroborate', id: created.record.id, sourceMode: 'user-explicit', factTime: '三月' }, d)).toMatchObject({ kind: 'updated', record: { factTime: '2024' }, warnings: expect.arrayContaining([expect.objectContaining({ code: 'corroborate-fields-ignored', text: expect.stringContaining('factTime') })]) })
  })
  it.each([false, true])('预读后插入另一路保存，两处改动都保留（正文先预读：%s）', async reverse => {
    const root = await mkdtemp(join(tmpdir(), 'fact-time-race-'))
    try {
      const d = { ...setup(), store: new MemoryStore(new FileTable({ root, now: () => NOW, stats: new InMemoryKvTable<RecallStats>() }), undefined, new InMemoryBatchKvTable()) }
      const created = await runSavePipeline(candidate({ factTime: '2024' }), d)
      if (created.kind !== 'saved') throw new Error(created.kind)
      const id = created.record.id
      const saves = [
        () => runSavePipeline({ action: 'update', change: 'correct', id, sourceMode: 'user-explicit', factTime: '2025' }, d),
        () => runSavePipeline({ action: 'update', change: 'correct', id, sourceMode: 'user-explicit', edits: [{ oldString: '数据库', newString: '网络' }] }, d),
      ]
      const get = d.store.get.bind(d.store)
      let fired = false
      const results = []
      const spy = vi.spyOn(d.store, 'get').mockImplementation(async (gid, hint, opts) => {
        const r = await get(gid, hint, opts)
        if (gid === id && !fired && r !== undefined) {
          fired = true
          results.push(await saves[reverse ? 0 : 1]!())
        }
        return r
      })
      try {
        results.push(await saves[reverse ? 1 : 0]!())
      } finally { spy.mockRestore() }
      expect(results.map(r => r.kind)).toEqual(['updated', 'updated'])
      expect(await d.store.get(id, { workspacePath: '/proj' })).toMatchObject({ factTime: '2025', content: '测试里不要 mock 网络' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['2026-02-30', '三月'])('更新拒绝非法事实时间 %s 且记录不变', async factTime => {
    const d = setup()
    const created = await runSavePipeline(candidate({ factTime: '2024' }), d)
    if (created.kind !== 'saved') throw new Error(created.kind)
    const before = await d.store.get(created.record.id, { workspacePath: '/proj' })
    expect(await runSavePipeline({ action: 'update', id: created.record.id, sourceMode: 'user-explicit', change: 'correct', factTime }, d)).toMatchObject({ kind: 'rejected', code: 'validity-format' })
    expect(await d.store.get(created.record.id, { workspacePath: '/proj' })).toEqual(before)
  })
  it('不带正文也能用空字符串清除事实时间', async () => {
    const d = setup()
    const created = await runSavePipeline(candidate({ factTime: '2024' }), d)
    if (created.kind !== 'saved') throw new Error(created.kind)
    const result = await runSavePipeline({ action: 'update', id: created.record.id, sourceMode: 'user-explicit', change: 'correct', factTime: '' }, d)
    expect(result.kind).toBe('updated')
    const saved = await d.store.get(created.record.id, { workspacePath: '/proj' })
    expect(saved).not.toHaveProperty('factTime')
    expect(saved?.content).toBe(created.record.content)
  })
  it('事实时间与关联同传时要求改动性质，并一起保存', async () => {
    const d = setup()
    const other = record({ scope: 'workspace', workspacePath: '/proj' })
    await d.store.put(other)
    const created = await runSavePipeline(candidate({ factTime: '2024' }), d)
    if (created.kind !== 'saved') throw new Error(created.kind)
    const input = { action: 'update' as const, id: created.record.id, sourceMode: 'user-explicit' as const, factTime: '2025', related: [other.id] }
    expect(await runSavePipeline(input, d)).toMatchObject({ kind: 'rejected', code: 'change-kind-missing' })
    expect(await runSavePipeline({ ...input, change: 'correct' }, d)).toMatchObject({ kind: 'updated', record: { factTime: '2025', related: [other.id] } })
    expect(await d.store.get(created.record.id, { workspacePath: '/proj' })).toMatchObject({ factTime: '2025', related: [other.id], content: created.record.content })
  })
  it('未来生效的相同记忆阻止重复新建，但检索仍不可见', async () => {
    const d = setup()
    const input = candidate({ validFrom: '2030-01-02' })
    const first = await runSavePipeline(input, d)
    if (first.kind !== 'saved') throw new Error(first.kind)
    expect(await runSavePipeline(input, d)).toMatchObject({ kind: 'duplicate-suspected', existing: { id: first.record.id } })
    const search = await executeSearch({ query: first.record.id }, fakeExec(), { ...d, host: { contextOf: async () => ({ workspacePath: '/proj', session: d.session }) } })
    expect(search.hits).toEqual([])
  })
  it('未来生效的相近记忆出现在新建回执的相近列表', async () => {
    const d = setup()
    const first = await runSavePipeline(candidate({ validFrom: '2030-01-02' }), d)
    if (first.kind !== 'saved') throw new Error(first.kind)
    expect(await runSavePipeline(candidate({ content: '测试数据库连接池必须使用真实连接验证超时回收', summary: '数据库连接池超时回收' }), d)).toMatchObject({ kind: 'saved', similar: expect.arrayContaining([expect.objectContaining({ id: first.record.id })]) })
  })
  it('已过期的相同记忆不阻止新建', async () => {
    const d = setup()
    const first = await runSavePipeline(candidate({ validTo: '2030-01-02' }), d)
    if (first.kind !== 'saved') throw new Error(first.kind)
    expect(await runSavePipeline(candidate(), { ...d, now: () => first.record.validTo! })).toMatchObject({ kind: 'saved' })
  })
  it.each(['saved', 'updated'] as const)('%s 的未来生效回执说明开始时刻', kind => {
    const r = record({ validFrom: NOW + 60_000 })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      const text = renderSaveResult({ kind, record: r })
      expect(text).toContain(`从 ${formatValidity(r.validFrom!)} 起才带入对话并可检索`)
      expect(text).not.toContain('下个会话注入')
    } finally { vi.restoreAllMocks() }
  })
  it('没有起始时间的保存与更新回执保持原文', () => {
    const r = record()
    expect(renderSaveResult({ kind: 'saved', record: r })).toBe(`已保存记忆 ${r.id}（${r.type}，${r.scope}）。下个会话注入；本会话若触发上下文压缩，压缩后即生效。回复里不用提这次保存。`)
    expect(renderSaveResult({ kind: 'updated', record: r })).toBe(`已更新记忆 ${r.id}（${r.name}）。回复里不用提这次保存。`)
  })
  it('工具声明提供可选事实时间并说明四种格式和清除方式', () => {
    const d = setup()
    const tool = createSaveTool({ ...d, host: { saveContextOf: async () => ({ workspacePath: '/proj', session: d.session }), readSessionLog: userTurnLog } })
    const schema = tool.parameters as unknown as { required?: string[]; properties: Record<string, { type: string; description: string }> }
    expect(schema.required).not.toContain('factTime')
    expect(schema.properties.factTime?.type).toBe('string')
    for (const text of ['YYYY', 'YYYY-MM', 'YYYY-MM-DD', 'ISO 8601', '空字符串']) expect(schema.properties.factTime?.description).toContain(text)
  })
})
