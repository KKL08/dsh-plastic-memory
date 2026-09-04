import { describe, expect, it } from 'vitest'
import { runSavePipeline } from '../src/pipeline.ts'
import { extractEntities } from '../src/text.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { candidate } from './helpers/record.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const session = { id: 's1', lastSeq: 42 }

function deps(store = new MemoryStore(new InMemoryTable())) {
  return { store, registry, workspacePath: '/proj' as string | undefined, session }
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

  // 真锚（设计 evidence-anchor §3）：eventRange = [当轮 turn/start, save 时刻]，绑定层机械填充
  it('session 带 turnStartSeq 时 eventRange 用真实当轮区间', async () => {
    const result = await runSavePipeline(candidate(), { ...deps(), session: { id: 's1', lastSeq: 42, turnStartSeq: 37 } })
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.source.eventRange).toEqual([37, 42])
  })

  it('turnStartSeq 越过 lastSeq 时夹到 lastSeq（防坏输入产出倒置区间）', async () => {
    const result = await runSavePipeline(candidate(), { ...deps(), session: { id: 's1', lastSeq: 5, turnStartSeq: 9 } })
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.source.eventRange).toEqual([5, 5])
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
  })

  it('模型填 global（有 workspace）降级 workspace + globalCandidate（无 global 直写通道）', async () => {
    const result = await runSavePipeline(candidate({ scope: 'global' }), deps())
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.record.scope).toBe('workspace')
    expect(result.record.workspacePath).toBe('/proj')
    expect(result.record.globalCandidate).toBe(true)
  })

  it('填 global 且无 workspacePath 时同样拒存（global 直写必须过提升闸，无桶可降级）', async () => {
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

  it('update 保留 createdAt、刷新 lastConfirmedAt', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const first = await runSavePipeline(candidate(), deps(store))
    if (first.kind !== 'saved') throw new Error(first.kind)
    await new Promise(r => setTimeout(r, 5))
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: first.record.id, content: '新内容' }), deps(store))
    if (updated.kind !== 'updated') throw new Error(updated.kind)
    expect(updated.record.createdAt).toBe(first.record.createdAt)
    expect(updated.record.lastConfirmedAt).toBeGreaterThan(first.record.lastConfirmedAt)
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
    await store.softDelete(created.record.id)
    const result = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '新内容' }), deps(store))
    expect(result).toMatchObject({ kind: 'rejected', code: 'target-missing' })
  })

  it('supersedes 把旧记忆置为 superseded', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const old = await runSavePipeline(candidate(), deps(store))
    if (old.kind !== 'saved') throw new Error(old.kind)
    await runSavePipeline(candidate({ content: '完全不同的新说法', force: true, supersedes: [old.record.id] }), deps(store))
    expect(store.get(old.record.id)!.status).toBe('superseded')
  })

  // B1a：supersedes 目标必须与本次写入记录同桶
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
    expect(store.get('mem_global')!.status).toBe('active')
    expect(saved.warnings?.map(w => w.code)).toContain('cross-bucket-supersede')
  })

  it('B1a: 同 workspace 目标仍正常置 superseded（回归）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const old = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (old.kind !== 'saved') throw new Error(old.kind)
    const saved = await runSavePipeline(
      candidate({ scope: 'workspace', name: '新事实', content: '完全不同的新说法', force: true, supersedes: [old.record.id] }),
      deps(store))
    if (saved.kind !== 'saved') throw new Error(saved.kind)
    expect(store.get(old.record.id)!.status).toBe('superseded')
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
    const list = snaps.list()
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

  it('B1c: update workspace 记录不拍快照（避免高频写入膨胀快照表）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const snaps = new SnapshotStore(new InMemoryKvTable<MemorySnapshot>())
    const created = await runSavePipeline(candidate({ scope: 'workspace' }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '本项目内更新' }),
      { ...deps(store), snapshots: snaps })
    expect(updated.kind).toBe('updated')
    expect(snaps.list()).toHaveLength(0)
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

  it('含疑似密钥（无厂商特征）时 saved + warnings、照常落盘', async () => {
    const result = await runSavePipeline(
      candidate({ content: '内部约定 api_key: TESTONLY0000000000000' }),
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
      candidate({ content: '我的 API 密钥是 sk-proj-TESTONLY0000000000000000' }),
      deps(store),
    )
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') {
      expect(result.code).toBe('secret-critical')
      expect(result.reason.length).toBeGreaterThan(0)
    }
    expect(store.query({ scope: { kind: 'global' } })).toHaveLength(0) // 未落盘
  })

  it('无密钥 content 时 result 不存在 warnings 键（undefined 键纪律）', async () => {
    const result = await runSavePipeline(candidate(), deps())
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(Object.keys(result)).not.toContain('warnings')
  })

  it('update 含密钥时返回 warnings', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate(), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    const updated = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '密码:TESTONLYpassw0rd' }),
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

  it('update 不传 validFrom/validTo 时保留 target 值（与 supersedes 同款回退），传新值则覆盖', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const created = await runSavePipeline(candidate({ scope: 'workspace', validFrom: 100, validTo: 900 }), deps(store))
    if (created.kind !== 'saved') throw new Error(created.kind)
    const kept = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, content: '例行内容更新' }), deps(store))
    if (kept.kind !== 'updated') throw new Error(kept.kind)
    expect(kept.record.validFrom).toBe(100)
    expect(kept.record.validTo).toBe(900)
    const overridden = await runSavePipeline(
      candidate({ action: 'update', id: created.record.id, validTo: 1800 }), deps(store))
    if (overridden.kind !== 'updated') throw new Error(overridden.kind)
    expect(overridden.record.validTo).toBe(1800)
  })

  // 密钥检测覆盖全部外泄面：summary 进注入索引、name 进文件名、tags 进索引行
  it('高危密钥只出现在 summary 时同样拦截不落盘', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const result = await runSavePipeline(
      candidate({ scope: 'workspace', content: '正文干净', summary: '密钥 sk-TESTONLYaaaaaaaaaaaaaaaa 备份' }),
      deps(store),
    )
    expect(result).toMatchObject({ kind: 'rejected', code: 'secret-critical' })
    expect(store.query({}).length).toBe(0)
  })

  it('疑似密钥出现在 tags 时照常落盘但给警告', async () => {
    const result = await runSavePipeline(
      candidate({ scope: 'workspace', content: '正文干净', tags: ['api_key: TESTONLY0000000000000'] }),
      deps(),
    )
    if (result.kind !== 'saved') throw new Error(result.kind)
    expect(result.warnings?.map(w => w.code)).toContain('secret-suspected')
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
