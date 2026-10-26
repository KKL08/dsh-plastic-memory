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
import { SEVERITY_BY_TYPE, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema, type Finding, type FindingType } from '../src/governance/schema.ts'
import { layerCacheKey, type LayerRef } from '../src/governance/layer-health.ts'
import { resolveHealthThresholds } from '../src/governance/health-presets.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { executeConfirm } from '../src/tools/confirm.ts'
import { executeForget } from '../src/tools/forget.ts'
import { executeHealth } from '../src/tools/health.ts'
import { RETENTION_MS } from '../src/retention.ts'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, GUI_WORKSPACE_MAP_FILE, PENDING_ITEM_KINDS, deletedViewSchema, healthViewSchema,
  libraryViewSchema, pendingViewSchema, sessionViewFile, sessionViewSchema, workspaceMapViewSchema, type GlobalViewName, type PendingItem,
} from '../src/gui/contract.ts'
import { buildSessionView } from '../src/gui/views.ts'
import { ViewWriter, collectGlobalViews } from '../src/gui/view-writer.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { fakeExec } from './helpers/exec.ts'
import { FAKE_SECRET, generatePrivateKeyPem } from './helpers/secrets.ts'
import { SECRET_MASK } from '../src/secrets.ts'

// 视图生成：真实临时目录（FileTable + .state 侧表）+ 账本 → 五种视图 JSON。只断言视图内容，不 mock 自己的模块。

const WS = '/home/dev/proj-a'
const T0 = 1_700_000_000_000
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-gui-views-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function harness() {
  let clock = T0
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => clock }), undefined, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const sourceDeps = { store, decisions, cache: sidecar.scanCache, registry, memoryRoot: root, now: () => clock }
  return {
    store, decisions, snapshots, sourceDeps, cache: sidecar.scanCache,
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
  it('五类来源按密钥 → 读不出的文件 → 冲突 → 提升候选 → 超限排序；密钥与读不出的文件派生、不入账本', async () => {
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
    expect(pending.items.map(i => i.kind)).toEqual(PENDING_ITEM_KINDS.filter(k => k !== 'advice'))
    expect(pending.dot).toBe('red')
    const [secret, bad, h1, v1, p1, o1] = pending.items
    expect(secret.kind === 'secret' && secret.memory.id).toBe('mem_secret')
    expect(JSON.stringify(secret)).not.toContain(FAKE_SECRET.sk)
    expect(h1).toMatchObject({ kind: 'conflict-horizontal', decisionId: horizontal.id, firstSeenAt: 4, left: { id: 'mem_a', content: '用 pnpm' }, right: { id: 'mem_b' } })
    expect(v1).toMatchObject({ kind: 'conflict-vertical', decisionId: vertical.id, baselineRef: 'AGENTS.md：包管理', memory: { id: 'mem_v' } })
    expect(p1).toMatchObject({ kind: 'promote-candidate', decisionId: promote.id, memory: { id: 'mem_p', scope: 'workspace', workspacePath: WS } })
    expect(o1).toEqual({ kind: 'overflow', level: 'your-call', decisionId: overflow.id, firstSeenAt: 1, mode: 'relax', tier: 2, workspacePath: WS })
    expect(bad).toMatchObject({ kind: 'unreadable-file', layer: { kind: 'workspace', workspacePath: WS }, filePath: join(wsDir(), 'broken.md'), relativePath: `${workspaceDirName(WS)}/broken.md` })
    expect(bad.kind === 'unreadable-file' && bad.error.length).toBeGreaterThan(0)
    // 密钥与读不出的文件没有进账本
    expect((await h.decisions.list()).map(e => e.kind ?? 'conflict').sort()).toEqual(['conflict', 'conflict', 'overflow', 'promote-candidate'])
  })

  it('每个待处理项带级别：密钥、读不出的文件属高优问题，冲突、提升候选、超限属待你处理；高优问题排在前，视图带各级条数', async () => {
    const h = harness()
    await h.store.create(g({ id: 'mem_secret', name: '部署凭证', content: `token ${FAKE_SECRET.sk}` }))
    await h.store.create(w({ id: 'mem_a', name: 'A', content: '用 pnpm' }))
    await h.store.create(w({ id: 'mem_b', name: 'B', content: '用 npm' }))
    await h.store.create(w({ id: 'mem_v', name: 'V', content: '用 yarn' }))
    await h.store.create(w({ id: 'mem_p', name: 'P', content: '所有项目都用 vitest', globalCandidate: true }))
    await writeFile(join(wsDir(), 'broken.md'), '---\nname: [\n---\n正文\n')
    await h.decisions.syncOverflow(WS, { mode: 'relax', tier: 2 }, 1, '超限')
    await h.decisions.upsert({ kind: 'promote-candidate', memoryIds: ['mem_p'], summary: '', fingerprint: 'c' }, 2)
    await h.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾', fingerprint: 'v' }, 3)
    await h.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'h' }, 4)

    const { pending } = await h.views()
    expect(pendingViewSchema.parse(pending)).toEqual(pending)
    expect(pending.items.map(i => [i.level, i.kind])).toEqual([
      ['must-fix', 'secret'], ['must-fix', 'unreadable-file'],
      ['your-call', 'conflict-horizontal'], ['your-call', 'conflict-vertical'], ['your-call', 'promote-candidate'], ['your-call', 'overflow'],
    ])
    expect(pending.levelCounts).toEqual({ 'must-fix': 2, 'your-call': 4, 'advice': 0 })
  })

  it('没有待处理项：各级条数都是 0', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A', content: '用 pnpm' }))
    const { pending } = await h.views()
    expect(pending.items).toEqual([])
    expect(pending.levelCounts).toEqual({ 'must-fix': 0, 'your-call': 0, 'advice': 0 })
  })

  it('读不出的文件：显示用的相对路径遮掉文件名里的密钥，打开用的 filePath 仍是真实路径', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A', content: '用 pnpm' }))
    const broken = join(wsDir(), `deploy-${FAKE_SECRET.sk}.md`)
    await writeFile(broken, '---\nname: [\n---\n正文\n')
    const { pending } = await h.views()
    const bad = pending.items.find(i => i.kind === 'unreadable-file')
    expect(bad).toMatchObject({ filePath: broken, relativePath: `${workspaceDirName(WS)}/deploy-${SECRET_MASK}.md` })
  })

  it('PEM 私钥整块遮住：待处理的密钥条目与记忆库视图里都不出现私钥正文', async () => {
    const h = harness()
    const { pem, bodyLines } = generatePrivateKeyPem()
    await h.store.create(g({ id: 'mem_pem', name: '部署机', content: `私钥\n${pem}\n用完删掉` }))
    const { pending, library } = await h.views()
    expect(pending.items.map(i => i.kind === 'secret' && i.memory.id)).toEqual(['mem_pem'])
    const json = JSON.stringify({ pending, library })
    expect(json).toContain('用完删掉')
    for (const line of bodyLines) expect(json).not.toContain(line)
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
    expect(off.pending.items.map(i => i.kind)).toEqual(['secret', 'unreadable-file', 'overflow'])
    expect(off.pending.levelCounts).toEqual({ 'must-fix': 2, 'your-call': 1, 'advice': 0 })
    expect(off.pending.dot).toBe('red')
    // 账本没动：打开体检后冲突、候选都回来
    expect((await h.views()).pending.items.map(i => i.kind)).toEqual(PENDING_ITEM_KINDS.filter(k => k !== 'conflict-vertical' && k !== 'advice'))
  })

  it('没有密钥时按剩下的条目亮点：超限提醒能处理所以亮琥珀，只剩读不出的文件则不亮', async () => {
    const h = harness()
    await seedAll(h, false)
    const off = await collectGlobalViews({ ...h.sourceDeps, isGovernanceEnabled: () => false })
    expect(off.pending.items.map(i => i.kind)).toEqual(['unreadable-file', 'overflow'])
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

describe('待处理视图：建议整理', () => {
  const DAY = 86_400_000
  /** 四类各一条：已过有效期、内容过长、指向的旧记忆已不在、很久没确认（project 类型衰减期 7 天）。 */
  async function seedAdvice(h: ReturnType<typeof harness>) {
    await h.store.create(w({ id: 'mem_expired', name: '冻结期', validTo: T0 - 1 }))
    await h.store.create(w({ id: 'mem_bloat', name: '长文', content: 'x'.repeat(2001) }))
    await h.store.create(g({ id: 'mem_orphan', name: '新规则', supersedes: ['mem_gone'] }))
    await h.store.create(w({ id: 'mem_stale', name: '里程碑', type: 'project', lastConfirmedAt: T0 - 8 * DAY }))
    await h.store.create(w({ id: 'mem_fine', name: '没问题', type: 'project' }))
  }
  const adviceOf = (pending: { items: readonly PendingItem[] }) =>
    pending.items.flatMap(i => i.kind === 'advice' ? [[i.type, i.memories.map(m => m.id)] as const] : [])

  it('四类按身份（类型 + 记忆 id）各出一项，属建议整理、排在最后，视图带建议条数；不亮左栏圆点、不进账本', async () => {
    const h = harness()
    await seedAdvice(h)
    const { pending } = await h.views()
    expect(pendingViewSchema.parse(pending)).toEqual(pending)
    expect(adviceOf(pending)).toEqual([
      ['expired', ['mem_expired']], ['bloat', ['mem_bloat']], ['orphan', ['mem_orphan']], ['stale', ['mem_stale']],
    ])
    expect(pending.items.every(i => i.level === 'advice')).toBe(true)
    expect(pending.items[0]).toMatchObject({ kind: 'advice', level: 'advice', type: 'expired', memories: [{ id: 'mem_expired', validTo: T0 - 1, filePath: expect.stringContaining(workspaceDirName(WS)) }] })
    expect(pending.levelCounts).toEqual({ 'must-fix': 0, 'your-call': 0, 'advice': 4 })
    expect(pending.dot).toBe('none')
    expect(await h.decisions.list()).toEqual([])
  })

  it('和健康视图同口径：每层的建议条数 = 该层已过有效期、内容过长、旧记忆已不在的扣分条数 + 很久没确认条数', async () => {
    const h = harness()
    await seedAdvice(h)
    const { pending, health } = await h.views()
    for (const layer of health.layers) {
      const inLayer = pending.items.filter(i => i.kind === 'advice' && (layer.layer.kind === 'global'
        ? i.memories[0]!.scope === 'global' : i.memories[0]!.workspacePath === layer.layer.workspacePath))
      const ruleCount = layer.issues.filter(x => ['expired', 'bloat', 'orphan'].includes(x.type)).reduce((s, x) => s + x.count, 0)
      expect(inLayer.length).toBe(ruleCount + layer.staleCount)
    }
  })

  it('改好后下一次生成视图即消失：延长有效期、精简内容、去掉失效引用、确认仍然有效', async () => {
    const h = harness()
    await seedAdvice(h)
    expect(adviceOf((await h.views()).pending)).toHaveLength(4)
    const fix = async (id: string, patch: Partial<MemoryRecord>) => { await h.store.put({ ...(await h.store.get(id))!, ...patch }) }
    await fix('mem_expired', { validTo: T0 + DAY })
    await fix('mem_bloat', { content: '精简后' })
    await fix('mem_orphan', { supersedes: [] })
    const refreshed = await executeConfirm({ action: 'refresh', memoryId: 'mem_stale' }, { workspacePath: WS }, { store: h.store, decisions: h.decisions, snapshots: h.snapshots, now: () => T0 })
    expect(refreshed.kind).toBe('refreshed')
    const { pending } = await h.views()
    expect(pending.items).toEqual([])
    expect(pending.levelCounts.advice).toBe(0)
  })

  it('记忆不再 active（删除、被取代）：对应的建议不显示', async () => {
    const h = harness()
    await seedAdvice(h)
    await h.forget(['mem_expired', 'mem_bloat'])
    await h.store.put({ ...(await h.store.get('mem_stale'))!, status: 'superseded' })
    expect(adviceOf((await h.views()).pending)).toEqual([['orphan', ['mem_orphan']]])
  })

  it('同 id 在全局和本项目各一份：按实际在用的那份出一项，不重复', async () => {
    const h = harness()
    await h.store.create(g({ id: 'mem_dup', name: '全局那份', validTo: T0 - 1 }))
    await h.store.create(w({ id: 'mem_dup', name: '本项目那份', validTo: T0 - 1, updatedAt: T0 + 1 }))
    const advice = (await h.views()).pending.items.filter(i => i.kind === 'advice')
    expect(advice).toHaveLength(1)
  })

  it('体检关闭时四类照常显示（不靠模型）', async () => {
    const h = harness()
    await seedAdvice(h)
    const off = await collectGlobalViews({ ...h.sourceDeps, isGovernanceEnabled: () => false })
    expect(adviceOf(off.pending)).toEqual(adviceOf((await h.views()).pending))
    expect(adviceOf(off.pending)).toHaveLength(4)
  })

  it('密钥仍亮红点、冲突仍亮琥珀点，建议整理不改变圆点', async () => {
    const h = harness()
    await seedAdvice(h)
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    await h.store.create(w({ id: 'mem_b', name: 'B' }))
    await h.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', fingerprint: 'h' }, 1)
    expect((await h.views()).pending.dot).toBe('amber')
  })
})

describe('待处理视图：建议整理的语义类', () => {
  const finding = (type: FindingType, memoryIds: string[], extra: Partial<Finding> = {}): Finding =>
    ({ type, layer: 'semantic', severity: SEVERITY_BY_TYPE[type], memoryIds, summary: '模型的说明', suggestedAction: '', ...extra })
  /** 写入一层的上次语义体检缓存（体检写的就是这一份）。 */
  async function cacheLayer(h: ReturnType<typeof harness>, layer: LayerRef, findings: Finding[]) {
    const key = layerCacheKey(layer)
    await h.cache.put(key, { id: key, scannedAt: T0, scope: layer.kind === 'global' ? 'global' : layer.path, findings })
  }
  const adviceOf = (pending: { items: readonly PendingItem[] }) =>
    pending.items.flatMap(i => i.kind === 'advice' ? [[i.type, i.memories.map(m => m.id)] as const] : [])

  /** 本项目：一对内容重复、一条和指令文件重复、一条该放全局、一条表述不清、一对冲突；全局：一条该放项目。 */
  async function seedSemantic(h: ReturnType<typeof harness>) {
    await h.store.create(w({ id: 'mem_r2', name: 'R 甲' }))
    await h.store.create(w({ id: 'mem_r1', name: 'R 乙' }))
    await h.store.create(w({ id: 'mem_rb', name: 'S 基线' }))
    await h.store.create(w({ id: 'mem_m', name: '该放全局' }))
    await h.store.create(w({ id: 'mem_u', name: '含糊' }))
    await h.store.create(g({ id: 'mem_gm', name: '该放项目' }))
    await cacheLayer(h, { kind: 'workspace', path: WS }, [
      finding('redundancy', ['mem_r2', 'mem_r1']),
      finding('redundancy', ['mem_rb'], { baselineRef: 'AGENTS.md：包管理' }),
      finding('misplaced', ['mem_m']),
      finding('unclear', ['mem_u']),
      finding('conflict', ['mem_r1', 'mem_u']),
    ])
    await cacheLayer(h, { kind: 'global' }, [finding('misplaced', ['mem_gm'])])
  }

  it('内容重复、放错层、表述不清从该层上次语义体检的缓存来，按身份各出一项：成对的内容重复一张卡（id 排序）；冲突不进建议整理', async () => {
    const h = harness()
    await seedSemantic(h)
    const { pending } = await h.views()
    expect(pendingViewSchema.parse(pending)).toEqual(pending)
    expect(adviceOf(pending)).toEqual([
      ['redundancy', ['mem_r1', 'mem_r2']], ['redundancy', ['mem_rb']],
      ['misplaced', ['mem_gm']], ['misplaced', ['mem_m']],
      ['unclear', ['mem_u']],
    ])
    expect(pending.levelCounts).toEqual({ 'must-fix': 0, 'your-call': 0, 'advice': 5 })
    expect(pending.dot).toBe('none')
    expect(await h.decisions.list()).toEqual([])
  })

  it('该层从没做过语义体检（没有缓存）：不出语义类', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    await cacheLayer(h, { kind: 'global' }, [finding('unclear', ['mem_a'])])
    expect(adviceOf((await h.views()).pending)).toEqual([])
  })

  it('体检关闭时语义类不显示，规则类照常显示', async () => {
    const h = harness()
    await seedSemantic(h)
    await h.store.create(w({ id: 'mem_expired', name: '冻结期', validTo: T0 - 1 }))
    const off = await collectGlobalViews({ ...h.sourceDeps, isGovernanceEnabled: () => false })
    expect(adviceOf(off.pending)).toEqual([['expired', ['mem_expired']]])
    expect(off.pending.levelCounts.advice).toBe(1)
  })

  it('缓存里的发现指向已删、已取代或已不在这一层的记忆：不显示', async () => {
    const h = harness()
    await seedSemantic(h)
    await h.forget(['mem_r2'])
    await h.store.put({ ...(await h.store.get('mem_u'))!, status: 'superseded' })
    // 体检之后这条被提升到全局：本项目的缓存还记着它放错层，但它已不在本项目，全局的缓存里也没有它
    const { workspacePath: _ws, ...moved } = (await h.store.get('mem_m'))!
    await h.store.put({ ...moved, scope: 'global' }, { workspacePath: WS })
    expect((await h.store.get('mem_m'))!.scope).toBe('global')
    expect(adviceOf((await h.views()).pending)).toEqual([['redundancy', ['mem_rb']], ['misplaced', ['mem_gm']]])
  })

  it('同一身份在两层的缓存里都出现：只出一项', async () => {
    const h = harness()
    await seedSemantic(h)
    await cacheLayer(h, { kind: 'workspace', path: WS }, [finding('misplaced', ['mem_gm', 'mem_m'])])
    expect(adviceOf((await h.views()).pending)).toEqual([['misplaced', ['mem_gm']], ['misplaced', ['mem_m']]])
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

  it('判彻底删除的正面信号：读到但不在用的 id（已取代、已删）列在 inactiveIds；有读不出的文件时 hasUnreadFiles', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_live', name: '在用' }))
    await h.store.create(w({ id: 'mem_old', name: '被取代', status: 'superseded' }))
    await h.store.create(g({ id: 'mem_gone', name: '删掉的' }))
    await h.forget(['mem_gone'])
    const clean = (await h.views()).library
    expect(libraryViewSchema.parse(clean)).toEqual(clean)
    expect([...clean.inactiveIds!].sort()).toEqual(['mem_gone', 'mem_old'])
    expect(clean.hasUnreadFiles).toBe(false)

    await writeFile(join(wsDir(), 'broken.md'), '---\nname: [\n---\n正文\n')
    expect((await h.views()).library.hasUnreadFiles).toBe(true)
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

describe('视图生成时刻', () => {
  it('全部记忆、最近删除带 generatedAt：同一次收集同一个时刻；没有这个字段的旧视图文件照样能解析', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_a', name: 'A' }))
    h.setClock(T0 + 7000)
    const { library, deleted } = await h.views()
    expect(library.generatedAt).toBe(T0 + 7000)
    expect(deleted.generatedAt).toBe(T0 + 7000)
    expect(libraryViewSchema.parse(library)).toEqual(library)
    expect(deletedViewSchema.parse(deleted)).toEqual(deleted)
    const { generatedAt: _l, ...oldLibrary } = library
    const { generatedAt: _d, ...oldDeleted } = deleted
    expect(libraryViewSchema.parse(oldLibrary)).not.toHaveProperty('generatedAt')
    expect(deletedViewSchema.parse(oldDeleted)).not.toHaveProperty('generatedAt')
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

  it('超限的项目自己没有记忆（不在体检清单里）：单列在 overflowOnlyLayers，只带超限档位，不编层统计；global 照常', async () => {
    const h = harness()
    await h.store.create(g({ id: 'mem_g', name: '全局一条' }))
    await h.decisions.syncOverflow(WS, { mode: 'strict', tier: 0 }, T0, '超限')
    await h.decisions.syncOverflow('global', { mode: 'strict', tier: 0 }, T0, '超限')

    const { health } = await h.views()
    expect(healthViewSchema.parse(health)).toEqual(health)
    expect(health.layers.map(l => [l.layer, l.overflow])).toEqual([[{ kind: 'global' }, { mode: 'strict', tier: 0 }]])
    expect(health.overflowOnlyLayers).toEqual([{ layer: { kind: 'workspace', workspacePath: WS }, overflow: { mode: 'strict', tier: 0 } }])

    // 项目有了自己的记忆就回到体检清单，不再单列
    await h.store.create(w({ id: 'mem_w', name: '本项目一条' }))
    const again = (await h.views()).health
    expect(again.layers.find(l => l.layer.kind === 'workspace')!.overflow).toEqual({ mode: 'strict', tier: 0 })
    expect(again.overflowOnlyLayers).toEqual([])
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
    expect(ws.issues).toEqual([{ type: 'expired', count: 1, level: 'advice' }])
    const global = health.layers.find(l => l.layer.kind === 'global')!
    expect(global).toMatchObject({ score: null, gate: { secret: true }, issues: [{ type: 'secret', count: 1 }] })
  })
  it('每条扣分原因带待处理里对应的组：密钥、读不出的文件在高优问题，冲突在待你处理，其余在建议整理', async () => {
    const h = harness()
    await h.store.create(w({ id: 'mem_s', name: '凭证', content: FAKE_SECRET.github }))
    await h.store.create(w({ id: 'mem_old', name: '过期', validTo: T0 - 1 }))
    await h.store.create(w({ id: 'mem_r1', name: 'R 甲' }))
    await h.store.create(w({ id: 'mem_r2', name: 'R 乙' }))
    await h.store.create(w({ id: 'mem_u', name: '含糊' }))
    await h.store.create(w({ id: 'mem_m', name: '该放全局' }))
    await writeFile(join(wsDir(), 'broken.md'), '---\nname: [\n---\n正文\n')
    const semantic = (type: FindingType, memoryIds: string[]): Finding =>
      ({ type, layer: 'semantic', severity: SEVERITY_BY_TYPE[type], memoryIds, summary: 's', suggestedAction: '' })
    const key = layerCacheKey({ kind: 'workspace', path: WS })
    await h.cache.put(key, { id: key, scannedAt: T0, scope: WS, findings: [
      semantic('conflict', ['mem_r1', 'mem_u']), semantic('redundancy', ['mem_r1', 'mem_r2']),
      semantic('misplaced', ['mem_m']), semantic('unclear', ['mem_u']),
    ] })
    // 冲突还须仍在待决账本里才计
    await h.decisions.upsert({ memoryIds: ['mem_r1', 'mem_u'], summary: '矛盾', fingerprint: 'h' }, 1)

    const { health } = await h.views()
    expect(healthViewSchema.parse(health)).toEqual(health)
    const ws = health.layers.find(l => l.layer.kind === 'workspace')!
    expect(ws.issues.map(i => [i.type, i.level])).toEqual([
      ['secret', 'must-fix'], ['expired', 'advice'], ['malformed', 'must-fix'],
      ['conflict', 'your-call'], ['redundancy', 'advice'], ['misplaced', 'advice'], ['unclear', 'advice'],
    ])
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
