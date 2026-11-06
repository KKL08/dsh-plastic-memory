import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { renderSaveResult } from '../src/tools/save.ts'
import { extractEntities } from '../src/text.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { editFingerprint } from '../src/governance/snapshots.ts'
import { candidate, record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { SECRET_MASK } from '../src/secrets.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const session = { id: 's1', lastSeq: 42 }

function deps(store = new MemoryStore(new InMemoryTable())) {
  return { store, registry, workspacePath: '/proj' as string | undefined, session, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()) }
}

describe('extractEntities', () => {
  it('提取路径、URL、反引号标识符、引号短语', () => {
    const entities = extractEntities('改 `src/auth.ts`，文档在 https://example.com/doc，按「先测再改」来')
    expect(entities).toContain('src/auth.ts')
    expect(entities).toContain('https://example.com/doc')
    expect(entities).toContain('先测再改')
  })

  it('超常见缩写不当实体（API/URL 等），两位长度大写串不当实体', () => {
    const entities = extractEntities('调 API 拿 JSON，见 OK 按钮，走 AKIA 流程')
    expect(entities).not.toContain('API')
    expect(entities).not.toContain('JSON')
    expect(entities).not.toContain('OK')   // 长度 <3
    expect(entities).toContain('AKIA')     // 非停用词的大写串仍是实体
  })
})

describe('runSavePipeline', () => {
  it('未知 type 返回 rejected(unknown-type)', async () => {
    const result = await runSavePipeline(candidate({ type: 'ghost' }), deps())
    expect(result).toMatchObject({ kind: 'rejected', code: 'unknown-type' })
  })

  it('组装出的记录过不了 schema 时 rejected 而非写入脏数据', async () => {
    const result = await runSavePipeline(candidate({ name: '' }), deps())   // name 最短 1 字符
    expect(result).toMatchObject({ kind: 'rejected', code: 'schema-invalid' })
  })

  it('create 成功：生成 id、时间字段一致、confidence 按映射', async () => {
    const result = await runSavePipeline(candidate(), deps())
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.id).toMatch(/^mem_/)
    expect(result.record.createdAt).toBe(result.record.updatedAt)
    expect(result.record.confidence).toBe(0.9)
    expect(result.record.source).toEqual({ sessionId: 's1', eventRange: [0, 42], sourceMode: 'user-explicit' })
  })

  // 证据锚（这条记忆出自会话的哪段事件）：eventRange = [当轮 turn/start, save 时刻]，绑定层机械填充
  it('session 带 turnStartSeq 时 eventRange 用真实当轮区间', async () => {
    const result = await runSavePipeline(candidate(), { ...deps(), session: { id: 's1', lastSeq: 42, turnStartSeq: 37 } })
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.source?.eventRange).toEqual([37, 42])
  })

  it('turnStartSeq 越过 lastSeq 时夹到 lastSeq（防坏输入产出倒置区间）', async () => {
    const result = await runSavePipeline(candidate(), { ...deps(), session: { id: 's1', lastSeq: 5, turnStartSeq: 9 } })
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.source?.eventRange).toEqual([5, 5])
  })

  it('confidence 只能下调不能上调', async () => {
    const up = await runSavePipeline(candidate({ sourceMode: 'agent-inferred', confidence: 0.95 }), deps())
    if (up.kind !== 'saved') throw new Error(up.kind)
    expect(up.record.confidence).toBe(0.5)
  })

  it('update 路径的 confidence 同样只能下调（走同一套映射钳制）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate(), deps(store))   // sourceMode 默认 user-explicit，confidence 0.9
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, sourceMode: 'agent-inferred', confidence: 0.95 }),
      deps(store),
    )
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(updated.record.confidence).toBe(0.5)
  })

  it('无 workspacePath（无 cwd 会话）时 create 一律拒存——落 global 会绕过用户确认闸', async () => {
    const result = await runSavePipeline(candidate({ scope: 'workspace' }), { ...deps(), workspacePath: undefined })
    if (result.kind !== 'rejected') throw new Error(result.kind)
    expect(result).toMatchObject({ kind: 'rejected', code: 'no-workspace' })
    expect(result.reason).not.toContain('桶')   // PA-19
  })

  it('模型填 global（有 workspace）降级 workspace + globalCandidate（无 global 直写通道）', async () => {
    const result = await runSavePipeline(candidate({ scope: 'global' }), deps())
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.scope).toBe('workspace')
    expect(result.record.workspacePath).toBe('/proj')
    expect(result.record.globalCandidate).toBe(true)
  })

  it('填 global 且无 workspacePath 时同样拒存（global 直写必须过提升闸，没有作用域可降级）', async () => {
    const result = await runSavePipeline(candidate({ scope: 'global' }), { ...deps(), workspacePath: undefined })
    expect(result).toMatchObject({ kind: 'rejected', code: 'no-workspace' })
  })

  // A1 回归：例行 update 不得变更 scope——已经用户确认提升的 global 记忆若能被 update
  // 拉回当前项目，提升闸就被写入链绕过了（发布前审计双方独立发现并实证的缺陷）。
  it('update 一条 global 记录（模型照实填 scope=global）不降级、不搬家', async () => {
    const store = new MemoryStore(new InMemoryTable())
    // 模拟 promote 后的 global 记录：直接放一条 scope=global 进 store
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    await store.put({ ...created.record, scope: 'global', workspacePath: undefined } as never)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, scope: 'global', content: '例行内容更新' }),
      deps(store),
    )
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(updated.record.scope).toBe('global')
    expect(updated.record.workspacePath).toBeUndefined()
    expect(updated.record.globalCandidate).toBeUndefined()
  })

  it('update 时填与 target 不同的 scope：保持原 scope 并给警告', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    await store.put({ ...created.record, scope: 'global', workspacePath: undefined } as never)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, scope: 'workspace', content: '想拉回项目' }),
      deps(store),
    )
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(updated.record.scope).toBe('global')
    expect(updated.warnings?.map(w => w.code)).toContain('update-scope-kept')
  })

  it('update workspace 记录填 global：转为提升候选并提示；已是候选则静默幂等', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    const first = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, scope: 'global' }), deps(store))
    if (first.kind !== 'updated') throw new Error(first.kind)
    expect(first.record.scope).toBe('workspace')
    expect(first.record.globalCandidate).toBe(true)
    expect(first.warnings?.map(w => w.code)).toContain('update-global-candidate')
    const second = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, scope: 'global' }), deps(store))
    if (second.kind !== 'updated') throw new Error(second.kind)
    expect(second.record.globalCandidate).toBe(true)
    expect(second.warnings).toBeUndefined()
  })

  it('正常 workspace 存不带 globalCandidate', async () => {
    const result = await runSavePipeline(candidate({ scope: 'workspace' }), deps())
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.scope).toBe('workspace')
    expect(result.record.globalCandidate).toBeUndefined()
  })

  it('同实体的同类记忆触发 duplicate-suspected，force 可跳过', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await runSavePipeline(candidate({ content: '认证逻辑在 `src/auth.ts`' }), deps(store))
    const dup = await runSavePipeline(candidate({ content: '`src/auth.ts` 负责认证' }), deps(store))
    expect(dup.kind).toBe('duplicate-suspected')
    const forced = await runSavePipeline(candidate({ content: '`src/auth.ts` 负责认证', force: true }), deps(store))
    expect(forced.kind).toBe('saved')
  })

  it('PA-10 去重提示里已有记忆的摘要手改进高危密钥：只给遮盖后的文字', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({
      id: 'mem_handedit', type: 'preference', scope: 'workspace', workspacePath: '/proj',
      content: '认证逻辑在 `src/auth.ts`', summary: `认证入口 ${FAKE_SECRET.sk}`, handEdited: true,
    }))
    const dup = await runSavePipeline(candidate({ content: '`src/auth.ts` 负责认证' }), deps(store))
    if (dup.kind !== 'duplicate-suspected') throw new Error(dup.kind)
    expect(dup.existing).toEqual([{ id: 'mem_handedit', summary: `认证入口 ${SECRET_MASK}` }])
    expect(renderSaveResult(dup)).not.toContain(FAKE_SECRET.sk)
  })

  it('update 保留 createdAt、刷新 lastConfirmedAt', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const clock = { now: 1_700_000_000_000 }
    const first = await runSavePipeline(candidate(), { ...deps(store), now: () => clock.now })
    if (first.kind !== 'saved') throw new Error(first.kind)
    clock.now += 1000
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: first.record.id, content: '新内容' }), { ...deps(store), now: () => clock.now })
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(updated.record).toMatchObject({ createdAt: 1_700_000_000_000, lastConfirmedAt: 1_700_000_001_000, updatedAt: 1_700_000_001_000 })
  })

  it('update 目标 id 不存在时 rejected(target-missing)', async () => {
    const result = await runSavePipeline(
      candidate({ action: 'update', id: 'mem_不存在' }), deps())
    expect(result).toMatchObject({ kind: 'rejected', code: 'target-missing' })
  })

  it('update 目标已 softDelete 时 rejected', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate(), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    await store.softDelete(created.record)
    const result = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '新内容' }), deps(store))
    expect(result).toMatchObject({ kind: 'rejected', code: 'target-missing' })
  })

  it('supersedes 把旧记忆置为 superseded', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const old = await runSavePipeline(candidate(), deps(store))
    if (old.kind !== 'saved') throw new Error(old.kind)
    await runSavePipeline(candidate({ content: '完全不同的新说法', force: true, supersedes: [old.record.id] }), deps(store))
    expect((await store.get(old.record.id))!.status).toBe('superseded')
  })

  it('PA-01：替代目标里有已删除的：它仍是已删除、仍在最近删除、deletedAt 不变；同批在用的目标照常变成被取代', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const gone = await runSavePipeline(candidate({ name: '删掉的', content: '删掉的说法' }), deps(store))
    const live = await runSavePipeline(candidate({ name: '在用的', content: '在用的说法', force: true }), deps(store))
    if (gone.kind !== 'saved' || live.kind !== 'saved') throw new Error('seed')
    await store.softDelete(gone.record, { now: 1_000 })
    const r = await runSavePipeline(candidate({ content: '完全不同的新说法', force: true, supersedes: [gone.record.id, live.record.id] }), deps(store))
    expect(r.kind).toBe('saved')
    expect(await store.get(gone.record.id)).toMatchObject({ status: 'deleted', deletedAt: 1_000 })
    expect((await store.query({ status: ['deleted'] })).map(m => m.id)).toEqual([gone.record.id])
    expect((await store.get(live.record.id))!.status).toBe('superseded')
  })

  it('PA-13：supersedes 里含高危密钥时拒存、不落盘；疑似密钥要 force', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const critical = await runSavePipeline(candidate({ supersedes: [FAKE_SECRET.sk] }), deps(store))
    expect(critical).toMatchObject({ kind: 'rejected', code: 'secret-critical' })
    expect(await store.query({ status: ['active', 'superseded', 'deleted'] })).toEqual([])
    const suspected = candidate({ supersedes: ['password=hunter2hunter2'] })
    expect(await runSavePipeline(suspected, deps(store))).toMatchObject({ kind: 'rejected', code: 'secret-suspected' })
    expect((await runSavePipeline({ ...suspected, force: true }, deps(store))).kind).toBe('saved')
  })

  // B1a：supersedes 目标必须与本次写入记录同属一个作用域
  it('B1a: workspace 保存 supersedes 指向 global 记录 → global 保持 active 且给警告', async () => {
    const store = new MemoryStore(new InMemoryTable())
    // 放一条 global 记录（模拟 promote 后）
    const g = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (g.kind !== 'saved') throw new Error(g.kind)
    await store.put({ ...g.record, id: 'mem_global', scope: 'global', workspacePath: undefined } as never)
    const saved = await runSavePipeline(
      candidate({ scope: 'workspace', name: '新事实', content: '完全不同的新说法', force: true, supersedes: ['mem_global'] }),
      deps(store))
    if (saved.kind !== 'saved') throw new Error(saved.kind)
    expect((await store.get('mem_global'))!.status).toBe('active')
    expect(saved.warnings?.map(w => w.code)).toContain('cross-bucket-supersede')
    expect(saved.warnings?.find(w => w.code === 'cross-bucket-supersede')?.text).not.toContain('桶')   // PA-19 稳定码不变、文字不说「桶」
  })

  it('B1a: 同 workspace 目标仍正常置 superseded（回归）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const old = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (old.kind !== 'saved') throw new Error(old.kind)
    const saved = await runSavePipeline(
      candidate({ scope: 'workspace', name: '新事实', content: '完全不同的新说法', force: true, supersedes: [old.record.id] }),
      deps(store))
    if (saved.kind !== 'saved') throw new Error(saved.kind)
    expect((await store.get(old.record.id))!.status).toBe('superseded')
    expect(saved.warnings).toBeUndefined()
  })

  // B1b：update 不能跨 workspace 改写其他项目的记忆
  it('B1b: update 指向其他 workspace 的记录 → rejected', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))  // workspacePath /proj
    if (created.kind !== 'saved') throw new Error(created.kind)
    const result = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '别的项目想改' }),
      { ...deps(store), workspacePath: '/other' })
    if (result.kind !== 'rejected') throw new Error(result.kind)
    expect(result).toMatchObject({ kind: 'rejected', code: 'cross-workspace' })
  })

  it('B1b: update 指向本 workspace 记录 → 正常（回归）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    const result = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '本项目内更新' }), deps(store))
    expect(result.kind).toBe('updated')
  })

  it('B1b: 无 cwd 会话（workspacePath undefined）update workspace 记录 → rejected', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    const result = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '无 cwd 想改' }),
      { ...deps(store), workspacePath: undefined })
    expect(result).toMatchObject({ kind: 'rejected', code: 'cross-workspace' })
  })

  // B1c：update global 目标快照先行
  it('B1c: update global 记录（带 snapshots dep）→ 拍 pre-update 快照含旧内容、警告带快照 id', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const snaps = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    await store.put({ ...created.record, scope: 'global', workspacePath: undefined, content: '旧的全局内容' } as never)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, scope: 'global', content: '新的全局内容' }),
      { ...deps(store), snapshots: snaps })
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    const list = await snaps.list()
    expect(list).toHaveLength(1)
    expect(list[0].operation).toBe('pre-update')
    expect(list[0].data[0].content).toBe('旧的全局内容')
    expect(updated.record.content).toBe('新的全局内容')
    expect(updated.warnings?.some(w => w.code === 'auto-snapshot' && w.text.includes(list[0].id))).toBe(true)
  })

  it('B1c: update global 记录不带 snapshots dep → 更新成功不炸', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    await store.put({ ...created.record, scope: 'global', workspacePath: undefined } as never)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, scope: 'global', content: '新内容' }), deps(store))
    expect(updated.kind).toBe('updated')
  })

  it('update workspace 记录同样先拍 pre-update 快照（含旧内容），结果不变：没有警告', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const snaps = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const created = await runSavePipeline(candidate({ scope: 'workspace', content: '旧的项目内容' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, scope: 'workspace', content: '本项目内更新' }),
      { ...deps(store), snapshots: snaps })
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(Object.keys(updated)).not.toContain('warnings')
    const list = await snaps.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ operation: 'pre-update', memoryIds: [created.record.id] })
    expect(list[0].data[0]!.content).toBe('旧的项目内容')
  })

  // B2：判重级联——实体轴优先，实体为空才落 Dice 兜底
  it('B2: 两条含相同实体的记忆仍判重（实体轴回归）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await runSavePipeline(candidate({ scope: 'workspace', content: '认证逻辑在 `src/auth.ts`' }), deps(store))
    const dup = await runSavePipeline(candidate({ scope: 'workspace', content: '`src/auth.ts` 负责认证' }), deps(store))
    expect(dup.kind).toBe('duplicate-suspected')
  })

  it('B2: 有实体但实体不重叠、字面高度相似 → 不再判重（级联生效）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const first = await runSavePipeline(
      candidate({ scope: 'workspace', content: '超时配置在 `src/config-a.ts` 里，默认三十秒', summary: '超时配置位置' }), deps(store))
    if (first.kind !== 'saved') throw new Error(first.kind)
    const second = await runSavePipeline(
      candidate({ scope: 'workspace', name: '另一处', content: '超时配置在 `src/config-b.ts` 里，默认三十秒', summary: '超时配置位置' }), deps(store))
    expect(second.kind).toBe('saved')
  })

  it('B2: 无实体的纯中文散文高相似 → 仍判重（Dice 兜底回归）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const first = await runSavePipeline(
      candidate({ scope: 'workspace', content: '测试里不要 mock 数据库', summary: '测试不 mock 数据库' }), deps(store))
    if (first.kind !== 'saved') throw new Error(first.kind)
    const dup = await runSavePipeline(
      candidate({ scope: 'workspace', name: '换个说法', content: '测试的时候不要 mock 数据库', summary: '测试别 mock 数据库' }), deps(store))
    expect(dup.kind).toBe('duplicate-suspected')
  })

  // 真机回归：dsh defineTool 对工具输出做 lossless JSON 校验。可选字段（workspacePath/
  // validFrom/validTo/supersedes）不填时若为 undefined，zod .optional() 保留该键，
  // JSON round-trip 丢键 → 被拒 "value is not lossless JSON"。返回的记录不能带 undefined 键。
  it('create 不填可选字段：返回记录无 undefined 键，可无损 JSON 序列化', async () => {
    const result = await runSavePipeline(candidate({ scope: 'workspace' }), deps())   // 不填 validFrom/validTo/supersedes
    if (result.kind !== 'saved') throw new Error(result.kind)
    const undefKeys = Object.entries(result.record).filter(([, v]) => v === undefined).map(([k]) => k)
    expect(undefKeys).toEqual([])
    const round = JSON.parse(JSON.stringify(result.record))
    expect(Object.keys(round).sort()).toEqual(Object.keys(result.record).sort())   // round-trip 键集一致才算 lossless
  })

  it('update 一条 global 记录（workspacePath 归 undefined）不留 undefined 键', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    // 目标是真正的 global 记录（B1b 允许维护 global；跨 workspace 才拒绝）
    await store.put({ ...created.record, scope: 'global', workspacePath: undefined } as never)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, scope: 'global' }), deps(store))
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(Object.values(updated.record).filter(v => v === undefined)).toEqual([])
  })

  it('含疑似密钥（无厂商特征）时带 force 才落盘，保留 warnings', async () => {
    const result = await runSavePipeline(
      candidate({ content: '内部约定 api_key: TESTONLY0000000000000', force: true }),
      deps(),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.length).toBeGreaterThan(0)
    expect(result.warnings![0].code).toBe('secret-suspected')
    expect(result.warnings![0].text.length).toBeGreaterThan(0)
  })

  it('含高危密钥（明确厂商特征）时 rejected 且不落盘（D6）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const result = await runSavePipeline(
      candidate({ content: `我的 API 密钥是 ${FAKE_SECRET.skProj}` }),
      deps(store),
    )
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') {
      expect(result.code).toBe('secret-critical')
      expect(result.reason.length).toBeGreaterThan(0)
    }
    expect(await store.query({ scope: { kind: 'global' } })).toHaveLength(0) // 未落盘
  })

  it('无密钥 content 时 result 不存在 warnings 键（undefined 键纪律）', async () => {
    const result = await runSavePipeline(candidate(), deps())
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(Object.keys(result)).not.toContain('warnings')
  })

  it('update 含疑似密钥带 force 时返回 warnings', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate(), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '密码:TESTONLYpassw0rd', force: true }),
      deps(store),
    )
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(updated.warnings).toBeDefined()
    expect(updated.warnings!.length).toBeGreaterThan(0)
  })

  it('中文散文重复经 bigram 相似度查出（实体轴对纯中文失明）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const first = await runSavePipeline(
      candidate({ scope: 'workspace', content: '测试里不要 mock 数据库', summary: '测试不 mock 数据库' }), deps(store))
    if (first.kind !== 'saved') throw new Error(first.kind)
    const dup = await runSavePipeline(
      candidate({ scope: 'workspace', name: '换个说法', content: '测试的时候不要 mock 数据库', summary: '测试别 mock 数据库' }), deps(store))
    expect(dup.kind).toBe('duplicate-suspected')
  })

  it('同类型不同主题的中文记忆不误判重复', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await runSavePipeline(
      candidate({ scope: 'workspace', content: '报销截止是每个月的二十五日', summary: '报销截止日' }), deps(store))
    const other = await runSavePipeline(
      candidate({ scope: 'workspace', name: '冻结窗口', content: '合并冻结持续到下个季度初', summary: '合并冻结窗口' }), deps(store))
    expect(other.kind).toBe('saved')
  })

  // 密钥检测覆盖全部外泄面：summary 进注入索引、name 进文件名、tags 进索引行
  it('高危密钥只出现在 summary 时同样拦截不落盘', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const result = await runSavePipeline(
      candidate({ scope: 'workspace', content: '正文干净', summary: `密钥 ${FAKE_SECRET.sk} 备份` }),
      deps(store),
    )
    expect(result).toMatchObject({ kind: 'rejected', code: 'secret-critical' })
    expect((await store.query({})).length).toBe(0)
  })

  it('疑似密钥出现在 tags 时同样拦下待确认', async () => {
    const result = await runSavePipeline(
      candidate({ scope: 'workspace', content: '正文干净', tags: ['api_key: TESTONLY0000000000000'] }),
      deps(),
    )
    expect(result).toMatchObject({ kind: 'rejected', code: 'secret-suspected' })
  })

  it('update 无密钥时不存在 warnings 键', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate(), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '更新内容无密钥' }),
      deps(store),
    )
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(Object.keys(updated)).not.toContain('warnings')
  })
})

// 有效期：入参 YYYY-MM-DD HH:mm 或 YYYY-MM-DD（本机时间），只有日期时补写入时刻的时分；内部存毫秒。
// 期望值用 new Date(年, 月, 日, 时, 分) 在同一时区里算，与机器时区无关；写入时刻固定。
describe('runSavePipeline：有效期', () => {
  const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
  const NOW = local(2026, 10, 29, 14, 37) + 20_500   // 写入时刻 2026-10-29 14:37:20.5
  const WRITE_MINUTE = local(2026, 10, 29, 14, 37)
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  async function save(partial: object, store = new MemoryStore(new InMemoryTable())) {
    return runSavePipeline(candidate({ scope: 'workspace', ...partial }), deps(store))
  }

  it('两个都给且带时分：照写换算成毫秒', async () => {
    const r = await save({ validFrom: '2026-11-01 09:30', validTo: '2026-11-05 18:00' })
    if (r.kind !== 'saved') throw new Error(r.kind)
    expect(r.record.validFrom).toBe(local(2026, 11, 1, 9, 30))
    expect(r.record.validTo).toBe(local(2026, 11, 5, 18, 0))
  })

  it('只有日期：两个都补写入时刻的时分', async () => {
    const r = await save({ validFrom: '2026-10-01', validTo: '2026-11-05' })
    if (r.kind !== 'saved') throw new Error(r.kind)
    expect(r.record.validFrom).toBe(local(2026, 10, 1, 14, 37))
    expect(r.record.validTo).toBe(local(2026, 11, 5, 14, 37))
  })

  it.each([
    ['带时分', { validFrom: '2026-11-01 09:30', validTo: '2026-11-05 18:00' }, () => [local(2026, 11, 1, 9, 30), local(2026, 11, 5, 18, 0)]],
    ['只有日期', { validFrom: '2026-10-01', validTo: '2026-11-05' }, () => [local(2026, 10, 1, 14, 37), local(2026, 11, 5, 14, 37)]],
  ] as const)('落库毫秒正确（%s）：从 store 回读、重新打开文件存储再读，两个字段都是换算后的毫秒', async (_label, partial, expected) => {
    const [from, to] = expected()
    const memory = new MemoryStore(new InMemoryTable())
    const inMemory = await save(partial, memory)
    if (inMemory.kind !== 'saved') throw new Error(inMemory.kind)
    expect(await memory.get(inMemory.record.id, { workspacePath: '/proj' })).toMatchObject({ validFrom: from, validTo: to })

    const root = await mkdtemp(join(tmpdir(), 'pm-validity-'))
    try {
      const open = () => new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>(), now: () => NOW }))
      const saved = await save(partial, open())
      if (saved.kind !== 'saved') throw new Error(saved.kind)
      expect(await open().get(saved.record.id, { workspacePath: '/proj' })).toMatchObject({ validFrom: from, validTo: to })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('只给 validTo（截止时间）：validFrom 记写入时刻（到分钟）', async () => {
    const r = await save({ validTo: '2026-11-05 18:00' })
    if (r.kind !== 'saved') throw new Error(r.kind)
    expect(r.record.validFrom).toBe(WRITE_MINUTE)
    expect(r.record.validTo).toBe(local(2026, 11, 5, 18, 0))
  })

  it('只给 validFrom：不加 validTo（不限期），已过去的 validFrom 也收', async () => {
    const r = await save({ validFrom: '2026-01-01' })
    if (r.kind !== 'saved') throw new Error(r.kind)
    expect(r.record.validFrom).toBe(local(2026, 1, 1, 14, 37))
    expect('validTo' in r.record).toBe(false)
  })

  it('两个都不给：记录里不出现这两个键', async () => {
    const r = await save({})
    if (r.kind !== 'saved') throw new Error(r.kind)
    expect('validFrom' in r.record).toBe(false)
    expect('validTo' in r.record).toBe(false)
  })

  it.each([
    ['数字毫秒', { validTo: local(2026, 11, 5) }, 'validity-format', 'validTo'],
    ['带秒', { validTo: '2026-11-05 18:00:00' }, 'validity-format', 'validTo'],
    ['ISO', { validFrom: '2026-11-01T09:30:00Z' }, 'validity-format', 'validFrom'],
    ['2 月 30 日', { validTo: '2027-02-30 10:00' }, 'validity-nonexistent', 'validTo'],
    ['25 点', { validFrom: '2026-11-01 25:00' }, 'validity-nonexistent', 'validFrom'],
    ['validTo 已过去', { validTo: '2026-10-28 23:00' }, 'validity-past', 'validTo'],
    ['validTo 恰是写入那一分钟', { validTo: '2026-10-29 14:37' }, 'validity-past', 'validTo'],
    ['validTo 只写今天的日期（补上的时分就是现在）', { validTo: '2026-10-29' }, 'validity-past', 'validTo'],
    ['validTo 早于 validFrom', { validFrom: '2026-11-05 10:00', validTo: '2026-11-04 10:00' }, 'validity-reversed', 'validTo'],
    ['validTo 等于 validFrom', { validFrom: '2026-11-05 10:00', validTo: '2026-11-05 10:00' }, 'validity-reversed', 'validTo'],
  ])('拒存不落盘：%s', async (_label, partial, code, key) => {
    const store = new MemoryStore(new InMemoryTable())
    const r = await save(partial, store)
    expect(r).toMatchObject({ kind: 'rejected', code })
    if (r.kind !== 'rejected') throw new Error(r.kind)
    expect(r.reason).toContain(key)
    expect((await store.query({})).length).toBe(0)
  })

  it('拒存原因告诉模型怎么改：格式给出两种写法，过期给出现在时间并提示当天截止要写时分', async () => {
    const format = await save({ validTo: 1793203200000 })
    if (format.kind !== 'rejected') throw new Error(format.kind)
    expect(format.reason).toContain('YYYY-MM-DD HH:mm')
    expect(format.reason).toContain('YYYY-MM-DD')
    const past = await save({ validTo: '2026-10-29' })
    if (past.kind !== 'rejected') throw new Error(past.kind)
    expect(past.reason).toContain('2026-10-29 14:37')
    expect(past.reason).toContain('当天')
  })

  it('update 不传：保留 target 的两个值，与 supersedes 同款回退', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await save({ validFrom: '2026-11-01 09:30', validTo: '2026-11-05 18:00' }, store)
    if (created.kind !== 'saved') throw new Error(created.kind)
    const kept = await runSavePipeline(candidate({ action: 'update', id: created.record.id, content: '例行内容更新' }), deps(store))
    if (kept.kind !== 'updated') throw new Error(kept.kind)
    expect(kept.record.validFrom).toBe(local(2026, 11, 1, 9, 30))
    expect(kept.record.validTo).toBe(local(2026, 11, 5, 18, 0))
  })

  it('update 只传 validTo：target 有 validFrom 就保留，没有才记写入时刻', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const withFrom = await save({ validFrom: '2026-11-01 09:30' }, store)
    const bare = await save({ name: '另一条', content: '完全不同的另一件事', summary: '另一条' }, store)
    if (withFrom.kind !== 'saved' || bare.kind !== 'saved') throw new Error('setup')
    const a = await runSavePipeline(candidate({ action: 'update', id: withFrom.record.id, validTo: '2026-12-01 00:00' }), deps(store))
    const b = await runSavePipeline(candidate({ action: 'update', id: bare.record.id, validTo: '2026-12-01' }), deps(store))
    if (a.kind !== 'updated' || b.kind !== 'updated') throw new Error('update')
    expect(a.record).toMatchObject({ validFrom: local(2026, 11, 1, 9, 30), validTo: local(2026, 12, 1, 0, 0) })
    expect(b.record).toMatchObject({ validFrom: WRITE_MINUTE, validTo: local(2026, 12, 1, 14, 37) })
  })

  it('update 只传 validFrom：保留 target 的 validTo；新起点不早于它时拒、不改盘', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await save({ validTo: '2026-11-05 18:00' }, store)
    if (created.kind !== 'saved') throw new Error(created.kind)
    const moved = await runSavePipeline(candidate({ action: 'update', id: created.record.id, validFrom: '2026-11-01 09:30' }), deps(store))
    if (moved.kind !== 'updated') throw new Error(moved.kind)
    expect(moved.record).toMatchObject({ validFrom: local(2026, 11, 1, 9, 30), validTo: local(2026, 11, 5, 18, 0) })
    const reversed = await runSavePipeline(candidate({ action: 'update', id: created.record.id, validFrom: '2026-11-06 09:00' }), deps(store))
    expect(reversed).toMatchObject({ kind: 'rejected', code: 'validity-reversed' })
    expect((await store.get(created.record.id))?.validFrom).toBe(local(2026, 11, 1, 9, 30))
  })

  it('target 存着倒挂的有效期（validTo 不晚于 validFrom，如手改出来的），update 不传这两个参数：照常更新、原值保留', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await save({}, store)
    if (created.kind !== 'saved') throw new Error(created.kind)
    const reversed = { validFrom: local(2026, 11, 5, 18, 0), validTo: local(2026, 11, 1, 9, 30) }
    await store.put({ ...created.record, ...reversed })
    const r = await runSavePipeline(candidate({ action: 'update', id: created.record.id, content: '例行内容更新' }), deps(store))
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record).toMatchObject(reversed)
  })

  it('update 传了已过去的 validTo 照样拒；target 自己已过期但这次不传有效期，照常更新', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await save({ validTo: '2026-11-05 18:00' }, store)
    if (created.kind !== 'saved') throw new Error(created.kind)
    const past = await runSavePipeline(candidate({ action: 'update', id: created.record.id, validTo: '2026-10-01 00:00' }), deps(store))
    expect(past).toMatchObject({ kind: 'rejected', code: 'validity-past' })
    vi.setSystemTime(local(2026, 11, 6))   // target 过期之后
    const touched = await runSavePipeline(candidate({ action: 'update', id: created.record.id, content: '过期后改正文' }), deps(store))
    if (touched.kind !== 'updated') throw new Error(touched.kind)
    expect(touched.record.validTo).toBe(local(2026, 11, 5, 18, 0))
  })
})

// 模型改写、替代的兜底：改前先拍快照、记一条可撤销的已结清条目；手改过的记忆不悄悄覆盖
describe('runSavePipeline：模型改写的兜底', () => {
  function guarded(store = new MemoryStore(new InMemoryTable())) {
    const snapshots = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const decisions = new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>())
    return { store, snapshots, decisions, deps: { ...deps(store), snapshots, decisions, callId: 'call-7' } }
  }
  async function seed(store: MemoryStore, partial: object = {}) {
    const r = await runSavePipeline(candidate({ scope: 'workspace', content: '旧内容', force: true, ...partial }), deps(store))
    if (r.kind !== 'saved') throw new Error(r.kind)
    return r.record
  }

  it('改写：账本记一条已结清的 rewrite，指向改前快照，指纹是写下的内容，带会话与调用', async () => {
    const e = guarded()
    const target = await seed(e.store)
    const r = await runSavePipeline(candidate({ action: 'update', id: target.id, content: '新内容' }), e.deps)
    if (r.kind !== 'updated') throw new Error(r.kind)
    const [snap] = await e.snapshots.list()
    const [entry] = await e.decisions.listSettled()
    expect(entry).toMatchObject({
      kind: 'rewrite', memoryIds: [target.id], workspaces: ['/proj'],
      origin: { sessionId: 's1', callId: 'call-7' },
      settled: { verdict: 'rewritten', snapshotId: snap!.id },
    })
    expect(entry!.fingerprint).toBe(editFingerprint((await e.store.get(target.id))!))
    // 待处理里看不到它
    expect(await e.decisions.list()).toEqual([])
  })

  it('替代：标 superseded 前拍快照（旧记忆原状，可恢复），账本记一条 supersede，指出替代它的那条', async () => {
    const e = guarded()
    const old = await seed(e.store, { name: '旧说法' })
    const r = await runSavePipeline(candidate({ scope: 'workspace', name: '新说法', content: '完全不同的新说法', force: true, supersedes: [old.id] }), e.deps)
    if (r.kind !== 'saved') throw new Error(r.kind)
    expect(Object.keys(r)).not.toContain('warnings')
    expect((await e.store.get(old.id))!.status).toBe('superseded')
    const [snap] = await e.snapshots.list()
    expect(snap).toMatchObject({ operation: 'pre-update', memoryIds: [old.id] })
    expect(snap!.data[0]).toMatchObject({ id: old.id, status: 'active', content: '旧内容' })
    const [entry] = await e.decisions.listSettled()
    expect(entry).toMatchObject({
      kind: 'supersede', memoryIds: [old.id], summary: '旧说法',
      origin: { sessionId: 's1', callId: 'call-7', by: r.record.id },
      settled: { verdict: 'superseded', snapshotId: snap!.id },
    })
    expect(entry!.fingerprint).toBe(editFingerprint((await e.store.get(old.id))!))
  })

  it('改写同时替代：一份快照装两条，账本各记一条', async () => {
    const e = guarded()
    const target = await seed(e.store, { name: '甲' })
    const old = await seed(e.store, { name: '乙', content: '另一件事' })
    const r = await runSavePipeline(candidate({ action: 'update', id: target.id, content: '合并后的内容', supersedes: [old.id] }), e.deps)
    if (r.kind !== 'updated') throw new Error(r.kind)
    const snaps = await e.snapshots.list()
    expect(snaps).toHaveLength(1)
    expect(new Set(snaps[0]!.memoryIds)).toEqual(new Set([target.id, old.id]))
    expect((await e.decisions.listSettled()).map(d => d.kind).sort()).toEqual(['rewrite', 'supersede'])
  })

  it('跨作用域、不存在、已是 superseded 的替代目标不拍快照、不记账（结果照旧）', async () => {
    const e = guarded()
    const already = await seed(e.store, { name: '早被替代' })
    await e.store.put({ ...already, status: 'superseded' })
    await e.store.put({ ...already, id: 'mem_global', scope: 'global', workspacePath: undefined } as never)
    const r = await runSavePipeline(candidate({ scope: 'workspace', name: '新事实', content: '完全不同的新说法', force: true, supersedes: ['mem_global', 'mem_ghost', already.id] }), e.deps)
    if (r.kind !== 'saved') throw new Error(r.kind)
    expect(r.warnings?.map(w => w.code)).toEqual(['cross-bucket-supersede'])
    expect(await e.snapshots.list()).toEqual([])
    expect(await e.decisions.listSettled()).toEqual([])
  })

  it('update 目标手改过：不写入、不拍快照，rejected(hand-edited)，原因带当前内容与 force 指引', async () => {
    const e = guarded()
    const target = await seed(e.store)
    await e.store.put({ ...target, content: '用户手改后的内容', handEdited: true })
    const r = await runSavePipeline(candidate({ action: 'update', id: target.id, content: '模型想写的' }), e.deps)
    if (r.kind !== 'rejected') throw new Error(r.kind)
    expect(r.code).toBe('hand-edited')
    expect(r.reason).toContain('用户手改后的内容')
    expect(r.reason).toContain(target.id)
    expect(r.reason).toContain('force: true')
    expect((await e.store.get(target.id))!.content).toBe('用户手改后的内容')
    expect(await e.snapshots.list()).toEqual([])
    expect(await e.decisions.listSettled()).toEqual([])
  })

  it('同作用域替代目标手改过：新记忆不落盘、旧记忆保持 active', async () => {
    const e = guarded()
    const old = await seed(e.store)
    await e.store.put({ ...old, content: '用户手改后的旧记忆', handEdited: true })
    const r = await runSavePipeline(candidate({ scope: 'workspace', name: '新说法', content: '完全不同的新说法', force: false, supersedes: [old.id] }), e.deps)
    expect(r).toMatchObject({ kind: 'rejected', code: 'hand-edited' })
    if (r.kind === 'rejected') expect(r.reason).toContain('用户手改后的旧记忆')
    expect((await e.store.get(old.id))!.status).toBe('active')
    expect(await e.store.query({})).toHaveLength(1)
  })

  it('替代手改过的记忆、新内容又和它重叠：先拦手改，不回疑似重复（那条回复叫模型带 force 重发，会把手改保护一并跳过）', async () => {
    const e = guarded()
    const old = await seed(e.store, { content: '测试统一用 Postgres 16 跑集成测试' })
    await e.store.put({ ...old, handEdited: true })
    const r = await runSavePipeline(candidate({ scope: 'workspace', content: '测试统一用 Postgres 17 跑集成测试', supersedes: [old.id] }), e.deps)
    expect(r).toMatchObject({ kind: 'rejected', code: 'hand-edited' })
    expect((await e.store.get(old.id))!.status).toBe('active')
  })

  it('supersedes 里同一个 id 写两遍：只记一条撤销', async () => {
    const e = guarded()
    const old = await seed(e.store, { name: '旧说法' })
    const r = await runSavePipeline(candidate({ scope: 'workspace', name: '新说法', content: '完全不同的新说法', force: true, supersedes: [old.id, old.id] }), e.deps)
    if (r.kind !== 'saved') throw new Error(r.kind)
    expect(await e.decisions.listSettled()).toHaveLength(1)
  })

  it('手改保护先于疑似密钥拦截：问过用户带 force 重发，疑似密钥照旧留警告', async () => {
    const e = guarded()
    const target = await seed(e.store)
    await e.store.put({ ...target, handEdited: true })
    const r = await runSavePipeline(candidate({ action: 'update', id: target.id, content: '内部约定 api_key: TESTONLY0000000000000' }), e.deps)
    expect(r).toMatchObject({ kind: 'rejected', code: 'hand-edited' })
  })

  it('原因里的当前内容遮掉密钥（结果会进模型上下文）', async () => {
    const e = guarded()
    const target = await seed(e.store)
    await e.store.put({ ...target, content: `凭证 ${FAKE_SECRET.github}`, handEdited: true })
    const r = await runSavePipeline(candidate({ action: 'update', id: target.id, content: '模型想写的' }), e.deps)
    if (r.kind !== 'rejected') throw new Error(r.kind)
    expect(r.reason).not.toContain(FAKE_SECRET.github)
  })

  it('force 改写手改过的记忆：照常写入、拍快照、记账，可撤销', async () => {
    const e = guarded()
    const target = await seed(e.store)
    await e.store.put({ ...target, content: '用户手改后的内容', handEdited: true })
    const r = await runSavePipeline(candidate({ action: 'update', id: target.id, content: '用户同意后的新内容', force: true }), e.deps)
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record.content).toBe('用户同意后的新内容')
    const [snap] = await e.snapshots.list()
    expect(snap!.data[0]).toMatchObject({ content: '用户手改后的内容', handEdited: true })
    expect((await e.decisions.listSettled())[0]).toMatchObject({ kind: 'rewrite', settled: { snapshotId: snap!.id } })
  })

  it('force 替代手改过的旧记忆：照常标 superseded、拍快照、记账', async () => {
    const e = guarded()
    const old = await seed(e.store)
    await e.store.put({ ...old, handEdited: true })
    const r = await runSavePipeline(candidate({ scope: 'workspace', name: '新说法', content: '完全不同的新说法', force: true, supersedes: [old.id] }), e.deps)
    expect(r.kind).toBe('saved')
    expect((await e.store.get(old.id))!.status).toBe('superseded')
    expect((await e.decisions.listSettled())[0]).toMatchObject({ kind: 'supersede', memoryIds: [old.id] })
  })

  it('没手改过的记忆：结果与不带账本时逐字一致', async () => {
    const plain = new MemoryStore(new InMemoryTable())
    const e = guarded()
    for (const store of [plain, e.store]) await store.put({ ...(await seed(store)), id: 'mem_same', name: '同一条' })
    const update = candidate({ action: 'update', id: 'mem_same', content: '新内容', scope: 'global' })
    const a = await runSavePipeline(update, deps(plain))
    const b = await runSavePipeline(update, e.deps)
    const strip = (x: typeof a) => x.kind === 'updated' ? { ...x, record: { ...x.record, createdAt: 0, updatedAt: 0, lastConfirmedAt: 0 } } : x
    expect(strip(b)).toEqual(strip(a))
  })
})

/**
 * 子 agent 写入约束（spec 第 2–7、9 条）：委派上下文由宿主填，管线最前一个判断块，拒绝码统一 subagent-restricted。
 * 候选默认取子 agent 能存的形状（knowledge、workspace、观察所得），各用例只改要犯的那一条。
 */
describe('runSavePipeline：子 agent 写入约束', () => {
  const CHILD = { id: 'sess-child', lastSeq: 9, turnStartSeq: 4 }
  const delegation = { depth: 1, parentSessionId: 'sess-main', rootSessionId: 'sess-main', mode: 'one-shot' as const }
  const childDeps = (store = new MemoryStore(new InMemoryTable()), extra: object = {}) =>
    ({ store, registry, workspacePath: '/proj' as string | undefined, session: CHILD, delegation, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), ...extra })
  const childCandidate = (partial: object = {}) => candidate({
    type: 'knowledge', scope: 'workspace', sourceMode: 'environment-observed',
    name: '子观察', content: 'main 上 pnpm test 会挂', summary: 'main 测试会挂', ...partial,
  })
  const restricted = async (result: Promise<unknown>) => {
    const r = await result as { kind: string; code?: string; reason?: string }
    expect(r).toMatchObject({ kind: 'rejected', code: 'subagent-restricted' })
    return r.reason!
  }

  it('传 global：落当前项目、不打 globalCandidate，结果带警告', async () => {
    const r = await runSavePipeline(childCandidate({ scope: 'global' }), childDeps())
    if (r.kind !== 'saved') throw new Error(r.kind)
    expect(r.record).toMatchObject({ scope: 'workspace', workspacePath: '/proj' })
    expect(r.record.globalCandidate).toBeUndefined()
    expect(r.warnings).toEqual([{ code: 'subagent-scope-local', text: '子 agent 写的记忆只能放本项目，要提全局由主会话决定' }])
  })

  it('sourceMode 只收观察、推断：其余三种回 subagent-restricted，原因写明按观察或推断重发', async () => {
    const store = new MemoryStore(new InMemoryTable())
    for (const sourceMode of ['user-explicit', 'user-behavior', 'agent-action-confirmed']) {
      const reason = await restricted(runSavePipeline(childCandidate({ sourceMode }), childDeps(store)))
      expect(reason).toBe(`sourceMode=${sourceMode} 子 agent 用不了：子 agent 收到的指令来自委派方，不算用户明说；按观察（environment-observed）或推断（agent-inferred）重发。`)
    }
    expect(await store.query({ scope: { kind: 'workspace', workspacePath: '/proj' } })).toEqual([])
    for (const sourceMode of ['environment-observed', 'agent-inferred']) {
      expect((await runSavePipeline(childCandidate({ sourceMode }), childDeps())).kind).toBe('saved')
    }
  })

  it('类型只收当前场景里的 knowledge、project：其他内置、预设、自建类型和不在场景里的 knowledge 回 subagent-restricted', async () => {
    const custom = buildTypeRegistry({
      template: 'scene-1',
      customTypes: { regulation: { label: '合规', description: '法规', whenToSave: '出现法规时', recall: 'search', decayDays: null, governancePriority: 'low' } },
      scenes: { 'scene-1': { label: '写作', types: ['project', 'decision', 'regulation'] } },
    })
    const cases: Array<[string, typeof registry, string]> = [
      ['preference', registry, '当前场景里能写：knowledge、project'],
      ['procedure', registry, '当前场景里能写：knowledge、project'],   // 编码场景里的预设类型
      ['decision', custom, '当前场景里能写：project'],
      ['regulation', custom, '当前场景里能写：project'],               // 自建类型
      ['knowledge', custom, '当前场景里能写：project'],                // 内置但不在当前场景
    ]
    for (const [type, reg, allowed] of cases) {
      const reason = await restricted(runSavePipeline(childCandidate({ type }), { ...childDeps(), registry: reg }))
      expect(reason, type).toBe(`子 agent 只能写 knowledge、project 两类，且要在当前场景里（${allowed}）；"${type}" 不行，这件事带回主会话。`)
    }
    const none = buildTypeRegistry({ template: 'scene-1', customTypes: {}, scenes: { 'scene-1': { label: '写作', types: ['preference'] } } })
    expect(await restricted(runSavePipeline(childCandidate(), { ...childDeps(), registry: none })))
      .toBe('子 agent 只能写 knowledge、project 两类，且要在当前场景里（当前场景里两类都没有）；"knowledge" 不行，这件事带回主会话。')
    expect((await runSavePipeline(childCandidate({ type: 'project' }), { ...childDeps(), registry: custom })).kind).toBe('saved')
  })

  it('非空 supersedes 或 force: true 回 subagent-restricted；空 supersedes、force: false 照常', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const old = await runSavePipeline(candidate({ scope: 'workspace', type: 'knowledge' }), deps(store))   // 主会话的一条，给 supersedes 一个真实目标
    if (old.kind !== 'saved') throw new Error(old.kind)
    expect(await restricted(runSavePipeline(childCandidate({ supersedes: [old.record.id] }), childDeps(store))))
      .toBe('子 agent 不能用 supersedes 替代旧记忆；去掉 supersedes 重发，要替代哪条带回主会话。')
    expect(await restricted(runSavePipeline(childCandidate({ force: true }), childDeps(store))))
      .toBe('子 agent 不能带 force：去重、手改保护、疑似密钥三道检查子 agent 都过不去。撞重复就另存或放弃，疑似密钥一律不存；去掉 force 重发。')
    expect((await store.get(old.record.id))!.status).toBe('active')
    expect((await runSavePipeline(childCandidate({ supersedes: [], force: false }), childDeps(store))).kind).toBe('saved')
  })

  it('同时犯多条时按 sourceMode → 类型 → supersedes → force 的顺序报最前一条', async () => {
    const all = { sourceMode: 'user-explicit', type: 'preference', supersedes: ['mem_x'], force: true }
    const steps: Array<[object, string]> = [
      [all, 'sourceMode='],
      [{ ...all, sourceMode: 'agent-inferred' }, '只能写 knowledge、project'],
      [{ ...all, sourceMode: 'agent-inferred', type: 'project' }, 'supersedes'],
      [{ ...all, sourceMode: 'agent-inferred', type: 'project', supersedes: undefined }, 'force'],
    ]
    for (const [partial, lead] of steps) {
      expect(await restricted(runSavePipeline(childCandidate({ scope: 'global', ...partial }), childDeps()))).toContain(lead)
    }
  })

  it('主会话不经过这些约束：同样的参数照旧存下', async () => {
    const r = await runSavePipeline(candidate({ type: 'preference', sourceMode: 'user-explicit', force: true }), deps())
    expect(r).toMatchObject({ kind: 'saved', record: { scope: 'workspace', globalCandidate: true } })
    if (r.kind === 'saved') expect(r.record.delegation).toBeUndefined()
  })

  /** 当前项目里的一条记录；by 给出创建者：主会话（无 delegation）、本会话或别的子会话、已升档。 */
  const owned = (id: string, by: 'main' | 'self' | 'other' | 'self-reviewed') => record({
    id, type: 'knowledge', scope: 'workspace', workspacePath: '/proj', name: id, content: `「${id}」的旧内容`, summary: `${id} 旧摘要`,
    source: { sessionId: by === 'main' ? 'sess-main' : 'sess-x', eventRange: [0, 1], sourceMode: 'environment-observed' },
    ...(by === 'main' ? {} : {
      delegation: {
        sessionId: by === 'other' ? 'sess-other' : CHILD.id, depth: 1, parentSessionId: 'sess-main', rootSessionId: 'sess-main',
        ...(by === 'self-reviewed' ? { reviewed: { by: 'main' as const, at: 5 } } : {}),
      },
    }),
  })

  it('update 只改本会话创建、还没升档的：创建者字段不变、reviewed 为空、证据锚换成这次的', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(owned('mem_self', 'self'))
    const r = await runSavePipeline(childCandidate({ action: 'update', id: 'mem_self', sourceMode: 'agent-inferred', content: '改过的观察' }), childDeps(store))
    if (r.kind !== 'updated') throw new Error(r.kind)
    expect(r.record.content).toBe('改过的观察')
    expect(r.record.delegation).toEqual({ sessionId: CHILD.id, depth: 1, parentSessionId: 'sess-main', rootSessionId: 'sess-main' })
    expect(r.record.source).toEqual({ sessionId: CHILD.id, eventRange: [4, 9], sourceMode: 'agent-inferred' })
    expect((await store.get('mem_self'))!.delegation).toEqual(r.record.delegation)
  })

  it('update 主会话的、别的子会话的、已升档的回 subagent-restricted，原因说明是哪种，记录不动', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const cases: Array<[string, 'main' | 'other' | 'self-reviewed', string]> = [
      ['mem_main', 'main', '是主会话写的或用户手建的'],
      ['mem_other', 'other', '是别的子会话存的'],
      ['mem_reviewed', 'self-reviewed', '已经被接受了'],
    ]
    for (const [id, by] of cases) await store.put(owned(id, by))
    for (const [id, , why] of cases) {
      const reason = await restricted(runSavePipeline(childCandidate({ action: 'update', id, content: '子 agent 想改成这样' }), childDeps(store)))
      expect(reason, id).toBe(`子 agent 只能改本会话存下、还没被接受的记忆；${id} ${why}。要改的内容带回主会话。`)
      expect((await store.get(id))!.content, id).toBe(`「${id}」的旧内容`)
    }
  })

  it('update 目标不存在或已删除回 subagent-restricted，不落到 target-missing', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(owned('mem_self', 'self'))
    await store.softDelete((await store.get('mem_self'))!)
    for (const id of ['mem_none', 'mem_self']) {
      const reason = await restricted(runSavePipeline(childCandidate({ action: 'update', id, content: '子 agent 想改成这样' }), childDeps(store)))
      expect(reason, id).toBe(`要改的记忆 ${id} 不存在或已删除，带回主会话。`)
    }
    expect((await store.get('mem_self'))!.content).toBe('「mem_self」的旧内容')
  })

  it('update 已提升为全局的待确认记录回 subagent-restricted，全局记录不动', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put({ ...owned('mem_g', 'self'), scope: 'global', workspacePath: undefined })
    const reason = await restricted(runSavePipeline(childCandidate({ action: 'update', id: 'mem_g', content: '子 agent 想改成这样' }), childDeps(store)))
    expect(reason).toBe('子 agent 只能改本会话存下、还没被接受的记忆；mem_g 已经提升为全局。要改的内容带回主会话。')
    expect((await store.get('mem_g'))!.content).toBe('「mem_g」的旧内容')
  })

  it('检查时读到已删除、之后被恢复成主会话的记录：照样拒，子级内容不会变成主档', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const main = owned('mem_main', 'main')
    await store.put(main)
    vi.spyOn(store, 'get').mockResolvedValueOnce({ ...main, status: 'deleted' })
    await restricted(runSavePipeline(childCandidate({ action: 'update', id: 'mem_main', content: '子 agent 想改成这样' }), childDeps(store)))
    expect((await store.get('mem_main'))!.content).toBe('「mem_main」的旧内容')
  })

  it('检查之后、写入之前记录被接受、提升或删除：锁内重判后不写，回 subagent-restricted', async () => {
    type Rec = ReturnType<typeof owned>
    const changes: Array<[string, (r: Rec) => Rec]> = [
      ['accepted', r => ({ ...r, delegation: { ...r.delegation!, reviewed: { by: 'main', at: 8 } } })],
      ['promoted', r => ({ ...r, scope: 'global', workspacePath: undefined })],
      ['deleted', r => ({ ...r, status: 'deleted' })],
    ]
    for (const [label, change] of changes) {
      const store = new MemoryStore(new InMemoryTable())
      await store.put(owned('mem_self', 'self'))
      const realPut = store.put.bind(store)
      vi.spyOn(store, 'put').mockImplementationOnce(async (r, hint, skipIf) => {
        const current = (await store.get('mem_self'))!
        await realPut(change(current), { workspacePath: current.workspacePath })
        return realPut(r, hint, skipIf)
      })
      const reason = await restricted(runSavePipeline(childCandidate({ action: 'update', id: 'mem_self', content: '子 agent 想改成这样' }), childDeps(store)))
      expect(reason, label).toBe('记忆 mem_self 在读取之后被改过（可能已被接受、删除或提升为全局），这次没写；要改的内容带回主会话。')
      expect((await store.get('mem_self'))!.content, label).toBe('「mem_self」的旧内容')
    }
  })

  it('update 用户手改过的待确认记录：原因不提 force，说明子 agent 改不了', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put({ ...owned('mem_self', 'self'), handEdited: true })
    const r = await runSavePipeline(childCandidate({ action: 'update', id: 'mem_self', content: '子 agent 想改成这样' }), childDeps(store))
    if (r.kind !== 'rejected') throw new Error(r.kind)
    expect(r.code).toBe('hand-edited')
    expect(r.reason).toContain('这条记忆用户手改过，子 agent 改不了，带回主会话')
    expect(r.reason).not.toContain('force')
  })

  it('疑似密钥：原因不提 force，写明疑似密钥一律不存', async () => {
    const r = await runSavePipeline(childCandidate({ tags: ['api_key: TESTONLY0000000000000'] }), childDeps())
    if (r.kind !== 'rejected') throw new Error(r.kind)
    expect(r.code).toBe('secret-suspected')
    expect(r.reason).toContain('疑似密钥一律不存')
    expect(r.reason).not.toContain('force')
  })

  it('归属检查排在 supersedes / force 之后：改别人的记录又带 force，报 force', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(owned('mem_main', 'main'))
    expect(await restricted(runSavePipeline(childCandidate({ action: 'update', id: 'mem_main', force: true }), childDeps(store)))).toContain('force')
  })

  it('去重只比主档：撞主会话写的、已升档的回 duplicate-suspected 并列出，提示向委派方说明分歧', async () => {
    for (const by of ['main', 'self-reviewed'] as const) {
      const store = new MemoryStore(new InMemoryTable())
      await store.put({ ...owned('mem_kept', by), content: '`pnpm test` 在 main 上是绿的' })
      const r = await runSavePipeline(childCandidate({ content: '`pnpm test` 在 main 上会挂' }), childDeps(store))
      expect(r, by).toEqual({ kind: 'duplicate-suspected', existing: [{ id: 'mem_kept', summary: 'mem_kept 旧摘要' }], isFromSubagent: true })
      const text = renderSaveResult(r)
      expect(text).toContain('- mem_kept：mem_kept 旧摘要')
      expect(text).toContain('在回复里向委派方说明分歧')
      expect(text).not.toContain('force')
    }
  })

  it('去重不比待确认：撞别的子会话（或本会话）存的待确认记录照常存，两条并存', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put({ ...owned('mem_peer', 'other'), content: '`pnpm test` 在 main 上是绿的' })
    const r = await runSavePipeline(childCandidate({ content: '`pnpm test` 在 main 上会挂' }), childDeps(store))
    if (r.kind !== 'saved') throw new Error(r.kind)
    const active = await store.query({ scope: { kind: 'workspace', workspacePath: '/proj' } })
    expect(active.map(x => x.id).sort()).toEqual([r.record.id, 'mem_peer'].sort())
  })

  /** 子会话连续新建 n 条（待确认之间不去重，同一内容也各自落一条），返回最后一次的结果。 */
  const createMany = async (n: number, d: ReturnType<typeof childDeps>) => {
    let last: Awaited<ReturnType<typeof runSavePipeline>> | undefined
    for (let i = 0; i < n; i++) last = await runSavePipeline(childCandidate({ name: `观察${i}` }), d)
    return last!
  }

  it('每会话新建配额默认 10：第 11 条回 subagent-restricted，原因含已存条数', async () => {
    const d = childDeps()
    expect((await createMany(10, d)).kind).toBe('saved')
    expect(await restricted(runSavePipeline(childCandidate({ name: '第 11 条' }), d)))
      .toBe('本会话已存 10 条，到了每个子会话 10 条的上限；其余带回主会话。')
  })

  it('配额按配置值；删一条释放额度；已取代、已过期的仍占额度', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const d = childDeps(store, { maxSubagentSaves: 3 })
    expect((await createMany(3, d)).kind).toBe('saved')
    expect(await restricted(runSavePipeline(childCandidate({ name: '第 4 条' }), d))).toContain('本会话已存 3 条')

    const [first, second, third] = await store.query({ scope: { kind: 'workspace', workspacePath: '/proj' } })
    await store.softDelete(first!)
    expect((await runSavePipeline(childCandidate({ name: '删后再存' }), d)).kind).toBe('saved')

    await store.update(second!, r => ({ ...r, status: 'superseded' }))
    await store.put({ ...third!, validTo: 1 })   // 早已过期，仍是 active
    expect(await restricted(runSavePipeline(childCandidate({ name: '又一条' }), d))).toContain('本会话已存 3 条')
  })

  it('配额只拦 create：到了上限 update 自己的待确认记录照常', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const d = childDeps(store, { maxSubagentSaves: 1 })
    const saved = await createMany(1, d)
    if (saved.kind !== 'saved') throw new Error(saved.kind)
    expect((await runSavePipeline(childCandidate({ action: 'update', id: saved.record.id, content: '改一下' }), d)).kind).toBe('updated')
  })

  it('并行子级各算各的：别的子会话、主会话的记录不占本会话额度', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(owned('mem_other', 'other'))
    await store.put(owned('mem_main', 'main'))
    const d = childDeps(store, { maxSubagentSaves: 1 })
    expect((await runSavePipeline(childCandidate({ content: '`vitest` 跑得动' }), d)).kind).toBe('saved')
    const sibling = { ...d, session: { id: 'sess-other-2', lastSeq: 3 } }
    expect((await runSavePipeline(childCandidate({ content: '`tsc` 跑得动' }), sibling)).kind).toBe('saved')
  })

  it('主会话的去重不变：撞待确认记录照旧 duplicate-suspected，提示 force 重发', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put({ ...owned('mem_peer', 'other'), content: '`pnpm test` 在 main 上是绿的' })
    const r = await runSavePipeline(candidate({ type: 'knowledge', scope: 'workspace', content: '`pnpm test` 在 main 上会挂' }), deps(store))
    expect(r).toEqual({ kind: 'duplicate-suspected', existing: [{ id: 'mem_peer', summary: 'mem_peer 旧摘要' }] })
    expect(renderSaveResult(r)).toContain('force=true')
  })

  describe('主会话处理待确认记录', () => {
    const NOW = 7_000_000
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
    afterEach(() => { vi.useRealTimers() })
    const CREATOR = { sessionId: CHILD.id, depth: 1, parentSessionId: 'sess-main', rootSessionId: 'sess-main' }
    const mainUpdate = (id: string) => candidate({ action: 'update', id, type: 'knowledge', scope: 'workspace', sourceMode: 'agent-inferred', content: '主会话改写后的内容' })

    it('update 待确认记录即接受：reviewed 补 main 与当前时间，创建者四个字段原样，证据锚换成主会话这次的', async () => {
      const store = new MemoryStore(new InMemoryTable())
      await store.put(owned('mem_p', 'self'))
      const r = await runSavePipeline(mainUpdate('mem_p'), deps(store))
      if (r.kind !== 'updated') throw new Error(r.kind)
      expect(r.record.delegation).toEqual({ ...CREATOR, reviewed: { by: 'main', at: NOW } })
      expect(r.record.source).toEqual({ sessionId: 's1', eventRange: [0, 42], sourceMode: 'agent-inferred' })
      expect((await store.get('mem_p'))!.delegation).toEqual(r.record.delegation)
    })

    it('目标已接受的 reviewed 不动：用户改过的不被 main 覆写，主会话早先接受的保留原时刻', async () => {
      const cases: Array<{ by: 'user' | 'main'; at: number }> = [{ by: 'user', at: 3 }, { by: 'main', at: 5 }]
      for (const reviewed of cases) {
        const store = new MemoryStore(new InMemoryTable())
        await store.put({ ...owned('mem_p', 'self'), delegation: { ...CREATOR, reviewed } })
        const r = await runSavePipeline(mainUpdate('mem_p'), deps(store))
        if (r.kind !== 'updated') throw new Error(r.kind)
        expect(r.record.delegation, reviewed.by).toEqual({ ...CREATOR, reviewed })
      }
    })

    it('主会话自己的记录 update 后仍不带 delegation', async () => {
      const store = new MemoryStore(new InMemoryTable())
      await store.put(owned('mem_main', 'main'))
      const r = await runSavePipeline(mainUpdate('mem_main'), deps(store))
      if (r.kind !== 'updated') throw new Error(r.kind)
      expect(r.record.delegation).toBeUndefined()
    })

    it('supersedes 待确认记录照旧：目标置 superseded，创建者信息不动、仍未接受', async () => {
      const store = new MemoryStore(new InMemoryTable())
      const before = owned('mem_p', 'self')
      await store.put(before)
      const r = await runSavePipeline(candidate({ type: 'knowledge', scope: 'workspace', name: '新说法', content: '完全不同的新说法', supersedes: ['mem_p'] }), deps(store))
      expect(r.kind).toBe('saved')
      const old = (await store.get('mem_p'))!
      expect(old.status).toBe('superseded')
      expect(old.delegation).toEqual(before.delegation)
    })
  })
})
