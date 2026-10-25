import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, STATE_DIR, workspaceDirName } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import { resolveHealthThresholds } from '../src/governance/health-presets.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { executeForget } from '../src/tools/forget.ts'
import { executeHealth } from '../src/tools/health.ts'
import { RETENTION_MS } from '../src/retention.ts'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, GUI_WORKSPACE_MAP_FILE, PENDING_ITEM_KINDS, deletedViewSchema, healthViewSchema,
  libraryViewSchema, pendingViewSchema, sessionViewFile, sessionViewSchema, workspaceMapViewSchema, type GlobalViewName,
} from '../src/gui/contract.ts'
import { buildSessionView } from '../src/gui/views.ts'
import { ViewWriter, collectGlobalViews } from '../src/gui/view-writer.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 视图生成：真实临时目录（FileTable + .state 侧表）+ 账本 → 五种视图 JSON。只断言视图内容，不 mock 自己的模块。

const WS = '/home/dev/proj-a'
const T0 = 1_700_000_000_000
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-gui-views-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function harness() {
  let clock = T0
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => clock }), undefined, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const sourceDeps = { store, decisions, cache: sidecar.scanCache, registry, memoryRoot: root, now: () => clock }
  return {
    store, decisions, snapshots, sourceDeps,
    setClock: (t: number) => { clock = t },
    views: () => collectGlobalViews(sourceDeps),
    resolve: (decisionId: string, verdict: 'keep-left' | 'keep-right' | 'keep-both') =>
      executeConfirm({ action: 'resolve', decisionId, verdict }, { workspacePath: WS }, { store, decisions, snapshots, now: () => clock }),
    forget: (ids: string[]) => executeForget({ ids, reason: '测试' }, { workspacePath: WS }, { store, snapshots, decisions, now: () => clock }),
    health: () => executeHealth({}, {
      store, registry, decisions, cache: sidecar.scanCache, thresholds: resolveHealthThresholds('normal'),
      resolveContext: async () => ({ workspacePath: WS }), now: () => clock,
    }, fakeExec()),
  }
}

const g = (partial: Partial<MemoryRecord>) => record({ lastConfirmedAt: T0, createdAt: T0, updatedAt: T0, ...partial })
const w = (partial: Partial<MemoryRecord>) => g({ scope: 'workspace', workspacePath: WS, ...partial })
const wsDir = () => join(root, workspaceDirName(WS))

describe('待处理视图', () => {
  it('五类来源按密钥 → 冲突 → 提升候选 → 超限 → 读不出的文件排序；密钥与读不出的文件派生、不入账本', async () => {
    const h = harness()
    await h.store.create(g({ id: 'mem_secret', name: '部署凭证', content: `token ${FAKE_SECRET.sk}` }))
    await h.store.create(w({ id: 'mem_a', name: 'A', content: '用 pnpm' }))
    await h.store.create(w({ id: 'mem_b', name: 'B', content: '用 npm' }))
    await h.store.create(w({ id: 'mem_v', name: 'V', content: '用 yarn' }))
    await h.store.create(w({ id: 'mem_p', name: 'P', content: '所有项目都用 vitest', globalCandidate: true }))
    await writeFile(join(wsDir(), 'broken.md'), '---\nname: [\n---\n正文\n')
    await h.decisions.syncOverflow(WS, { mode: 'relax', tier: 2 }, 1, '超限')
    const [overflow] = await h.decisions.listOverflow()
    const promote = (await h.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_p'], summary: '', fingerprint: 'c' }, 2)).entry
    const vertical = (await h.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾', fingerprint: 'v' }, 3)).entry
    const horizontal = (await h.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'h' }, 4)).entry

    const { pending } = await h.views()
    expect(pendingViewSchema.parse(pending)).toEqual(pending)
    expect(pending.items.map(i => i.kind)).toEqual([...PENDING_ITEM_KINDS])
    expect(pending.dot).toBe('red')
    const [secret, h1, v1, p1, o1, bad] = pending.items
    expect(secret.kind === 'secret' && secret.memory.id).toBe('mem_secret')
    expect(JSON.stringify(secret)).not.toContain(FAKE_SECRET.sk)
    expect(h1).toMatchObject({ kind: 'conflict-horizontal', decisionId: horizontal.id, firstSeenAt: 4, left: { id: 'mem_a', content: '用 pnpm' }, right: { id: 'mem_b' } })
    expect(v1).toMatchObject({ kind: 'conflict-vertical', decisionId: vertical.id, baselineRef: 'AGENTS.md：包管理', memory: { id: 'mem_v' } })
    expect(p1).toMatchObject({ kind: 'promote-candidate', decisionId: promote.id, memory: { id: 'mem_p', scope: 'workspace', workspacePath: WS } })
    expect(o1).toEqual({ kind: 'overflow', decisionId: overflow.id, firstSeenAt: 1, mode: 'relax', tier: 2, workspacePath: WS })
    expect(bad).toMatchObject({ kind: 'unreadable-file', layer: { kind: 'workspace', workspacePath: WS }, filePath: join(wsDir(), 'broken.md'), relativePath: `${workspaceDirName(WS)}/broken.md` })
    expect(bad.kind === 'unreadable-file' && bad.error.length).toBeGreaterThan(0)
    // 密钥与读不出的文件没有进账本
    expect((await h.decisions.list()).map(e => e.kind ?? 'conflict').sort()).toEqual(['conflict', 'conflict', 'overflow', 'promote-candidate'])
  })

  it('横向冲突带 preferredId（快照注入排序：confidence 降序 → lastConfirmedAt 降序）；一方找不到时取另一方', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_low', name: 'L', confidence: 0.5, lastConfirmedAt: T0 + 10 }))
    await h.store.create(w({ id: 'mem_high', name: 'H', confidence: 0.9, lastConfirmedAt: T0 }))
    await h.store.create(w({ id: 'mem_old', name: 'O', confidence: 0.9, lastConfirmedAt: T0 - 10 }))
    await h.decisions.upsert({ memoryIds: ['mem_low', 'mem_high'], summary: '按置信度', fingerprint: 'c' }, 1)
    await h.decisions.upsert({ memoryIds: ['mem_old', 'mem_high'], summary: '同置信度按确认时间', fingerprint: 't' }, 2)
    await h.decisions.upsert({ memoryIds: ['mem_gone', 'mem_low'], summary: '悬空', fingerprint: 'g' }, 3)
    const { pending } = await h.views()
    expect(pendingViewSchema.parse(pending)).toEqual(pending)
    expect(pending.items.map(i => i.kind === 'conflict-horizontal' && [i.summary, i.preferredId])).toEqual([
      ['按置信度', 'mem_high'], ['同置信度按确认时间', 'mem_high'], ['悬空', 'mem_low'],
    ])
  })

  it('typeLabels：当前注册表的类型和待处理里出现的类型 → 显示名，认不出的类型显示 id', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A', type: 'decision' }))
    await h.store.create(w({ id: 'mem_b', name: 'B', type: 'mystery' }))
    await h.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'h' }, 1)
    const { pending } = await h.views()
    expect(pending.typeLabels).toMatchObject({ preference: '行为偏好', procedure: '可复用流程', decision: '决定', mystery: 'mystery' })
  })

  it('已裁决条目不在待处理里；只有读不出的文件时不亮点，只有冲突时亮琥珀点', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    await h.store.create(w({ id: 'mem_b', name: 'B' }))
    const { entry } = await h.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'h' }, 1)
    expect((await h.views()).pending.dot).toBe('amber')
    await h.resolve(entry.id, 'keep-both')
    await writeFile(join(wsDir(), 'broken.md'), 'no frontmatter')
    const { pending } = await h.views()
    expect(pending.items.map(i => i.kind)).toEqual(['unreadable-file'])
    expect(pending.dot).toBe('none')
  })
})

describe('待处理视图：体检关闭', () => {
  async function seedAll(h: ReturnType<typeof harness>, withSecret: boolean) {
    if (withSecret) await h.store.create(g({ id: 'mem_secret', name: '部署凭证', content: `token ${FAKE_SECRET.sk}` }))
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    await h.store.create(w({ id: 'mem_b', name: 'B' }))
    await h.store.create(w({ id: 'mem_p', name: 'P', globalCandidate: true }))
    await writeFile(join(wsDir(), 'broken.md'), '---\nname: [\n---\n正文\n')
    await h.decisions.syncOverflow(WS, { mode: 'relax', tier: 1 }, 1, '超限')
    await h.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_p'], summary: '', workspaces: [WS], fingerprint: 'c' }, 2)
    await h.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'h' }, 3)
  }

  it('只剩不靠模型的条目：密钥、超限提醒、读不出的文件；有密钥亮红点', async () => {
    const h = harness()
    await seedAll(h, true)
    const off = await collectGlobalViews({ ...h.sourceDeps, isGovernanceEnabled: () => false })
    expect(pendingViewSchema.parse(off.pending)).toEqual(off.pending)
    expect(off.pending.items.map(i => i.kind)).toEqual(['secret', 'overflow', 'unreadable-file'])
    expect(off.pending.dot).toBe('red')
    // 账本没动：打开体检后冲突、候选都回来
    expect((await h.views()).pending.items.map(i => i.kind)).toEqual([...PENDING_ITEM_KINDS].filter(k => k !== 'conflict-vertical'))
  })

  it('没有密钥时按剩下的条目亮点：超限提醒能处理所以亮琥珀，只剩读不出的文件则不亮', async () => {
    const h = harness()
    await seedAll(h, false)
    const off = await collectGlobalViews({ ...h.sourceDeps, isGovernanceEnabled: () => false })
    expect(off.pending.items.map(i => i.kind)).toEqual(['overflow', 'unreadable-file'])
    expect(off.pending.dot).toBe('amber')
    await h.decisions.syncOverflow(WS, undefined, 4, '超限')
    const calm = await collectGlobalViews({ ...h.sourceDeps, isGovernanceEnabled: () => false })
    expect(calm.pending.items.map(i => i.kind)).toEqual(['unreadable-file'])
    expect(calm.pending.dot).toBe('none')
  })
})

describe('待处理视图：提升候选', () => {
  it('记忆已不是本项目候选（模型直接 memory_promote 了、标记被清、记忆没了）：账本里的旧条目不显示、不亮点，等下次体检清掉', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_live', name: 'L', globalCandidate: true }))
    await h.store.create(w({ id: 'mem_cleared', name: 'C' }))
    await h.store.create(g({ id: 'mem_promoted', name: 'G' }))
    for (const [id, t] of [['mem_live', 1], ['mem_cleared', 2], ['mem_promoted', 3], ['mem_gone', 4]] as const) {
      await h.decisions.upsert({ kind: 'promote-candidate', memoryIds: [id], summary: '', workspaces: [WS], fingerprint: id }, t)
    }
    const { pending } = await h.views()
    expect(pending.items.map(i => i.kind === 'promote-candidate' && i.memory?.id)).toEqual(['mem_live'])

    const { globalCandidate: _flag, ...cleared } = (await h.store.get('mem_live'))!
    await h.store.put(cleared)
    const after = (await h.views()).pending
    expect(after.items).toEqual([])
    expect(after.dot).toBe('none')
  })
})

describe('全部记忆视图', () => {
  it('按层列 active 记忆（global 在前），带存储目录；目录问题（同 id 副本、被忽略字段）列出', async () => {
    const h = harness()
    await h.store.create(g({ id: 'mem_g', name: '全局一条' }))
    await h.store.create(w({ id: 'mem_w2', name: '乙' }))
    await h.store.create(w({ id: 'mem_w1', name: '甲' }))
    await h.store.create(w({ id: 'mem_gone', name: '删掉的' }))
    await h.forget(['mem_gone'])
    const dup = join(wsDir(), 'dup.md')
    await writeFile(dup, encodeRecord(w({ id: 'mem_g', name: '全局一条', updatedAt: T0 - 1 }), {}))
    const reserved = join(wsDir(), 'reserved.md')
    await writeFile(reserved, '---\nname: 保留键\ntype: preference\nrecallCount: 3\n---\n\n正文\n')

    const { library } = await h.views()
    expect(libraryViewSchema.parse(library)).toEqual(library)
    expect(library.memoryRoot).toBe(root)
    expect(library.layers.map(l => [l.layer, l.items.map(i => i.name)])).toEqual([
      [{ kind: 'global' }, ['全局一条']],
      [{ kind: 'workspace', workspacePath: WS }, ['乙', '保留键', '甲'].sort()],
    ])
    expect(library.layers[0].items[0].filePath).toBe(join(root, GLOBAL_DIR, '全局一条.md'))
    expect(library.directoryIssues.map(i => [i.code, i.path])).toEqual(expect.arrayContaining([['duplicate-id', dup], ['reserved-keys', reserved]]))
    // 同 id 副本：path 是没用上的那份，keptPath 是在用的那份
    expect(library.directoryIssues.find(i => i.code === 'duplicate-id')).toEqual({ code: 'duplicate-id', path: dup, keptPath: join(root, GLOBAL_DIR, '全局一条.md') })
  })

  it('同 id 在 global 与本项目各一份：删掉 global 那份后本项目这份照常列出；删掉的那份进最近删除，不算同 id 副本', async () => {
    const h = harness()
    await h.store.create(g({ id: 'mem_same', name: '全局那份' }))
    await h.store.create(w({ id: 'mem_same', name: '本项目那份' }))
    h.setClock(T0 + 5000)
    expect(await h.store.softDelete({ id: 'mem_same' }, { isExactLayer: true })).toBe(true)

    const { library, deleted } = await h.views()
    expect(library.layers.map(l => [l.layer, l.items.map(i => [i.id, i.name, i.filePath])])).toEqual([
      [{ kind: 'global' }, []],
      [{ kind: 'workspace', workspacePath: WS }, [['mem_same', '本项目那份', join(wsDir(), '本项目那份.md')]]],
    ])
    expect(library.directoryIssues).toEqual([])
    expect(deleted.items.map(i => [i.memory.id, i.memory.name, i.memory.scope, i.memory.filePath])).toEqual([
      ['mem_same', '全局那份', 'global', join(root, GLOBAL_DIR, '.archive', '全局那份.md')],
    ])
  })

  it('typeLabels：注册表的类型和本视图记忆卡里出现的类型 → 显示名，认不出的类型显示 id', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A', type: 'decision' }))
    await h.store.create(g({ id: 'mem_b', name: 'B', type: 'mystery' }))
    const { library } = await h.views()
    expect(libraryViewSchema.parse(library)).toEqual(library)
    expect(library.typeLabels).toMatchObject({ preference: '行为偏好', decision: '决定', mystery: 'mystery' })
  })
})

describe('最近删除视图', () => {
  it('裁决删掉的标来源（verdict + 对方 id + 快照）；普通遗忘不标；带物理清除时刻', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    await h.store.create(w({ id: 'mem_b', name: 'B' }))
    await h.store.create(w({ id: 'mem_x', name: 'X' }))
    const { entry } = await h.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'h' }, 1)
    await h.resolve(entry.id, 'keep-left')
    h.setClock(T0 + 5000)
    await h.forget(['mem_x'])

    const { deleted } = await h.views()
    expect(deletedViewSchema.parse(deleted)).toEqual(deleted)
    const [snap] = (await h.snapshots.list()).filter(s => s.memoryIds.includes('mem_b'))
    expect(deleted.items.map(i => [i.memory.id, i.deletedAt, i.purgeAt, i.cause])).toEqual([
      ['mem_x', T0 + 5000, T0 + 5000 + RETENTION_MS, undefined],
      ['mem_b', T0, T0 + RETENTION_MS, { decisionId: entry.id, verdict: 'keep-left', counterpartId: 'mem_a', snapshotId: snap.id }],
    ])
  })

  it('typeLabels：注册表的类型、删掉的记忆和裁决对方的类型 → 显示名，认不出的类型显示 id', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A', type: 'legacy-a' }))
    await h.store.create(w({ id: 'mem_b', name: 'B', type: 'legacy-b' }))
    const { entry } = await h.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'h' }, 1)
    await h.resolve(entry.id, 'keep-left')
    const { deleted } = await h.views()
    expect(deletedViewSchema.parse(deleted)).toEqual(deleted)
    expect(deleted.typeLabels).toMatchObject({ procedure: '可复用流程', 'legacy-a': 'legacy-a', 'legacy-b': 'legacy-b' })
  })

  it('垂直冲突以基线为准删掉的：来源写基线出处', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_v', name: 'V' }))
    const { entry } = await h.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '矛盾', fingerprint: 'v' }, 1)
    await h.resolve(entry.id, 'keep-right')
    const { deleted } = await h.views()
    expect(deleted.items[0].cause).toMatchObject({ verdict: 'keep-right', baselineRef: 'AGENTS.md：包管理' })
    expect(deleted.items[0].cause?.counterpartId).toBeUndefined()
  })
})

describe('健康视图', () => {
  it('超限列为问题、不扣分：已忽略的仍列出；memory_health 同样报出', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    const before = await h.health()
    if (before.kind !== 'single') throw new Error(before.kind)
    expect(before.recommendationKinds).not.toContain('budget-overflow')

    await h.decisions.syncOverflow(WS, { mode: 'relax', tier: 1 }, T0, '带入记忆约 4100 token，超出上限 4000，已自动放宽到 5000')
    const [entry] = await h.decisions.listOverflow()
    await h.decisions.settle(entry.id, 'dismiss', T0)

    const { health, pending } = await h.views()
    expect(healthViewSchema.parse(health)).toEqual(health)
    expect(pending.items).toEqual([])
    const ws = health.layers.find(l => l.layer.kind === 'workspace')!
    expect(ws.overflow).toEqual({ mode: 'relax', tier: 1 })
    expect(health.layers.find(l => l.layer.kind === 'global')!.overflow).toBeNull()

    const tool = await h.health()
    if (tool.kind !== 'single') throw new Error(tool.kind)
    expect(tool.score).toBe(before.score)
    expect(ws.score).toBe(before.score)
    expect(tool.overflow).toEqual({ mode: 'relax', tier: 1, summary: '带入记忆约 4100 token，超出上限 4000，已自动放宽到 5000' })
    expect(tool.recommendationKinds).toContain('budget-overflow')
    expect(tool.message).toContain('超出上限')
  })

  it('复用治理评分：与 memory_health 同分；从没体检过 semanticCachedAt 为 null；有密钥的层不打分', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    await h.store.create(w({ id: 'mem_old', name: '过期', validTo: T0 - 1 }))
    await h.store.create(g({ id: 'mem_s', name: '凭证', content: FAKE_SECRET.github }))

    const { health } = await h.views()
    expect(healthViewSchema.parse(health)).toEqual(health)
    const tool = await h.health()
    if (tool.kind !== 'single') throw new Error(tool.kind)
    const ws = health.layers.find(l => l.layer.kind === 'workspace')!
    expect(ws).toMatchObject({ layer: { kind: 'workspace', workspacePath: WS }, totalMemories: 2, score: tool.score, semanticCachedAt: null })
    expect(ws.issues).toEqual([{ type: 'expired', count: 1 }])
    const global = health.layers.find(l => l.layer.kind === 'global')!
    expect(global).toMatchObject({ score: null, gate: { secret: true }, issues: [{ type: 'secret', count: 1 }] })
  })
  it('带体检开关：缺省开启，关闭时 governanceEnabled 为 false（层照常列出）', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    expect((await h.views()).health.governanceEnabled).toBe(true)
    const off = await collectGlobalViews({ ...h.sourceDeps, isGovernanceEnabled: () => false })
    expect(healthViewSchema.parse(off.health)).toEqual(off.health)
    expect(off.health.governanceEnabled).toBe(false)
    expect(off.health.layers.map(l => l.layer.kind)).toEqual(['global', 'workspace'])
  })
  it('带插件启动时刻：给了就写进健康视图（右侧栏据此判断冻结快照是否在重启前），不给就不出现', async () => {
    const h = harness()
    const withBoot = await collectGlobalViews({ ...h.sourceDeps, bootedAt: 1_700_000_000_000 })
    expect(healthViewSchema.parse(withBoot.health)).toEqual(withBoot.health)
    expect(withBoot.health.bootedAt).toBe(1_700_000_000_000)
    expect((await h.views()).health).not.toHaveProperty('bootedAt')
  })
})

describe('会话视图', () => {
  it('带 frozenAt 与三段用量，只存时间戳', () => {
    const view = buildSessionView({
      sessionId: 's1', workspacePath: WS, frozenAt: T0, budget: 4000, overflowMode: 'strict',
      tokens: { workspace: 120, global: 80, fixed: 40 }, usedTokens: 210, injectedIds: ['mem_a'], omittedCount: 3, savedIds: [],
    })
    expect(sessionViewSchema.parse(view)).toEqual(view)
    expect(view.frozenAt).toBe(T0)
  })
})

describe('视图写入', () => {
  it('视图目录在侧表目录下（契约里的相对路径与存储布局一致）', () => {
    expect(GUI_VIEW_DIR).toBe(`${STATE_DIR}/gui`)
  })

  async function readView(name: GlobalViewName) {
    return JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES[name]), 'utf8'))
  }

  it('同一 tick 内多次触发只收集、只写一遍；之后再触发再写', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    let collects = 0
    const writer = new ViewWriter({ memoryRoot: root, collect: () => { collects++; return collectGlobalViews(h.sourceDeps) } })
    await Promise.all([writer.request(['pending']), writer.request(['library']), writer.request(['pending'])])
    expect(collects).toBe(1)
    expect(pendingViewSchema.parse(await readView('pending')).items).toEqual([])
    expect(libraryViewSchema.parse(await readView('library')).layers[1].items.map((i: { id: string }) => i.id)).toEqual(['mem_a'])
    await expect(readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES.health), 'utf8')).rejects.toThrow()

    await h.store.create(w({ id: 'mem_b', name: 'B' }))
    await writer.request(['library'])
    expect(collects).toBe(2)
    expect((await readView('library')).layers[1].items.map((i: { id: string }) => i.id)).toEqual(['mem_a', 'mem_b'])
  })

  it('全量重写写出四个全局视图，内容合契约', async () => {
    const h = harness()
    await h.store.create(g({ id: 'mem_g', name: 'G' }))
    const writer = new ViewWriter({ memoryRoot: root, collect: () => collectGlobalViews(h.sourceDeps) })
    await writer.rewriteAll()
    expect(pendingViewSchema.safeParse(await readView('pending')).success).toBe(true)
    expect(healthViewSchema.safeParse(await readView('health')).success).toBe(true)
    expect(libraryViewSchema.safeParse(await readView('library')).success).toBe(true)
    expect(deletedViewSchema.safeParse(await readView('deleted')).success).toBe(true)
  })

  it('会话归属对照：同一 tick 的多笔合成一次写；新写入器接着磁盘上已有的对照往里添，同一 cwd 以最新为准', async () => {
    const mapPath = join(root, GUI_VIEW_DIR, GUI_WORKSPACE_MAP_FILE)
    const readMap = async () => workspaceMapViewSchema.parse(JSON.parse(await readFile(mapPath, 'utf8')))
    const first = new ViewWriter({ memoryRoot: root, collect: () => { throw new Error('不该收集全局视图') } })
    await Promise.all([first.requestWorkspace('/link/app', '/w/app'), first.requestWorkspace('/w/app/sub', '/w/app')])
    expect(await readMap()).toEqual({ version: GUI_VIEW_VERSION, cwds: { '/link/app': '/w/app', '/w/app/sub': '/w/app' } })

    // 插件重载：新写入器先读回旧对照再合并，不把之前见过的会话丢掉
    const second = new ViewWriter({ memoryRoot: root, collect: () => { throw new Error('不该收集全局视图') } })
    await second.requestWorkspace('/w/app/pkg', '/w/app/pkg')
    await second.requestWorkspace('/w/app/sub', '/w/app/sub')
    expect((await readMap()).cwds).toEqual({ '/link/app': '/w/app', '/w/app/sub': '/w/app/sub', '/w/app/pkg': '/w/app/pkg' })
  })

  it('会话归属对照：磁盘上的旧文件读不懂（版本不对、坏 JSON）就从空表重来', async () => {
    const mapPath = join(root, GUI_VIEW_DIR, GUI_WORKSPACE_MAP_FILE)
    await mkdir(join(root, GUI_VIEW_DIR), { recursive: true })
    await writeFile(mapPath, '{not json', 'utf8')
    const writer = new ViewWriter({ memoryRoot: root, collect: () => { throw new Error('不该收集全局视图') } })
    await writer.requestWorkspace('/w/app', '/w/app')
    expect(workspaceMapViewSchema.parse(JSON.parse(await readFile(mapPath, 'utf8'))).cwds).toEqual({ '/w/app': '/w/app' })
  })

  it('会话视图：同一 tick 内同一会话多次写入合并为最后一份', async () => {
    const writer = new ViewWriter({ memoryRoot: root, collect: () => { throw new Error('不该收集全局视图') } })
    const base = {
      sessionId: 's/1', frozenAt: T0, budget: 4000, overflowMode: 'relax' as const,
      tokens: { workspace: 1, global: 2, fixed: 3 }, usedTokens: 3, injectedIds: ['mem_a'], omittedCount: 0,
    }
    await Promise.all([
      writer.requestSession(buildSessionView({ ...base, savedIds: [] })),
      writer.requestSession(buildSessionView({ ...base, savedIds: ['mem_n'] })),
    ])
    const view = sessionViewSchema.parse(JSON.parse(await readFile(join(root, GUI_VIEW_DIR, sessionViewFile('s/1')), 'utf8')))
    expect(view.savedIds).toEqual(['mem_n'])
  })

  const sessionBase = {
    sessionId: 's/1', frozenAt: T0, budget: 4000, overflowMode: 'relax' as const,
    tokens: { workspace: 1, global: 2, fixed: 3 }, usedTokens: 3, injectedIds: [], omittedCount: 0, savedIds: [],
  }
  const listViews = () => readdir(join(root, GUI_VIEW_DIR)).catch(() => [] as string[])
  const nextTicks = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)) }

  it('卸载：等进行中的写入落完才返回；排队未开始的丢弃，之后的请求不再写', async () => {
    const h = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let collects = 0
    const writer = new ViewWriter({ memoryRoot: root, collect: async () => { collects++; await gate; return collectGlobalViews(h.sourceDeps) } })
    const inFlight = writer.rewriteAll()
    // 排在进行中那次之后：一次节流写、一次全量重写
    void writer.request(['pending'])
    void writer.rewriteAll()
    await nextTicks()
    expect(collects).toBe(1)

    let disposed = false
    const disposing = writer.dispose().then(() => { disposed = true })
    await nextTicks()
    expect(disposed).toBe(false)
    release()
    await disposing
    await inFlight
    expect((await listViews()).sort()).toEqual(Object.values(GUI_VIEW_FILES).sort())

    await expect(writer.requestSession(buildSessionView(sessionBase))).resolves.toBeUndefined()
    await expect(writer.requestWorkspace('/w/app', '/w/app')).resolves.toBeUndefined()
    await expect(writer.request()).resolves.toBeUndefined()
    await expect(writer.rewriteAll()).resolves.toBeUndefined()
    await nextTicks()
    expect(collects).toBe(1)
    expect((await listViews()).sort()).toEqual(Object.values(GUI_VIEW_FILES).sort())
  })

  it('卸载：同一 tick 内刚请求、还没开始的写入整批丢弃', async () => {
    const writer = new ViewWriter({ memoryRoot: root, collect: () => { throw new Error('不该收集全局视图') } })
    void writer.request(['library'])
    void writer.requestSession(buildSessionView(sessionBase))
    void writer.requestWorkspace('/w/app', '/w/app')
    await writer.dispose()
    await nextTicks()
    expect(await listViews()).toEqual([])
  })
})
