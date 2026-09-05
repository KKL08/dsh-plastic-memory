/**
 * R1 宿主契约检查：作为兄弟 cordis 插件挂进一个真实、全新安装的 dsh 宿主，经真实
 * `ctx.tools` 取 dsh-plastic-memory 的九个工具，用合成 exec（会话身份 + cwd）直调，
 * 断言宿主层面的契约：工具注册、输出深度无损 JSON、会话/工作目录解析、落盘布局、
 * 规则层/语义层 note 码、快照回路、提升候选 dismiss、证据锚悬空降级。
 * 有 DEEPSEEK_API_KEY 且宿主能选出默认模型时再跑语义扫描与取消两项，否则标 SKIPPED。
 * run.sh 随后用同一个 DSH_HOME 再起一次宿主（HOST_CONTRACT_PHASE=restart）：第一趟把
 * 恢复的记录 id 写进交接文件，第二趟只跑 H12，证明恢复结果过了进程重启仍可读。
 *
 * 只用可擦除的 TypeScript 语法（engines 要求的 Node 22.19+/24 原生 strip-types 直接加载，不需要构建）。
 */
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-plastic-memory-host-contract'
export const inject = ['tools']

interface Outcome { id: string; ok: boolean; skipped?: boolean; detail: string }
type Exec = { agent: { session: { header: { id: string; cwd?: string }; events: Array<{ type: string; seq: number }>; requestHeader: () => undefined }; options: { provider?: string; model?: string } }; signal: AbortSignal }
type ToolDef = { execute(args: unknown, exec: unknown): Promise<unknown> }
type Tools = { get(name: string): ToolDef | undefined; schemas(): Array<{ name: string }> }

function mkExec(cwd: string | undefined, model: { provider?: string; model?: string } = {}, signal?: AbortSignal): Exec {
  const header: { id: string; cwd?: string } = { id: `sess-${Math.random().toString(36).slice(2, 8)}` }
  if (cwd !== undefined) header.cwd = cwd
  return {
    agent: { session: { header, events: [{ type: 'turn/start', seq: 0 }], requestHeader: () => undefined }, options: model },
    signal: signal ?? new AbortController().signal,
  }
}

const MEMORY_BASE = { type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', tags: [] as string[] }

/** 第一趟写、第二趟读的交接内容：重启后要重新读取的记录与它所属的 workspace。 */
interface Handoff { savedId: string; wsA: string; snapshotId: string | undefined }

async function run(ctx: Context, exit: (code: number) => void): Promise<void> {
  const outcomes: Outcome[] = []
  const push = (o: Outcome) => { outcomes.push(o) }
  const attempt = async (id: string, fn: () => Promise<{ ok: boolean; detail: string; skipped?: boolean }>) => {
    try { push({ id, ...(await fn()) }) } catch (e) { push({ id, ok: false, detail: `异常: ${e instanceof Error ? e.stack ?? e.message : String(e)}` }) }
  }
  const finish = () => {
    const out = process.env.HOST_CONTRACT_OUT
    if (out) writeFileSync(out, JSON.stringify(outcomes, null, 2))
    process.stdout.write(`\n===HOST-CONTRACT-RESULTS===\n${JSON.stringify(outcomes, null, 2)}\n===END===\n`)
    exit(outcomes.every(o => o.ok) ? 0 : 1)
  }
  const handoffPath = process.env.HOST_CONTRACT_HANDOFF
  let snapshotId: string | undefined
  try {
    await (ctx.get('loader') as { await(): Promise<void> } | undefined)?.await()
    const tools = ctx.get('tools') as Tools | undefined
    if (!tools) throw new Error('tools service unavailable after loader.await() — host boot incomplete (check credentials/plugin load errors above)')
    const call = (tool: string, args: unknown, exec: Exec) => {
      const def = tools.get(tool)
      if (!def) throw new Error(`tool not found: ${tool}`)
      return def.execute(args, exec)
    }
    const home = process.env.DSH_HOME ?? ''
    const memoriesRoot = join(home, 'memories')
    const wsRoot = mkdtempSync(join(tmpdir(), 'pm-host-ws-'))
    const mkWs = (label: string) => { const d = join(wsRoot, label); mkdirSync(d, { recursive: true }); return realpathSync(d) }
    const readMemoryFile = (id: string): string | undefined => {
      for (const d of readdirSync(memoriesRoot)) {
        for (const f of readdirSync(join(memoriesRoot, d))) {
          if (!f.endsWith('.md') || f === 'MEMORY.md') continue
          const text = readFileSync(join(memoriesRoot, d, f), 'utf8')
          if (text.includes(`id: ${id}`)) return text
        }
      }
      return undefined
    }

    if (process.env.HOST_CONTRACT_PHASE === 'restart') {
      // 第二趟：同一 DSH_HOME 的全新宿主进程。第一趟 H7 恢复过的记录必须从磁盘重新加载出来，
      // 可检索、active，且快照（KV 后端）也过了重启——内存态在这里不存在，只能靠持久化。
      const handoff = JSON.parse(readFileSync(handoffPath ?? '', 'utf8')) as Handoff
      await attempt('H12-RESTART-READ', async () => {
        const exec = mkExec(handoff.wsA)
        const searched = await call('memory_search', { query: 'host-contract-probe' }, exec) as { hits?: Array<{ id: string }> }
        const searchable = (searched.hits ?? []).some(h => h.id === handoff.savedId)
        const text = readMemoryFile(handoff.savedId)
        const activeOnDisk = text !== undefined && text.includes('status: active')
        const shown = await call('memory_snapshot', { action: 'show', snapshotId: handoff.snapshotId }, exec) as { kind: string; entries?: Array<{ id: string }> }
        const snapshotKept = shown.kind === 'shown' && (shown.entries ?? []).some(e => e.id === handoff.savedId)
        return { ok: searchable && activeOnDisk && snapshotKept, detail: `restarted host: searchable=${searchable} activeOnDisk=${activeOnDisk} snapshotKept=${snapshotKept} (snap=${handoff.snapshotId})` }
      })
      finish()
      return
    }

    const wsA = mkWs('a')
    const execA = mkExec(wsA)

    // H1 九工具经真实 ctx.tools 可见
    await attempt('H1-TOOLS-REGISTERED', async () => {
      const names = tools.schemas().map(s => s.name).filter(n => n.startsWith('memory_')).sort()
      return { ok: names.length === 9, detail: `memory_* ${names.length}: ${names.join(',')}` }
    })

    // H2 无 cwd 会话 create 拒存（Ungrouped 会话不落 global）
    await attempt('H2-NO-CWD-REJECTED', async () => {
      const r = await call('memory_save', { action: 'create', name: 'no-cwd', summary: 's', content: 'c', ...MEMORY_BASE }, mkExec(undefined)) as { kind: string; code?: string }
      return { ok: r.kind === 'rejected' && r.code === 'no-workspace', detail: `kind=${r.kind} code=${r.code}` }
    })

    // H3 首次体检：从未扫描 → recommendationKinds 含 semantic-never-scanned（在任何 scan 之前）
    await attempt('H3-HEALTH-FRESH', async () => {
      const r = await call('memory_health', {}, execA) as { kind: string; score?: number; tier?: string; recommendationKinds?: string[] }
      return { ok: r.kind === 'single' && typeof r.score === 'number' && (r.recommendationKinds ?? []).includes('semantic-never-scanned'), detail: `kind=${r.kind} score=${r.score} tier=${r.tier} kinds=${JSON.stringify(r.recommendationKinds)}` }
    })

    // H4 有 cwd 会话 create 落到 workspace 桶的 md 文件，不落 global；索引文件生成
    let savedId = ''
    await attempt('H4-SAVE-LANDS-IN-WORKSPACE', async () => {
      const r = await call('memory_save', { action: 'create', name: 'host-contract-probe', summary: '契约探针', content: '由宿主契约检查写入的记录', ...MEMORY_BASE }, execA) as { kind: string; record?: { id: string; scope: string; workspacePath?: string } }
      if (r.kind !== 'saved' || !r.record) return { ok: false, detail: `kind=${r.kind}` }
      savedId = r.record.id
      const dirs = existsSync(memoriesRoot) ? readdirSync(memoriesRoot) : []
      const wsDirs = dirs.filter(d => d !== 'global')
      const found = wsDirs.filter(d => readdirSync(join(memoriesRoot, d)).some(f => f.endsWith('.md') && f !== 'MEMORY.md' && readFileSync(join(memoriesRoot, d, f), 'utf8').includes(`id: ${savedId}`)))
      const inGlobal = existsSync(join(memoriesRoot, 'global')) && readdirSync(join(memoriesRoot, 'global')).some(f => f.endsWith('.md') && readFileSync(join(memoriesRoot, 'global', f), 'utf8').includes(`id: ${savedId}`))
      const index = found.length === 1 && existsSync(join(memoriesRoot, found[0], 'MEMORY.md')) && readFileSync(join(memoriesRoot, found[0], 'MEMORY.md'), 'utf8').includes(savedId)
      return { ok: r.record.scope === 'workspace' && found.length === 1 && !inGlobal && index, detail: `scope=${r.record.scope} wsDirs=${wsDirs.join(',')} foundIn=${found.join(',')} inGlobal=${inGlobal} indexed=${index}` }
    })

    // H5 九个工具的典型输出都通过宿主同款深度无损校验（snapshotJsonValue）
    await attempt('H5-OUTPUTS-LOSSLESS', async () => {
      const probes: Array<[string, unknown]> = [
        ['memory_search', { query: '探针' }],
        ['memory_health', {}],
        ['memory_scan', { layers: 'rule' }],
        ['memory_snapshot', { action: 'list' }],
        ['memory_promote', { ids: [] }],
        ['memory_confirm', { action: 'resolve', decisionId: 'pd_missing', verdict: 'dismiss' }],
        ['memory_source', { memoryId: 'mem_missing' }],
        ['memory_forget', { ids: ['mem_missing'], reason: '探针' }],
        ['memory_save', { action: 'create', name: 'lossless-probe', summary: 's', content: 'c', ...MEMORY_BASE }],
      ]
      const bad: string[] = []
      for (const [tool, args] of probes) {
        const r = await call(tool, args, execA)
        if (snapshotJsonValue(r) === undefined) bad.push(tool)
      }
      return { ok: bad.length === 0, detail: bad.length === 0 ? `${probes.length} 个调用全部无损` : `不无损: ${bad.join(',')}` }
    })

    // H6 规则层扫描不带语义 note；全量扫描无 LLM/无凭证时以 note 码如实说明
    await attempt('H6-SCAN-RULE-LAYER', async () => {
      const r = await call('memory_scan', { layers: 'rule' }, execA) as { kind: string; findings?: unknown[]; notes?: Array<{ code: string }> }
      const codes = (r.notes ?? []).map(n => n.code)
      const semantic = codes.filter(c => c.startsWith('semantic') || c === 'no-layer-executed')
      return { ok: r.kind === 'single' && Array.isArray(r.findings) && semantic.length === 0, detail: `kind=${r.kind} findings=${r.findings?.length} notes=${codes.join(',')}` }
    })

    // H7 快照回路：create → forget → show → restore，恢复后记录重新可检索、磁盘文件回到 active
    await attempt('H7-SNAPSHOT-ROUNDTRIP', async () => {
      const snap = await call('memory_snapshot', { action: 'create', reason: '探针' }, execA) as { kind: string; snapshotId?: string; missing?: string[] }
      snapshotId = snap.snapshotId
      const forgot = await call('memory_forget', { ids: [savedId], reason: '探针清理' }, execA) as { ok: boolean }
      const shown = await call('memory_snapshot', { action: 'show', snapshotId: snap.snapshotId }, execA) as { kind: string; entries?: Array<{ id: string }> }
      const entry = (shown.entries ?? []).find(e => e.id === savedId)
      const restored = await call('memory_snapshot', { action: 'restore', snapshotId: snap.snapshotId, memoryIds: [savedId] }, execA) as { kind: string; restored?: string[] }
      const searched = await call('memory_search', { query: 'host-contract-probe' }, execA) as { hits?: Array<{ id: string }> }
      const searchable = (searched.hits ?? []).some(h => h.id === savedId)
      const activeOnDisk = readMemoryFile(savedId)?.includes('status: active') === true
      const ok = snap.kind === 'created' && Array.isArray(snap.missing) && forgot.ok === true && shown.kind === 'shown' && !!entry && snapshotJsonValue(shown) !== undefined
        && restored.kind === 'restored' && (restored.restored ?? []).includes(savedId) && searchable && activeOnDisk
      return { ok, detail: `snap=${snap.kind}/${snap.snapshotId} missing=${JSON.stringify(snap.missing)} forget.ok=${forgot.ok} shown=${shown.kind} entries=${shown.entries?.length} restored=${restored.kind}/${JSON.stringify(restored.restored)} searchable=${searchable} activeOnDisk=${activeOnDisk}` }
    })

    // H8 模型填 global → 降级为 workspace + 提升候选；promote dismiss 清掉候选
    await attempt('H8-GLOBAL-CANDIDATE-DISMISS', async () => {
      const r = await call('memory_save', { action: 'create', name: 'global-wish', summary: '全局意图', content: '所有项目日志统一 JSON', ...MEMORY_BASE, scope: 'global' }, execA) as { kind: string; record?: { id: string; scope: string; globalCandidate?: boolean } }
      if (r.kind !== 'saved' || !r.record) return { ok: false, detail: `kind=${r.kind}` }
      const before = await call('memory_health', {}, execA) as { promoteCandidates: number }
      const p = await call('memory_promote', { ids: [r.record.id], dismiss: true }, execA) as { dismissed?: string[]; promoted?: string[] }
      const after = await call('memory_health', {}, execA) as { promoteCandidates: number }
      // health 的 promoteCandidates 直接数存储里的 globalCandidate 标记：dismiss 前 1、后 0 才算真清了
      return { ok: r.record.scope === 'workspace' && r.record.globalCandidate === true && before.promoteCandidates === 1 && (p.dismissed ?? []).includes(r.record.id) && after.promoteCandidates === 0, detail: `scope=${r.record.scope} candidate=${r.record.globalCandidate} candidatesBefore=${before.promoteCandidates} dismissed=${JSON.stringify(p.dismissed)} candidatesAfter=${after.promoteCandidates}` }
    })

    // H9 证据锚悬空（合成会话未持久化）→ memory_source 优雅降级不抛
    await attempt('H9-SOURCE-DANGLING-ANCHOR', async () => {
      const r = await call('memory_save', { action: 'create', name: 'anchor-probe', summary: '锚', content: '证据锚探针', ...MEMORY_BASE }, execA) as { kind: string; record?: { id: string } }
      if (r.kind !== 'saved' || !r.record) return { ok: false, detail: `kind=${r.kind}` }
      const s = await call('memory_source', { memoryId: r.record.id }, execA) as { kind: string; memoryId?: string; reason?: string }
      // 记录存在但其合成会话不可读：必须是 unavailable（not-found/forbidden 都是别的分支），且带回同一 memoryId
      return { ok: s.kind === 'unavailable' && s.memoryId === r.record.id && snapshotJsonValue(s) !== undefined, detail: `kind=${s.kind} memoryId=${s.memoryId} reason=${s.reason}` }
    })

    // 语义层两项：需要凭证 + 宿主可选默认模型
    let sel: { provider?: string; model?: string } = {}
    try {
      const dm = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string; model?: string } } | undefined
      sel = dm?.currentSelection?.() ?? {}
    } catch { /* 无默认模型服务 */ }
    const hasKey = !!process.env.DEEPSEEK_API_KEY
    const llmReady = hasKey && !!sel.provider && !!sel.model
    // 有 key 却选不出默认模型是宿主契约变了（agentDefaultModel 服务改名/消失），必须响亮失败，
    // 不能悄悄 SKIP 让绿色结果少验一段
    const semanticGate = (): { ok: boolean; skipped?: boolean; detail: string } | null => {
      if (llmReady) return null
      if (!hasKey) return { ok: true, skipped: true, detail: 'SKIPPED: 无 DEEPSEEK_API_KEY' }
      return { ok: false, detail: `有 DEEPSEEK_API_KEY 但宿主未选出默认模型（agentDefaultModel.currentSelection → ${JSON.stringify(sel)}）` }
    }
    const wsB = mkWs('b')
    for (const [n, c] of [['b-1', '部署统一跑 deploy.sh'], ['b-2', '单测不 mock 数据库'], ['b-3', '提交信息用英文祈使句']]) {
      await call('memory_save', { action: 'create', name: n, summary: c, content: c, ...MEMORY_BASE }, mkExec(wsB, sel))
    }
    await attempt('H10-SEMANTIC-SCAN-ABORT', async () => {
      const gate = semanticGate(); if (gate) return gate
      const ac = new AbortController()
      // 规则层毫秒级完成，LLM 请求至少几百毫秒：100ms 取消落在语义请求进行中（库小时 800ms 已经扫完）
      const timer = setTimeout(() => ac.abort(new DOMException('user cancelled', 'AbortError')), 100)
      let rejected: unknown = null
      try { await call('memory_scan', { layers: 'semantic' }, mkExec(wsB, sel, ac.signal)) } catch (e) { rejected = e }
      clearTimeout(timer)
      const h = await call('memory_health', {}, mkExec(wsB, sel)) as { breakdown: { semanticLayer: { cachedAt: number | null } } }
      const isAbort = rejected instanceof Error && rejected.name === 'AbortError'
      return { ok: isAbort && h.breakdown.semanticLayer.cachedAt === null, detail: `rejected=${rejected instanceof Error ? rejected.name : String(rejected)} cachedAt=${h.breakdown.semanticLayer.cachedAt}` }
    })
    await attempt('H11-SEMANTIC-SCAN-FULL', async () => {
      const gate = semanticGate(); if (gate) return gate
      const r = await call('memory_scan', { layers: 'full' }, mkExec(wsB, sel)) as { kind: string; semanticCachedAt: number | null; notes?: Array<{ code: string }> }
      const codes = (r.notes ?? []).map(n => n.code)
      return { ok: r.kind === 'single' && typeof r.semanticCachedAt === 'number' && !codes.includes('semantic-failed') && !codes.includes('semantic-unavailable'), detail: `kind=${r.kind} cachedAt=${r.semanticCachedAt} notes=${codes.join(',')}` }
    })
    // 交接给第二趟（重启验证）：恢复过的记录 id、它的 workspace、H7 拍的快照 id
    if (handoffPath) writeFileSync(handoffPath, JSON.stringify({ savedId, wsA, snapshotId } satisfies Handoff))
  } catch (e) {
    push({ id: 'FATAL', ok: false, detail: `顶层异常: ${e instanceof Error ? e.stack : String(e)}` })
  }
  finish()
}

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined) throw new Error('host-contract: launcher must provide ctx.appExit')
  void run(ctx, exit).catch((e: unknown) => {
    process.stderr.write(`host-contract fatal: ${e instanceof Error ? e.stack : String(e)}\n`)
    exit(1)
  })
}
