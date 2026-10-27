import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { fakeExec } from './helpers/exec.ts'
import { executeScan, cacheKey, renderScanResult, type ScanToolDeps, type ScanArgs, type SingleScanResult } from '../src/tools/scan.ts'
import { GLOBAL_CACHE_KEY, scoreLayer } from '../src/governance/layer-health.ts'
import { prereadLayers } from '../src/tools/layer-preread.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { InMemoryKvTable } from '../src/kv-table.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { PendingDecision, ScanCacheEntry } from '../src/governance/schema.ts'
import { record } from './helpers/record.ts'

function makeDeps(overrides?: Partial<ScanToolDeps>): ScanToolDeps {
  return {
    store: new MemoryStore(new InMemoryTable()),
    registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    cache: new InMemoryKvTable<ScanCacheEntry>(),
    getBaseline: () => null,
    getLlm: (_exec: unknown) => null,
    resolveContext: async () => ({ workspacePath: undefined }),
    now: () => 9000,
    ...overrides,
  }
}

/** 真实记忆根（FileTable）：隔离文件只能从真实目录读出来。files 的键是相对 memoryRoot 的路径；markers 给 workspace 目录写 .workspace。 */
async function fileBackedStore(files: Record<string, string>, workspaces: string[] = []): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), 'pm-broken-'))
  roots.push(root)
  for (const ws of workspaces) {
    await mkdir(join(root, workspaceDirName(ws)), { recursive: true })
    await writeFile(join(root, workspaceDirName(ws), WORKSPACE_MARKER), ws + '\n')
  }
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), text)
  }
  return { root, store: new MemoryStore(new FileTable({ root, stats: new InMemoryKvTable<RecallStats>() })) }
}
const roots: string[] = []
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }) })

/** 单层扫描断言助手：结果必须是 single 形态。 */
async function scanSingle(args: ScanArgs, deps: ScanToolDeps): Promise<SingleScanResult> {
  const r = await executeScan(args, deps, fakeExec())
  if (r.kind !== 'single') throw new Error(`expected single, got ${r.kind}`)
  return r
}

const conflictLlm = {
  complete: async () => JSON.stringify({
    findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '互相矛盾', suggestedAction: '请裁决' }],
  }),
}

describe('executeScan 单层模式', () => {
  it('layers=rule：只跑规则层，不碰 LLM、不写缓存', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => { throw new Error('不该被调') } }) })
    await deps.store.put(record({ id: 'mem_exp', validTo: 100 }))
    const r = await scanSingle({ layers: 'rule' }, deps)
    expect(r.findings.map(f => f.type)).toEqual(['expired'])
    expect(r.semanticCachedAt).toBeNull()
    expect(r.stats.scanned).toBe(1)
    expect(r.stats.issues).toBe(1)
  })

  it('默认口径=当前 workspace 的可见集合（resolveContext），无 workspace 会话退到 global 层', async () => {
    const deps = makeDeps({ resolveContext: async () => ({ workspacePath: '/proj' }) })
    await deps.store.put(record({ id: 'mem_ws', scope: 'workspace', workspacePath: '/proj' }))
    await deps.store.put(record({ id: 'mem_g' }))
    await deps.store.put(record({ id: 'mem_other', scope: 'workspace', workspacePath: '/elsewhere' }))
    const r = await scanSingle({ layers: 'rule' }, deps)
    expect(r.layer).toBe('workspace')
    expect(r.workspacePath).toBe('/proj')
    expect(r.stats.scanned).toBe(2) // visible = 本项目 + global，不含别的项目

    const globalDeps = makeDeps()
    await globalDeps.store.put(record({ id: 'mem_g' }))
    await globalDeps.store.put(record({ id: 'mem_other', scope: 'workspace', workspacePath: '/elsewhere' }))
    const g = await scanSingle({ layers: 'rule' }, globalDeps)
    expect(g.layer).toBe('global')
    expect(g.stats.scanned).toBe(1) // 无 cwd 会话只看 global 层
  })

  it('LLM 抛异常时 layers=full 仍返回规则层结果', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => { throw new Error('boom') } }) })
    await deps.store.put(record({ id: 'mem_exp', validTo: 100 }))
    const r = await scanSingle({}, deps)
    expect(r.findings.map(f => f.type)).toContain('expired')
    expect(r.notes.map(n => n.code)).toContain('semantic-failed')
  })

  it('layers=full：语义层结果写缓存（global 层桶）、conflict 进待决账本', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => conflictLlm })
    await deps.store.put(record({ id: 'mem_a', content: '用 pnpm' }))
    await deps.store.put(record({ id: 'mem_b', content: '用 npm' }))
    const r = await scanSingle({}, deps)
    expect(r.findings.some(f => f.type === 'conflict')).toBe(true)
    expect(r.pendingDecisions.created).toBe(1)
    expect(await deps.decisions.list()).toHaveLength(1)
    const cached = (await deps.cache.get(GLOBAL_CACHE_KEY))!
    expect(cached.scannedAt).toBe(9000)
    expect(cached.findings).toHaveLength(1)
    expect(r.semanticCachedAt).toBe(9000)
    // D2：待决项 id 必须透出，否则 memory_confirm resolve 无法定位（decisionId 不可达）
    expect(r.pendingDecisions.items).toHaveLength(1)
    const item = r.pendingDecisions.items[0]
    expect(item.id).toMatch(/^pd_/)
    expect(item.memoryIds.sort()).toEqual(['mem_a', 'mem_b'])
    expect(item.summary).toBe('互相矛盾')
    expect(item.isNew).toBe(true)
  })

  it('同一冲突再次 scan 不重复建待决项（existing 计数），items 仍带该 id 但 isNew=false', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => conflictLlm })
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.store.put(record({ id: 'mem_b' }))
    const r1 = await scanSingle({}, deps)
    const firstId = r1.pendingDecisions.items[0].id
    const r2 = await scanSingle({}, deps)
    expect(r2.pendingDecisions.created).toBe(0)
    expect(r2.pendingDecisions.existing).toBe(1)
    expect(await deps.decisions.list()).toHaveLength(1)
    expect(r2.pendingDecisions.items).toHaveLength(1)
    expect(r2.pendingDecisions.items[0].id).toBe(firstId)
    expect(r2.pendingDecisions.items[0].isNew).toBe(false)
  })

  it('llm 为 null 时语义层跳过并留 note', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a' }))
    const r = await scanSingle({}, deps)
    expect(r.notes.map(n => n.code)).toContain('semantic-unavailable')
  })

  it('语义分析两次解析失败：failed note，缓存不写', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => '不是 JSON' }) })
    await deps.store.put(record({ id: 'mem_a' }))
    const r = await scanSingle({}, deps)
    expect(r.notes.map(n => n.code)).toContain('semantic-failed')
    expect(await deps.cache.get(GLOBAL_CACHE_KEY)).toBeUndefined()
  })

  it('scope 限定时按 visible 语义扫描（global + 该 workspace），stats.clean 为无问题记忆数', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/a', validTo: 1 }))
    await deps.store.put(record({ id: 'mem_g', scope: 'global', validTo: 1 }))
    await deps.store.put(record({ id: 'mem_other', scope: 'workspace', workspacePath: '/b', validTo: 1 }))
    await deps.store.put(record({ id: 'mem_ok', scope: 'workspace', workspacePath: '/a' }))
    const r = await scanSingle({ scope: '/a', layers: 'rule' }, deps)
    // global 记忆在该 workspace 同样生效，必须纳入；别的 workspace 的不纳入
    expect(r.stats.scanned).toBe(3)
    expect(r.findings.map(f => f.memoryIds[0]).sort()).toEqual(['mem_g', 'mem_w'])
    expect(r.stats.clean).toBe(1)
  })

  it('规则层扫描输出包含 malformed finding；空 memoryIds 不影响 stats.clean', async () => {
    const { root, store } = await fileBackedStore({ [`${GLOBAL_DIR}/broken.md`]: '---\ntype: preference\n---\n\n缺 name\n' })
    const deps = makeDeps({ store })
    await deps.store.put(record({ id: 'mem_ok' }))
    const r = await scanSingle({ layers: 'rule' }, deps)
    const malformed = r.findings.find(f => f.type === 'malformed')
    expect(malformed).toBeDefined()
    expect(malformed!.memoryIds).toEqual([])
    expect(malformed!.summary).toContain(join(root, GLOBAL_DIR, 'broken.md'))
    // malformed 无对应记录，memoryIds 为空，不进 problemIds——mem_ok 仍算 clean
    expect(r.stats.clean).toBe(1)
    expect(r.stats.issues).toBe(1)
  })

  it('layers=semantic 且无 llm 时如实说明未执行任何检测', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a' }))
    const r = await scanSingle({ layers: 'semantic' }, deps)
    expect(r.findings).toEqual([])
    expect(r.notes.map(n => n.code)).toContain('no-layer-executed')
  })

  it('语义分析失败时不覆盖已有的好缓存', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => '不是 JSON' }) })
    await deps.store.put(record({ id: 'mem_a' }))
    await deps.cache.put(GLOBAL_CACHE_KEY, {
      id: GLOBAL_CACHE_KEY, scannedAt: 500, scope: 'global',
      findings: [{ type: 'unclear', layer: 'semantic', severity: 'info', memoryIds: ['mem_a'], summary: '旧发现', suggestedAction: 'a' }],
    })
    const r = await scanSingle({}, deps)
    expect(r.notes.map(n => n.code)).toContain('semantic-failed')
    const cached = (await deps.cache.get(GLOBAL_CACHE_KEY))!
    expect(cached.scannedAt).toBe(500)
    expect(cached.findings[0].summary).toBe('旧发现')
    expect(r.semanticCachedAt).toBe(500)
  })

  it('垂直冲突把 baselineRef 带进待决账本；横向冲突则该键完全不存在', async () => {
    const verticalLlm = {
      complete: async () => JSON.stringify({
        findings: [{ type: 'conflict', memoryIds: ['mem_a'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾', suggestedAction: '裁决' }],
      }),
    }
    const deps = makeDeps({ getLlm: (_exec: unknown) => verticalLlm })
    await deps.store.put(record({ id: 'mem_a' }))
    await scanSingle({}, deps)
    const entry = (await deps.decisions.list())[0]
    expect(entry.baselineRef).toBe('AGENTS.md：包管理')

    // 横向冲突：baselineRef 键必须整个不存在，不能是值为 undefined 的键
    const deps2 = makeDeps({ getLlm: (_exec: unknown) => conflictLlm })
    await deps2.store.put(record({ id: 'mem_a' }))
    await deps2.store.put(record({ id: 'mem_b' }))
    await scanSingle({}, deps2)
    expect(Object.keys((await deps2.decisions.list())[0])).not.toContain('baselineRef')
  })

  it('记忆超出一批的预算：分批检查，note 带 semantic-batched 与批数，每条都查过，语义层照常完成', async () => {
    const users: string[] = []
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async ({ user }) => { users.push(user); return JSON.stringify({ findings: [] }) } }) })
    // 每条约 6,000 token，六条装不进一批
    for (let i = 0; i < 6; i++) await deps.store.put(record({ id: `mem_${i}`, content: '记'.repeat(10_000) }))
    const r = await scanSingle({ layers: 'semantic' }, deps)
    expect(users.length).toBeGreaterThan(1)
    expect(r.semanticBatches).toBe(users.length)
    expect(r.notes.find(n => n.code === 'semantic-batched')?.text).toContain(`分 ${users.length} 批`)
    expect(users.flatMap(u => [...u.matchAll(/id=(mem_\d+)/g)].map(m => m[1])).sort()).toEqual(['mem_0', 'mem_1', 'mem_2', 'mem_3', 'mem_4', 'mem_5'])
    expect(r.semanticCachedAt).toBe(9000)
  })

  it('层里没有记忆：不调用模型，按没有发现的成功扫描写缓存，不带用量', async () => {
    let calls = 0
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => { calls++; return JSON.stringify({ findings: [] }) } }) })
    const r = await scanSingle({ layers: 'semantic' }, deps)
    expect(calls).toBe(0)
    expect(r.notes.map(n => n.code)).not.toContain('semantic-failed')
    expect(r.semanticCachedAt).toBe(9000)
    expect(await deps.cache.get(GLOBAL_CACHE_KEY)).toMatchObject({ scannedAt: 9000, findings: [] })
    expect(r).not.toHaveProperty('usageTokens')
  })

  it('小库不分批：调用一次，没有分批说明、不带批数', async () => {
    let calls = 0
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => { calls++; return JSON.stringify({ findings: [] }) } }) })
    for (let i = 0; i < 250; i++) await deps.store.put(record({ id: `mem_${i}` }))
    const r = await scanSingle({ layers: 'semantic' }, deps)
    expect(calls).toBe(1)
    expect(r.notes.map(n => n.code)).not.toContain('semantic-batched')
    expect(r).not.toHaveProperty('semanticBatches')
  })

  it('用量：宿主报的 usage 合计进结果（含重试）；宿主没报时不带用量', async () => {
    let n = 0
    const metered: SemanticLlm = {
      complete: async (_input, _signal, onUsage) => { n++; onUsage?.(1000 + n); return n === 1 ? '不是 JSON' : JSON.stringify({ findings: [] }) },
    }
    const deps = makeDeps({ getLlm: (_exec: unknown) => metered })
    await deps.store.put(record({ id: 'mem_a' }))
    expect((await scanSingle({}, deps)).usageTokens).toBe(1001 + 1002)
    const silent = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async () => JSON.stringify({ findings: [] }) }) })
    await silent.store.put(record({ id: 'mem_a' }))
    expect(await scanSingle({}, silent)).not.toHaveProperty('usageTokens')
  })

  it('给模型看的文字不写用量', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => ({ complete: async (_input, _signal, onUsage) => { onUsage?.(6800); return JSON.stringify({ findings: [] }) } }) })
    await deps.store.put(record({ id: 'mem_a' }))
    const r = await scanSingle({}, deps)
    expect(r.usageTokens).toBe(6800)
    expect(renderScanResult(r)).not.toMatch(/6800|6,800|token/)
  })

  it('cacheKey：workspace 路径分桶，缺省落 global 层桶', () => {
    expect(cacheKey('/proj')).toBe('cache_/proj')
    expect(cacheKey(undefined)).toBe(GLOBAL_CACHE_KEY)
  })
})

describe('executeScan 全库体检', () => {
  /** 语义扫描与跨项目重复分析共用一个 llm：按 prompt 特征分流。 */
  const checkupLlm = {
    complete: async ({ system }: { system: string; user: string }) =>
      system.includes('global 缺位')
        ? JSON.stringify({ duplicates: [{ topic: '包管理用 pnpm', workspaces: ['/proj-a', '/proj-b'], suggestion: '提炼一条 global 偏好' }] })
        : JSON.stringify({ findings: [] }),
  }

  async function seedTwoWs(deps: ScanToolDeps) {
    await deps.store.put(record({ id: 'mem_a1', scope: 'workspace', workspacePath: '/proj-a', content: '包管理用 `pnpm`', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_b1', scope: 'workspace', workspacePath: '/proj-b', content: '这里也用 `pnpm`' }))
    await deps.store.put(record({ id: 'mem_g1' }))
  }

  it('scopes 列表：逐 workspace + global 各自扫描计分，语义缓存写各自桶', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => checkupLlm })
    await seedTwoWs(deps)
    const r = await executeScan({ scopes: ['/proj-a', '/proj-b'] }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.rows.map(row => row.layer === 'global' ? 'global' : row.workspacePath)).toEqual(['global', '/proj-a', '/proj-b'])
    expect(r.rows.every(row => row.tier === 'green')).toBe(true)
    expect((await deps.cache.get('cache_/proj-a'))?.scannedAt).toBe(9000)
    expect((await deps.cache.get('cache_/proj-b'))?.scannedAt).toBe(9000)
    expect((await deps.cache.get(GLOBAL_CACHE_KEY))?.scannedAt).toBe(9000)
  })

  it('无 AGENTS.md 基线时 note 带 baseline-missing', async () => {
    const deps = makeDeps({ getBaseline: () => null })
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all', layers: 'rule' }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.notes.map(n => n.code)).toContain('baseline-missing')
  })

  it('跨项目重复分析输出无法解析：note 带 cross-ws-failed，退用实体聚类', async () => {
    const brokenCrossLlm = {
      complete: async ({ system }: { system: string; user: string }) =>
        system.includes('global 缺位') ? '不是 JSON' : JSON.stringify({ findings: [] }),
    }
    const deps = makeDeps({ getLlm: (_exec: unknown) => brokenCrossLlm })
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all' }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.notes.map(n => n.code)).toContain('cross-ws-failed')
    expect(r.duplicates.via).toBe('entity')
  })

  it('用量：各层语义检查与跨项目重复检查的 usage 合计；分批的层批数相加', async () => {
    const calls: string[] = []
    const metered: SemanticLlm = {
      complete: async ({ system }, _signal, onUsage) => {
        const isCross = system.includes('global 缺位')
        calls.push(isCross ? 'cross' : 'semantic')
        onUsage?.(isCross ? 500 : 100)
        return isCross ? JSON.stringify({ duplicates: [] }) : JSON.stringify({ findings: [] })
      },
    }
    const deps = makeDeps({ getLlm: (_exec: unknown) => metered })
    await seedTwoWs(deps)
    // /proj-b 记忆多到要分批
    for (let i = 0; i < 6; i++) await deps.store.put(record({ id: `mem_big${i}`, scope: 'workspace', workspacePath: '/proj-b', content: '记'.repeat(10_000) }))
    const r = await executeScan({ scope: 'all' }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    const semanticCalls = calls.filter(c => c === 'semantic').length
    expect(calls.filter(c => c === 'cross')).toHaveLength(1)
    expect(r.usageTokens).toBe(semanticCalls * 100 + 500)
    // /proj-a、global 各一批，/proj-b 分了批
    expect(r.semanticBatches).toBe(semanticCalls - 2)
    const batched = r.notes.filter(n => n.code === 'semantic-batched')
    expect(batched).toHaveLength(1)
    expect(batched[0]!.text).toContain('/proj-b')
  })

  it('scope=all 自动枚举库里的全部 workspace', async () => {
    const deps = makeDeps()
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all', layers: 'rule' }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.rows).toHaveLength(3)
  })

  it('global 视角一：候选按 workspace 聚合 + 跨项目重复主题（语义层）', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => checkupLlm })
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all' }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.promoteCandidates.total).toBe(1)
    expect(r.promoteCandidates.byWorkspace[0].workspacePath).toBe('/proj-a')
    expect(r.duplicates.via).toBe('semantic')
    expect(r.duplicates.items[0].topic).toBe('包管理用 pnpm')
    expect(r.duplicates.items[0].workspaces).toEqual(['/proj-a', '/proj-b'])
  })

  it('无 LLM 时跨项目重复退用实体聚类保底（疑似级）', async () => {
    const deps = makeDeps()
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all', layers: 'rule' }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.duplicates.via).toBe('entity')
    expect(r.duplicates.items[0].topic).toBe('pnpm')  // 反引号实体在两个 ws 出现且 global 缺位
  })

  it('基线只用于当前会话所属 workspace 与 global 层：其他 ws 跳过垂直检测并留 note', async () => {
    const deps = makeDeps({
      getLlm: (_exec: unknown) => ({ complete: async () => JSON.stringify({ findings: [] }) }),
      getBaseline: () => ['# CLAUDE.md\n用 pnpm'],
      resolveContext: async () => ({ workspacePath: '/proj-a' }),
    })
    await seedTwoWs(deps)
    const r = await executeScan({ scopes: ['/proj-a', '/proj-b'] }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.notes.map(n => n.code)).toContain('baseline-session-scoped')
  })

  it('单层显式扫别的 workspace：基线不适用并留 note；扫自己不留', async () => {
    const deps = makeDeps({
      getLlm: (_exec: unknown) => ({ complete: async () => JSON.stringify({ findings: [] }) }),
      getBaseline: () => ['基线内容'],
      resolveContext: async () => ({ workspacePath: '/proj-a' }),
    })
    await seedTwoWs(deps)
    const other = await scanSingle({ scope: '/proj-b' }, deps)
    expect(other.notes.map(n => n.code)).toContain('baseline-session-scoped')
    const own = await scanSingle({ scope: '/proj-a' }, deps)
    expect(own.notes.map(n => n.code)).not.toContain('baseline-session-scoped')
  })

  it('单层 malformed 按所在目录归层，与 memory_health 同口径', async () => {
    const { store } = await fileBackedStore({
      [`${workspaceDirName('/proj-a')}/bad.md`]: '没有 frontmatter\n',
      [`${GLOBAL_DIR}/gbad.md`]: '没有 frontmatter\n',
      [`${workspaceDirName('/elsewhere')}/other.md`]: '没有 frontmatter\n',
    }, ['/proj-a', '/elsewhere'])
    const deps = makeDeps({ store, resolveContext: async () => ({ workspacePath: '/proj-a' }) })
    await deps.store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj-a' }))
    const r = await scanSingle({ layers: 'rule' }, deps)
    expect(r.findings.filter(f => f.type === 'malformed')).toHaveLength(1)
    expect(r.findings.find(f => f.type === 'malformed')!.summary).toContain('bad.md')
  })

  it('体检的 created/existing 从去重后的待决项派生：同一垂直冲突多桶复扫不虚增', async () => {
    const verticalLlm = {
      complete: async ({ user }: { system: string; user: string }) =>
        user.includes('mem_g1')
          ? JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_g1'], baselineRef: 'AGENTS.md：规则', summary: '与基线矛盾', suggestedAction: '裁决' }] })
          : JSON.stringify({ findings: [] }),
    }
    const deps = makeDeps({ getLlm: (_exec: unknown) => verticalLlm, getBaseline: () => ['基线'] })
    await seedTwoWs(deps)
    const first = await executeScan({ scope: 'all' }, deps, fakeExec())
    if (first.kind !== 'checkup') throw new Error(first.kind)
    // mem_g1 在两个 ws 的 visible 桶与 global 桶各被发现一次，dedupKey 收敛为一条
    expect(first.pendingDecisions.items).toHaveLength(1)
    expect(first.pendingDecisions.created).toBe(1)
    expect(first.pendingDecisions.existing).toBe(0)
    const second = await executeScan({ scope: 'all' }, deps, fakeExec())
    if (second.kind !== 'checkup') throw new Error(second.kind)
    expect(second.pendingDecisions.created).toBe(0)
    expect(second.pendingDecisions.existing).toBe(1)
  })

  it('体检收尾清理孤儿语义缓存桶：废弃 workspace 与历史遗留键被删，现存桶保留', async () => {
    const deps = makeDeps()
    await seedTwoWs(deps)
    await deps.cache.put('cache_/gone-ws', { id: 'cache_/gone-ws', scannedAt: 1, scope: '/gone-ws', findings: [] })
    await deps.cache.put('cache_all', { id: 'cache_all', scannedAt: 1, scope: 'all', findings: [] })
    await deps.cache.put('cache_/proj-a', { id: 'cache_/proj-a', scannedAt: 1, scope: '/proj-a', findings: [] })
    await executeScan({ scope: 'all', layers: 'rule' }, deps, fakeExec())
    expect(await deps.cache.get('cache_/gone-ws')).toBeUndefined()
    expect(await deps.cache.get('cache_all')).toBeUndefined()
    expect(await deps.cache.get('cache_/proj-a')).toBeDefined()
  })

  it('global 视角二：同一 global 记忆被 ≥2 个项目反对时聚合高亮', async () => {
    const deps = makeDeps()
    await seedTwoWs(deps)
    await deps.decisions.upsert({ memoryIds: ['mem_g1', 'mem_a1'], summary: '' }, 500)
    await deps.decisions.upsert({ memoryIds: ['mem_g1', 'mem_b1'], summary: '' }, 500)
    const r = await executeScan({ scope: 'all', layers: 'rule' }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(r.crossLayerConflicts).toHaveLength(1)
    expect(r.crossLayerConflicts[0].globalId).toBe('mem_g1')
    expect(r.crossLayerConflicts[0].workspaces).toEqual(['/proj-a', '/proj-b'])
    const text = renderScanResult(r)
    expect(text).toContain(r.crossLayerConflicts[0].globalId) // 冲突段落带真实 global id，而非锁定整句
  })

  it('用户在首个 workspace 语义扫描期间取消：抛 AbortError，剩余 workspace 不再调 LLM，无新缓存/待决', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const abortingLlm = {
      complete: async ({ user }: { system: string; user: string }): Promise<string> => {
        calls.push(user)
        controller.abort()
        throw new DOMException('memory_scan cancelled', 'AbortError')
      },
    }
    const deps = makeDeps({ getLlm: (_exec: unknown) => abortingLlm })
    await seedTwoWs(deps)
    await expect(executeScan({ scopes: ['/proj-a', '/proj-b'] }, deps, fakeExec({ signal: controller.signal })))
      .rejects.toThrow(/cancel|abort/i)
    // 首个 workspace 之外不再调用 LLM（语义 + 跨项目重复都未触及）
    expect(calls).toHaveLength(1)
    // 取消发生在写入前：scan_cache 与 pending_decisions 无新增
    expect(await deps.cache.list()).toHaveLength(0)
    expect(await deps.decisions.list()).toHaveLength(0)
  })

  it('layers=rule 体检不发跨项目重复的 LLM 调用，退用实体聚类保底', async () => {
    let calls = 0
    const countingLlm = { complete: async (): Promise<string> => { calls++; return '{"duplicates":[]}' } }
    const deps = makeDeps({ getLlm: (_exec: unknown) => countingLlm })
    await seedTwoWs(deps)
    const r = await executeScan({ scope: 'all', layers: 'rule' }, deps, fakeExec())
    if (r.kind !== 'checkup') throw new Error(r.kind)
    expect(calls).toBe(0)
    expect(r.duplicates.via).toBe('entity')
  })

  it('never-aborted signal 与不传 signal 结果一致', async () => {
    const emptyLlm = { complete: async (): Promise<string> => '{"findings":[]}' }
    const seed = async (deps: ScanToolDeps) => {
      await deps.store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj', content: '用 pnpm' }))
    }
    const depsNoSignal = makeDeps({ getLlm: (_exec: unknown) => emptyLlm })
    await seed(depsNoSignal)
    const withoutSignal = await executeScan({ scope: '/proj' }, depsNoSignal, fakeExec())

    const depsSignal = makeDeps({ getLlm: (_exec: unknown) => emptyLlm })
    await seed(depsSignal)
    const withSignal = await executeScan({ scope: '/proj' }, depsSignal, fakeExec({ signal: new AbortController().signal }))

    expect(withSignal).toEqual(withoutSignal)
  })
})

describe('renderScanResult', () => {
  it('待决冲突存在时，render 文本含 pd_ id 与 memory_confirm resolve 提示', async () => {
    const deps = makeDeps({ getLlm: (_exec: unknown) => conflictLlm })
    await deps.store.put(record({ id: 'mem_a', content: '用 pnpm' }))
    await deps.store.put(record({ id: 'mem_b', content: '用 npm' }))
    const result = await scanSingle({}, deps)
    const text = renderScanResult(result)
    expect(text).toContain(result.pendingDecisions.items[0].id)
    expect(text).toContain('memory_confirm resolve')
    expect(text).toContain(result.pendingDecisions.items[0].summary)
    // 证据下钻提示：裁决前引导回查双方出处，垂直冲突核对基线不回查
    expect(text).toContain('memory_source')
    expect(text).toMatch(/垂直冲突.*基线/)
  })

  it('无待决冲突时，render 不追加待裁决段落', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a' }))
    const result = await scanSingle({ layers: 'rule' }, deps)
    const text = renderScanResult(result)
    expect(text).not.toContain('待裁决冲突')
  })

  it('globalCandidate 记忆进 promoteCandidates + 渲染建议段（限流折叠）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    for (let i = 0; i < 6; i++) {
      await store.put(record({ id: `mem_c${i}`, scope: 'workspace', workspacePath: '/a', globalCandidate: true, summary: `候选${i}` }))
    }
    await store.put(record({ id: 'mem_plain', scope: 'workspace', workspacePath: '/a', summary: '普通' }))
    const r = await scanSingle({ scope: '/a', layers: 'rule' }, makeDeps({ store }))
    expect(r.promoteCandidates.items.length).toBe(5)  // PROMOTE_LIMIT 限流
    expect(r.promoteCandidates.more).toBe(1)
    expect(r.promoteCandidates.items.every(c => c.id.startsWith('mem_c'))).toBe(true)
    const text = renderScanResult(r)
    expect(text).toContain('建议提升全局')
    expect(text).toContain('memory_promote')
    expect(text).toContain(`另有 ${r.promoteCandidates.more} 条`) // 折叠计数取自结构化 more
    expect(text).toMatch(/memory_source.*出生语境|出生语境.*memory_source/)  // 提升前核验提示
  })

  it('无 globalCandidate 时 promoteCandidates 为空、不渲染建议段', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_x', scope: 'workspace', workspacePath: '/a', summary: '普通' }))
    const r = await scanSingle({ scope: '/a', layers: 'rule' }, makeDeps({ store }))
    expect(r.promoteCandidates.items).toEqual([])
    expect(renderScanResult(r)).not.toContain('建议提升全局')
  })
})

describe('executeScan scope 校验', () => {
  it('scope 传记忆目录名等未知值：报错并列出已知 workspace 路径，不静默扫错层', async () => {
    const deps = makeDeps({ resolveContext: async () => ({ workspacePath: '/proj' }) })
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/proj' }))
    await deps.store.put(record({ id: 'mem_o', scope: 'workspace', workspacePath: '/other' }))
    const r = await executeScan({ scope: 'proj-alpha-8641b727' }, deps, fakeExec())
    expect(r.kind).toBe('error')
    const text = renderScanResult(r)
    expect(text).toContain('proj-alpha-8641b727')
    expect(text).toContain('/proj')
    expect(text).toContain('/other')
  })

  it('体检 scopes 含未知值：整体报错（不部分扫描），"all" 字面量也不属于 scopes', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/proj' }))
    const bad = await executeScan({ scopes: ['/proj', 'proj-beta-3fb46caf'] }, deps, fakeExec())
    expect(bad.kind).toBe('error')
    const asAll = await executeScan({ scopes: ['all'] }, deps, fakeExec())
    expect(asAll.kind).toBe('error')
  })

  it('当前会话 workspace 即使还没有记忆也算合法 scope', async () => {
    const deps = makeDeps({ resolveContext: async () => ({ workspacePath: '/fresh' }) })
    await deps.store.put(record({ id: 'mem_g' }))
    const r = await scanSingle({ scope: '/fresh', layers: 'rule' }, deps)
    expect(r.workspacePath).toBe('/fresh')
  })

  it('显式扫别的 workspace：文案标注该路径而非「本项目」', async () => {
    const deps = makeDeps({ resolveContext: async () => ({ workspacePath: '/proj' }) })
    await deps.store.put(record({ id: 'mem_w', scope: 'workspace', workspacePath: '/proj' }))
    await deps.store.put(record({ id: 'mem_o', scope: 'workspace', workspacePath: '/other' }))
    const r = await scanSingle({ scope: '/other', layers: 'rule' }, deps)
    expect(r.workspacePath).toBe('/other')
    expect(r.message).toContain('/other')
    const self = await scanSingle({ scope: '/proj', layers: 'rule' }, deps)
    expect(self.workspacePath).toBe('/proj')
    expect(self.message).not.toContain('/proj') // 自己的 workspace 走「本项目」标签，不带路径
  })
})

describe('executeScan 冲突挂账与进行中的裁决', () => {
  it('语义层跑着的时候用户裁决了这对冲突（败方软删、条目 settled 记快照）：扫描结束不把它反撤成未决', async () => {
    const deps = makeDeps({ resolveContext: async () => ({ workspacePath: '/proj' }) })
    const a = record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj', content: '用 pnpm' })
    const b = record({ id: 'mem_b', scope: 'workspace', workspacePath: '/proj', content: '用 npm' })
    await deps.store.put(a)
    await deps.store.put(b)
    // 第一次扫描挂账
    await scanSingle({}, makeDeps({ ...deps, getLlm: (_exec: unknown) => conflictLlm }))
    const [entry] = await deps.decisions.list()
    expect(entry!.memoryIds.sort()).toEqual(['mem_a', 'mem_b'])

    // 第二次扫描：模型调用期间用户「以 A 为准」——条目 settled 记快照、B 软删（confirm 执行器做的事）
    const ruleMidScan: SemanticLlm = {
      complete: async () => {
        await deps.decisions.settle(entry!.id, 'keep-left', 9500, { snapshotId: 'snap_ruling' })
        await deps.store.softDelete(b)
        return JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '互相矛盾', suggestedAction: '留一条' }] })
      },
    }
    const r = await scanSingle({}, makeDeps({ ...deps, getLlm: (_exec: unknown) => ruleMidScan }))
    expect(r.findings.filter(f => f.type === 'conflict')).toEqual([])
    expect(await deps.decisions.list()).toEqual([])
    expect((await deps.decisions.listSettled()).map(d => [d.id, d.settled?.verdict, d.settled?.snapshotId])).toEqual([[entry!.id, 'keep-left', 'snap_ruling']])
  })
})

describe('executeScan 提升候选入账', () => {
  const candidates = async (deps: ScanToolDeps) => (await deps.decisions.list()).filter(d => d.kind === 'promote-candidate')
  const settledCandidates = async (deps: ScanToolDeps) => (await deps.decisions.listSettled()).filter(d => d.kind === 'promote-candidate')
  const atProj = () => makeDeps({ resolveContext: async () => ({ workspacePath: '/proj' }) })

  it('单层扫描：本项目带 globalCandidate 的记忆各挂一条 promote-candidate（memoryIds、workspaces、summary、指纹）；重扫不重复', async () => {
    const deps = atProj()
    await deps.store.put(record({ id: 'mem_c', scope: 'workspace', workspacePath: '/proj', summary: '候选摘要', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_plain', scope: 'workspace', workspacePath: '/proj' }))
    await scanSingle({ layers: 'rule' }, deps)
    const [entry, ...rest] = await candidates(deps)
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ kind: 'promote-candidate', memoryIds: ['mem_c'], workspaces: ['/proj'], summary: '候选摘要', firstSeenAt: 9000 })
    expect(entry!.fingerprint).toEqual(expect.any(String))

    await scanSingle({ layers: 'rule' }, deps)
    expect((await candidates(deps)).map(d => d.id)).toEqual([entry!.id])
  })

  it('留在本项目（settled keep-local + 清标记）后重扫不重开；同内容再被标记也不重开；内容改了重新提示', async () => {
    const deps = atProj()
    const rec = record({ id: 'mem_c', scope: 'workspace', workspacePath: '/proj', content: '用 pnpm', globalCandidate: true })
    await deps.store.put(rec)
    await scanSingle({ layers: 'rule' }, deps)
    const [entry] = await candidates(deps)
    await deps.decisions.settle(entry!.id, 'keep-local', 9000)
    const { globalCandidate: _flag, ...unflagged } = rec
    await deps.store.put(unflagged)

    await scanSingle({ layers: 'rule' }, deps)
    expect(await candidates(deps)).toEqual([])
    expect((await settledCandidates(deps)).map(d => d.id)).toEqual([entry!.id])

    await deps.store.put(rec) // 模型又标了一次，内容没变
    await scanSingle({ layers: 'rule' }, deps)
    expect(await candidates(deps)).toEqual([])

    await deps.store.put({ ...rec, content: '用 pnpm，锁文件要提交' })
    await scanSingle({ layers: 'rule' }, deps)
    expect((await candidates(deps)).map(d => d.memoryIds)).toEqual([['mem_c']])
    expect(await settledCandidates(deps)).toEqual([])
  })

  it('未决候选的记忆不再是候选（标记被清 / 已提升为全局 / 记忆没了）：重扫移除条目', async () => {
    const deps = atProj()
    const a = record({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj', globalCandidate: true })
    const b = record({ id: 'mem_b', scope: 'workspace', workspacePath: '/proj', globalCandidate: true })
    const c = record({ id: 'mem_c', scope: 'workspace', workspacePath: '/proj', globalCandidate: true })
    for (const r of [a, b, c]) await deps.store.put(r)
    await scanSingle({ layers: 'rule' }, deps)
    expect((await candidates(deps)).map(d => d.memoryIds[0]).sort()).toEqual(['mem_a', 'mem_b', 'mem_c'])

    const { globalCandidate: _a, ...aCleared } = a
    await deps.store.put(aCleared)
    const { globalCandidate: _b, workspacePath: _ws, ...bRest } = b
    await deps.store.put({ ...bRest, scope: 'global' })
    await deps.store.put({ ...c, status: 'deleted', deletedAt: 9000 })
    await scanSingle({ layers: 'rule' }, deps)
    expect(await candidates(deps)).toEqual([])
  })

  it('已提升（settled promoted）的记忆又成了本项目候选（被快照恢复回来）：重新回到待处理', async () => {
    const deps = atProj()
    await deps.store.put(record({ id: 'mem_c', scope: 'workspace', workspacePath: '/proj', globalCandidate: true }))
    await scanSingle({ layers: 'rule' }, deps)
    const [entry] = await candidates(deps)
    await deps.decisions.settle(entry!.id, 'promoted', 9000, { snapshotId: 'snap_x' })

    await scanSingle({ layers: 'rule' }, deps)
    expect((await candidates(deps)).map(d => d.id)).toEqual([entry!.id])
  })

  it('语义层跑着的时候用户在 GUI 里点了「提升」：写账本前按项目重读，不拿扫描开头的旧数据把 promoted 反撤成未决', async () => {
    const deps = atProj()
    const rec = record({ id: 'mem_c', scope: 'workspace', workspacePath: '/proj', content: '用 pnpm', globalCandidate: true })
    await deps.store.put(rec)
    await deps.store.put(record({ id: 'mem_d', scope: 'workspace', workspacePath: '/proj', content: '用 npm' }))
    await scanSingle({ layers: 'rule' }, deps)
    const [entry] = await candidates(deps)

    // 语义层调用期间：条目 settled 为 promoted、记忆变 global（commands.ts 的 promote 做的事）
    const promoteMidScan: SemanticLlm = {
      complete: async () => {
        await deps.decisions.settle(entry!.id, 'promoted', 9500, { snapshotId: 'snap_x' })
        const { globalCandidate: _flag, workspacePath, ...rest } = rec
        await deps.store.put({ ...rest, scope: 'global' }, { workspacePath })
        return '{"findings":[]}'
      },
    }
    await scanSingle({}, makeDeps({ ...deps, getLlm: (_exec: unknown) => promoteMidScan }))
    expect(await candidates(deps)).toEqual([])
    expect((await settledCandidates(deps)).map(d => [d.id, d.settled?.verdict])).toEqual([[entry!.id, 'promoted']])
  })

  it('全库体检：每个项目的候选都入账；scopes 子集不动其他项目的条目', async () => {
    const deps = makeDeps()
    await deps.store.put(record({ id: 'mem_a1', scope: 'workspace', workspacePath: '/proj-a', globalCandidate: true }))
    await deps.store.put(record({ id: 'mem_b1', scope: 'workspace', workspacePath: '/proj-b', globalCandidate: true }))
    await executeScan({ scope: 'all', layers: 'rule' }, deps, fakeExec())
    expect((await candidates(deps)).map(d => [d.memoryIds[0], d.workspaces]).sort()).toEqual([['mem_a1', ['/proj-a']], ['mem_b1', ['/proj-b']]])

    // proj-b 的记忆没了，但这次只体检 proj-a：proj-b 的条目留着，等扫到它再说
    await deps.store.put(record({ id: 'mem_b1', scope: 'workspace', workspacePath: '/proj-b', status: 'deleted', deletedAt: 9000 }))
    await executeScan({ scopes: ['/proj-a'], layers: 'rule' }, deps, fakeExec())
    expect((await candidates(deps)).map(d => d.memoryIds[0]).sort()).toEqual(['mem_a1', 'mem_b1'])
  })
})

describe('体检后手改记忆文件（「打开文件」直接改，frontmatter 的 updatedAt 不动）', () => {
  const redundancyLlm = {
    complete: async () => JSON.stringify({
      findings: [{ type: 'redundancy', memoryIds: ['mem_a', 'mem_b'], summary: '说的是一回事', suggestedAction: '删一条' }],
    }),
  }

  async function scanned() {
    const { root, store } = await fileBackedStore({
      [`${GLOBAL_DIR}/a.md`]: encodeRecord(record({ id: 'mem_a', name: '甲', content: '包管理用 pnpm' }), {}),
      [`${GLOBAL_DIR}/b.md`]: encodeRecord(record({ id: 'mem_b', name: '乙', content: '统一用 pnpm 装依赖' }), {}),
    })
    const deps = makeDeps({ store, getLlm: (_exec: unknown) => redundancyLlm })
    await scanSingle({}, deps)
    const redundancy = async () => scoreLayer(deps, await prereadLayers(deps, [{ kind: 'global' }], undefined), { kind: 'global' }, 9000)
      .health.counts.redundancy
    return { root, redundancy }
  }

  it('改了其中一条的正文：那次体检的重复建议不再计', async () => {
    const { root, redundancy } = await scanned()
    expect(await redundancy()).toBe(1)
    const path = join(root, GLOBAL_DIR, 'b.md')
    await writeFile(path, (await readFile(path, 'utf8')).replace('统一用 pnpm 装依赖', 'CI 里缓存 node_modules'))
    expect(await redundancy()).toBe(0)
  })

  it('两条都没改：重复建议照常计', async () => {
    const { redundancy } = await scanned()
    expect(await redundancy()).toBe(1)
    expect(await redundancy()).toBe(1)
  })
})
