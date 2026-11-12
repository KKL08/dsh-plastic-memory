/**
 * R1 宿主契约检查：作为兄弟 cordis 插件挂进一个真实、全新安装的 dsh 宿主，经真实
 * `ctx.tools` 取 dsh-plastic-memory 的九个工具，用宿主真 Session（ctx.sessions.create，
 * cwd 走创建选项）搭 exec 直调，断言宿主层面的契约：工具注册、输出深度无损 JSON、
 * 会话/工作目录解析、落盘布局、规则层/语义层 note 码、快照回路、提升候选 dismiss、
 * 证据锚悬空降级（H9a 把落盘记录的 sessionId 改成不存在的会话）、真会话下钻（H9b 读回原文）、
 * 当轮锚来自宿主 turnBoundary 投影（H13）、外部直接写进记忆目录的文件出现在新会话第一步的快照消息里（H15）、
 * 宿主 grep 工具搜记忆根目录时顶层命中、.archive/ 不命中（H16）、
 * 带委派 header 的真子会话存入待确认记忆、检索排在主档后、溯源只限自己的会话、父会话接受后进新会话的注入（H19）。
 * 无 key 也跑的宿主服务契约：经宿主 commands 服务执行 `/memory` 命令，结果过 GUI 契约 schema；自动体检调度器在宿主计时服务登记了定时器。
 * 有 DEEPSEEK_API_KEY 且宿主能选出默认模型时再跑语义扫描与取消两项、一次真实的自动体检（H17：无会话、宿主默认模型）、
 * 一次带出处的处理建议（H20：两条记忆的出处从真会话读回，交给真模型），否则标 SKIPPED。
 * run.sh 随后用同一个 DSH_HOME 再起一次宿主（HOST_CONTRACT_PHASE=restart）：第一趟把
 * 恢复的记录 id 写进交接文件，第二趟跑 H12，证明恢复结果过了进程重启仍可读。
 * 指令文件按项目现读（H14）：无 key 时装好的插件取到项目的 AGENTS.md，和宿主函数直接取到的一致（agent 工具裁决旧式条目时现算的指纹不用模型，
 * 无 key 也能比）；有 key 时再在真会话里跑一轮，
 * 模型收到的指令文件正文和宿主函数返回的逐字相同。
 * 有 key 时 run.sh 再把凭据换成无效 key 起第三趟（HOST_CONTRACT_PHASE=bad-key）跑 H18：宿主报 AUTH，
 * 扫描结果和体检视图只记 hostCode、不带宿主原话；没有 key 时第一趟把 H18 标 SKIPPED。
 *
 * 只用可擦除的 TypeScript 语法（engines 要求的 Node 22.19+/24 原生 strip-types 直接加载，不需要构建）。
 */
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { memoryCommandResultSchema } from '../../src/gui/contract.ts'
import { SidecarStore } from '../../src/storage/sidecar.ts'
import { PendingDecisionsStore, baselineFingerprint, conflictFingerprint } from '../../src/governance/decisions.ts'
import { INSTRUCTION_MAX_BYTES } from '../../src/governance/instructions.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../../src/governance/schema.ts'

export const name = 'dsh-plastic-memory-host-contract'
export const inject = ['tools', 'sessions']

interface Outcome { id: string; ok: boolean; skipped?: boolean; detail: string }
type ModelOpts = { provider?: string; model?: string }
type Exec = { agent: { session: unknown; options: ModelOpts }; signal: AbortSignal }
type ToolDef = { execute(args: unknown, exec: unknown): Promise<unknown> }
type Tools = { get(name: string): ToolDef | undefined; schemas(): Array<{ name: string }> }
/** 宿主 SessionStore 的最小契约：只用到 create（建真 Session，会话 id 由宿主分配）。H19 用 meta 的委派 header 建子会话（宿主 childSessionMeta 写的同两项）。 */
type Sessions = { create(id?: string, options?: { meta?: { cwd?: string; delegationDepth?: number; parentSession?: string } }): SessionLike }
/** 宿主 Session 的最小契约：工具上下文读 header；H9b 用 append 落一条用户消息；H15 读可见历史。 */
type SessionLike = {
  header: { id: string; cwd?: string; delegationDepth?: number; parentSession?: string }; seq: number
  append(type: string, data: unknown, opts?: unknown): { seq: number }
  deriveMessages(): Array<{ source: { kind: string } }>
}
/** H15 读 pre-step 返回的 decision：只看消息来源与正文文本。 */
type DecisionLike = { kind: string; messages?: Array<{ source: { kind: string }; content: Array<{ type: string; text?: string }> }> }
/** H15 用到的宿主 agent 工厂最小契约：建真 Agent 与它的会话（不跑模型），用完由持有者销毁。 */
type Agents = { create(options: { sessionId: string; meta?: { cwd?: string } }): Promise<{ agent: { session: SessionLike }; dispose(): Promise<void> }> }

const MEMORY_BASE = { type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', tags: [] as string[] }

type SearchHitShape = { id: string; path?: unknown }
/** memory_search 每条命中都带 path：字符串、绝对路径、文件真实存在；没有命中算不通过。 */
const hitPathsAbsolute = (hits: SearchHitShape[] | undefined) =>
  (hits ?? []).length > 0 && (hits ?? []).every(h => typeof h.path === 'string' && isAbsolute(h.path) && existsSync(h.path))

/** H14 读真会话：宿主 agent 循环的状态与入队用户消息（同 followup）。 */
type RunnableAgent = { status: string; followup(message: unknown): void; session: { deriveMessages(): Array<{ source: { kind: string }; content?: Array<{ type: string; text?: string }> }> } }
/** 等 H14 真会话那一轮跑完的上限。 */
const H14_TURN_WAIT_MS = 120_000

/** 宿主 commands 服务的最小契约：按整行执行插件命令（同界面发 `/memory …`）。agent 只当作用域键和写命令生命周期事件的会话。 */
type Commands = {
  execute(agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>
}
/** cordis 公开诊断接口的最小契约：注册表里每个插件的 fiber，fiber.getEffects() 列出它名下 effect 的标签树。 */
type EffectMeta = { label: string; children: EffectMeta[] }
type Registry = { values(): Iterable<{ fibers: Iterable<{ name: string; inject: Record<string, unknown>; getEffects(): EffectMeta[] }> }> }
/** 宿主 llm 服务的最小契约：H18 直调一次拿宿主给的原始错误（码与原话），再比对插件的输出里有没有原话。 */
type LlmService = { stream(req: unknown): AsyncIterable<{ type: string; reason?: { kind: string; failure?: { code?: string; message?: string } } }> }
type CheckupCauseShape = { kind: string; hostCode?: string; message?: string }
/** 体检视图里一个范围的最小形状（与 src/gui/contract.ts 的 checkupViewSchema 同步）。 */
type CheckupScopeShape = {
  scope: { kind: string; workspacePath?: string }
  lastCheckupAt: number | null
  failure: { cause: CheckupCauseShape } | null
  modelUnavailable: CheckupCauseShape | null
  lastResult: { by: string; notes: Array<{ code: string }> } | null
}
/** 体检视图文件（与 src/gui/contract.ts 的 GUI_VIEW_DIR、GUI_CHECKUP_VIEW_FILE 同步）。 */
const CHECKUP_VIEW_PATH = ['.state', 'gui', 'checkups.json']
/** 等自动体检出结果的上限：H17 要真调一次模型，H18 只等一次被拒的请求。 */
const AUTO_CHECKUP_WAIT_MS = 180_000
const AUTO_CHECKUP_POLL_MS = 500

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
    const sessions = ctx.get('sessions') as Sessions | undefined
    if (!sessions) throw new Error('sessions service unavailable after loader.await() — host boot incomplete')
    // 宿主真 Session 搭 exec：cwd 走创建选项，会话 id 由宿主分配、live 可读（sessionQuery 优先读活会话）。
    const mkExec = (cwd: string | undefined, model: ModelOpts = {}, signal?: AbortSignal): Exec => ({
      agent: { session: sessions.create(undefined, cwd !== undefined ? { meta: { cwd } } : undefined), options: model },
      signal: signal ?? new AbortController().signal,
    })
    const home = process.env.DSH_HOME ?? ''
    const memoriesRoot = join(home, 'memories')
    const wsRoot = mkdtempSync(join(tmpdir(), 'pm-host-ws-'))
    const mkWs = (label: string) => { const d = join(wsRoot, label); mkdirSync(d, { recursive: true }); return realpathSync(d) }
    const memoryFilePath = (id: string): string | undefined => {
      for (const d of readdirSync(memoriesRoot)) {
        for (const f of readdirSync(join(memoriesRoot, d))) {
          if (!f.endsWith('.md') || f === 'MEMORY.md') continue
          const path = join(memoriesRoot, d, f)
          if (readFileSync(path, 'utf8').includes(`id: ${id}`)) return path
        }
      }
      return undefined
    }
    const readMemoryFile = (id: string): string | undefined => {
      const path = memoryFilePath(id)
      return path === undefined ? undefined : readFileSync(path, 'utf8')
    }

    // 语义层用例的前提：凭证 + 宿主可选默认模型（agentDefaultModel，自动体检无会话时也用它）
    const readDefaultModel = (): ModelOpts => {
      try {
        const dm = ctx.get('agentDefaultModel') as { currentSelection?: () => ModelOpts } | undefined
        return dm?.currentSelection?.() ?? {}
      } catch { return {} /* 无默认模型服务 */ }
    }
    const hasKey = !!process.env.DEEPSEEK_API_KEY

    /** 走界面同一条路执行一行 `/memory …`：宿主 commands 服务按整行执行。返回宿主的执行结果，宿主缺服务或命令没注册时返回原因。 */
    const runMemoryCommand = async (workspacePath: string, line: string, model: ModelOpts = {}): Promise<{ kind: string; text?: string } | string> => {
      const commands = ctx.get('commands') as Commands | undefined
      if (!commands) return '宿主缺 commands 服务'
      const agent = { session: sessions.create(undefined, { meta: { cwd: workspacePath } }), options: model }
      const r = await commands.execute(agent, line, [], new AbortController().signal)
      return r === undefined ? '/memory 命令没有注册' : r.result
    }
    /**
     * 打开一个项目的自动体检（每天），走界面同一条路：宿主 commands 服务执行 `/memory set-auto-checkup`，
     * 插件写设置表后立刻重算调度，从没体检过的项目马上到期，后台无会话、用宿主默认模型去查。
     * 会话只是命令借来写生命周期事件、解析项目的，体检本身不经过它。返回 undefined 表示命令成功，否则是原因。
     */
    const enableAutoCheckup = async (workspacePath: string): Promise<string | undefined> => {
      if (!ctx.get('timer')) return '宿主缺 timer 服务（插件的自动体检调度挂在它上面）'
      const r = await runMemoryCommand(workspacePath, `/memory set-auto-checkup ${JSON.stringify({ scope: { kind: 'workspace', workspacePath }, frequency: 1 })}`)
      if (typeof r === 'string') return r
      return r.kind === 'success' ? undefined : `set-auto-checkup → ${r.kind}: ${r.text}`
    }
    const checkupViewPath = join(memoriesRoot, ...CHECKUP_VIEW_PATH)
    /** 体检视图里这个项目的那一项；视图还没写出来或正在替换时为 undefined。 */
    const readCheckupScope = (workspacePath: string): CheckupScopeShape | undefined => {
      try {
        const view = JSON.parse(readFileSync(checkupViewPath, 'utf8')) as { scopes: CheckupScopeShape[] }
        return view.scopes.find(s => s.scope.kind === 'workspace' && s.scope.workspacePath === workspacePath)
      } catch { return undefined }
    }
    /** 等这个项目的自动体检有了结局：做完（lastResult.by === 'auto'）、没做完（failure）或模型用不了（modelUnavailable）。超时返回 undefined。 */
    const waitAutoCheckup = async (workspacePath: string): Promise<CheckupScopeShape | undefined> => {
      const deadline = Date.now() + AUTO_CHECKUP_WAIT_MS
      while (Date.now() < deadline) {
        const s = readCheckupScope(workspacePath)
        if (s !== undefined && (s.lastResult?.by === 'auto' || s.failure !== null || s.modelUnavailable !== null)) return s
        await new Promise(resolve => setTimeout(resolve, AUTO_CHECKUP_POLL_MS))
      }
      return undefined
    }
    const seedMemories = async (ws: string, label: string) => {
      for (const [n, c] of [[`${label}-1`, '部署统一跑 deploy.sh'], [`${label}-2`, '单测不 mock 数据库'], [`${label}-3`, '提交信息用英文祈使句']]) {
        await call('memory_save', { action: 'create', name: n, summary: c, content: c, ...MEMORY_BASE }, mkExec(ws))
      }
    }

    if (process.env.HOST_CONTRACT_PHASE === 'bad-key') {
      // 第三趟（只在有 key 时跑）：run.sh 把同一 DSH_HOME 的凭据换成一个格式合法、但服务端不认的 key。
      // 宿主把 401 归为 AUTH；它的原话可能回显部分凭据，插件对齐宿主不留原话：
      // 给模型的扫描结果（memory_scan）和自动体检写的体检视图里，都只有 model-unavailable + hostCode AUTH。
      await attempt('H18-AUTH-ERROR-MASKED', async () => {
        const sel = readDefaultModel()
        if (!sel.provider || !sel.model) return { ok: false, detail: `换成无效 key 后宿主未选出默认模型（agentDefaultModel.currentSelection → ${JSON.stringify(sel)}）` }
        // 先直调宿主 llm 一次，拿到它给的错误码和原话：前提是宿主确实报 AUTH，原话用来比对插件输出里没有它
        const llm = ctx.get('llm') as LlmService | undefined
        if (!llm) return { ok: false, detail: '宿主缺 llm 服务' }
        let raw: { code?: string; message?: string } = {}
        try {
          for await (const chunk of llm.stream({ provider: sel.provider, model: sel.model, system: 'ping', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] })) {
            if (chunk.type === 'finish' && chunk.reason?.kind === 'error') raw = { ...chunk.reason.failure }
          }
        } catch (e) {
          raw = { code: (e as { code?: string }).code, message: e instanceof Error ? e.message : String(e) }
        }
        if (raw.code !== 'AUTH') return { ok: false, detail: `前提不成立：无效 key 下宿主报的错误码是 ${raw.code ?? '（无）'}，不是 AUTH` }
        const rawText = raw.message ?? ''
        const leaks = (text: string) => rawText !== '' && text.includes(rawText)
        const isMaskedAuth = (cause: CheckupCauseShape | undefined) => cause?.kind === 'model-error' && cause.hostCode === 'AUTH' && cause.message === undefined

        // memory_scan：语义层被拒，说明码 model-unavailable，原因只带 hostCode
        const wsD = mkWs('d')
        await seedMemories(wsD, 'd')
        const scan = await call('memory_scan', { layers: 'full' }, mkExec(wsD, sel)) as { notes?: Array<{ code: string; cause?: CheckupCauseShape }> }
        const scanNote = (scan.notes ?? []).find(n => n.code === 'model-unavailable')
        const scanOk = isMaskedAuth(scanNote?.cause) && !leaks(JSON.stringify(scan))

        // 自动体检：同一个无效 key，体检视图记「模型用不了」，原因只带 hostCode，整份视图里没有原话
        const wsE = mkWs('e')
        await seedMemories(wsE, 'e')
        const enabled = await enableAutoCheckup(wsE)
        if (enabled !== undefined) return { ok: false, detail: `scan: note=${JSON.stringify(scanNote)} | auto: ${enabled}` }
        const auto = await waitAutoCheckup(wsE)
        const viewText = existsSync(checkupViewPath) ? readFileSync(checkupViewPath, 'utf8') : ''
        const autoOk = auto !== undefined && isMaskedAuth(auto.modelUnavailable ?? undefined) && !leaks(viewText)
        return {
          ok: scanOk && autoOk,
          detail: `raw: code=${raw.code} messageLength=${rawText.length} | scan: note=${JSON.stringify(scanNote)} rawInOutput=${leaks(JSON.stringify(scan))}`
            + ` | auto: ${auto === undefined ? `${AUTO_CHECKUP_WAIT_MS / 1000}s 内没有结局` : `modelUnavailable=${JSON.stringify(auto.modelUnavailable)} failure=${JSON.stringify(auto.failure)} rawInView=${leaks(viewText)}`}`,
        }
      })
      finish()
      return
    }

    if (process.env.HOST_CONTRACT_PHASE === 'restart') {
      // 第二趟：同一 DSH_HOME 的全新宿主进程。第一趟 H7 恢复过的记录必须从磁盘重新加载出来，
      // 可检索、active，且快照（.state/ 侧表）也过了重启——内存态在这里不存在，只能靠持久化。
      const handoff = JSON.parse(readFileSync(handoffPath ?? '', 'utf8')) as Handoff
      await attempt('H12-RESTART-READ', async () => {
        const exec = mkExec(handoff.wsA)
        const searched = await call('memory_search', { query: 'host-contract-probe' }, exec) as { hits?: SearchHitShape[] }
        const searchable = (searched.hits ?? []).some(h => h.id === handoff.savedId)
        const pathsOk = hitPathsAbsolute(searched.hits)
        const text = readMemoryFile(handoff.savedId)
        const activeOnDisk = text !== undefined && text.includes('status: active')
        const shown = await call('memory_snapshot', { action: 'show', snapshotId: handoff.snapshotId }, exec) as { kind: string; entries?: Array<{ id: string }> }
        const snapshotKept = shown.kind === 'shown' && (shown.entries ?? []).some(e => e.id === handoff.savedId)
        return { ok: searchable && pathsOk && activeOnDisk && snapshotKept, detail: `restarted host: searchable=${searchable} pathsAbsolute=${pathsOk} activeOnDisk=${activeOnDisk} snapshotKept=${snapshotKept} (snap=${handoff.snapshotId})` }
      })
      finish()
      return
    }

    const wsA = mkWs('a')
    const execA = mkExec(wsA)
    /** H14 无 key 那条里插件记下的基线指纹，带 key 那条拿它和模型收到的正文比。 */
    let h14Fingerprint: string | undefined

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

    // H4 有 cwd 会话 create 落到 workspace 作用域的 md 文件，不落 global；索引文件生成
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
      const searched = await call('memory_search', { query: 'host-contract-probe' }, execA) as { hits?: SearchHitShape[] }
      const searchable = (searched.hits ?? []).some(h => h.id === savedId)
      const pathsOk = hitPathsAbsolute(searched.hits)
      const activeOnDisk = readMemoryFile(savedId)?.includes('status: active') === true
      const ok = snap.kind === 'created' && Array.isArray(snap.missing) && forgot.ok === true && shown.kind === 'shown' && !!entry && snapshotJsonValue(shown) !== undefined
        && restored.kind === 'restored' && (restored.restored ?? []).includes(savedId) && searchable && pathsOk && activeOnDisk
      return { ok, detail: `snap=${snap.kind}/${snap.snapshotId} missing=${JSON.stringify(snap.missing)} forget.ok=${forgot.ok} shown=${shown.kind} entries=${shown.entries?.length} restored=${restored.kind}/${JSON.stringify(restored.restored)} searchable=${searchable} pathsAbsolute=${pathsOk} activeOnDisk=${activeOnDisk}` }
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

    // H9a 证据锚悬空：记忆文件是用户可编辑的 markdown——真 Session 正常保存后，把磁盘上那条记录的
    // sessionId 改成不存在的会话 id（磁盘是唯一真相，下一次工具调用直接读到），memory_source 须优雅降级不抛
    await attempt('H9a-SOURCE-DANGLING-ANCHOR', async () => {
      const exec = mkExec(wsA)
      const r = await call('memory_save', { action: 'create', name: 'dangling-probe', summary: '悬空锚', content: '指向不存在会话的证据锚', ...MEMORY_BASE }, exec) as { kind: string; record?: { id: string; source: { sessionId: string } } }
      if (r.kind !== 'saved' || !r.record) return { ok: false, detail: `save kind=${r.kind}` }
      const path = memoryFilePath(r.record.id)
      if (path === undefined) return { ok: false, detail: `record file not found for ${r.record.id}` }
      const dangling = `dangling-${Math.random().toString(36).slice(2, 8)}`
      writeFileSync(path, readFileSync(path, 'utf8').replace(`sessionId: ${r.record.source.sessionId}`, `sessionId: ${dangling}`), 'utf8')
      const s = await call('memory_source', { memoryId: r.record.id }, exec) as { kind: string; memoryId?: string; reason?: string }
      // 记录存在但其会话 id 不在 store 也未持久化：readEvent 报无此会话，工具须降级 unavailable
      // （not-found/forbidden 都是别的分支），且带回同一 memoryId
      return { ok: s.kind === 'unavailable' && s.memoryId === r.record.id && (s.reason ?? '').includes(dangling) && snapshotJsonValue(s) !== undefined, detail: `kind=${s.kind} memoryId=${s.memoryId} reason=${s.reason}` }
    })

    // H9b 证据锚下钻真会话：真 Session 里落一条用户消息，保存后 memory_source 读回原文
    await attempt('H9b-SOURCE-REAL-SESSION', async () => {
      const exec = mkExec(wsA)
      const session = exec.agent.session as SessionLike
      const probe = 'H9b 用户原话：证据锚下钻要能读到这句原文'
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: probe }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const r = await call('memory_save', { action: 'create', name: 'real-anchor', summary: '真会话锚', content: '真会话证据锚探针', ...MEMORY_BASE }, exec) as { kind: string; record?: { id: string } }
      if (r.kind !== 'saved' || !r.record) return { ok: false, detail: `save kind=${r.kind}` }
      // 会话里没有 turn/start，锚起点退回 0（整会话），默认窗口从 0 向后开到 save 时刻，覆盖到用户消息。
      const s = await call('memory_source', { memoryId: r.record.id }, exec) as { kind: string; memoryId?: string; sessionId?: string; lines?: string[] }
      // 真 live 会话可读：成功分支下钻，且能在窗口里读到落进去的用户原文
      const readOriginal = (s.lines ?? []).some(l => l.includes(probe))
      return { ok: s.kind === 'ok' && s.memoryId === r.record.id && readOriginal && snapshotJsonValue(s) !== undefined, detail: `kind=${s.kind} sessionId=${s.sessionId} readOriginal=${readOriginal} lines=${JSON.stringify(s.lines)}` }
    })

    // H13 证据锚起点来自宿主 turnBoundary 投影：先开一轮并结束，再开第二轮，起点必须落在第二个
    // turn/start（seq > 0，区分「投影正常」与「服务缺席退回 0」）；终点是 save 时刻的 session.seq - 1；
    // 下钻从起点向后开窗，命中当轮用户原话。
    await attempt('H13-ANCHOR-TURN-BOUNDARY', async () => {
      const exec = mkExec(wsA)
      const session = exec.agent.session as SessionLike
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const second = session.append('turn/start', { turn: 2 })
      const probe = 'H13 当轮用户原话：证据锚起点必须落在第二轮'
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: probe }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const r = await call('memory_save', { action: 'create', name: 'turn-anchor', summary: '当轮锚', content: '当轮证据锚探针', ...MEMORY_BASE }, exec) as { kind: string; record?: { id: string; source: { eventRange: [number, number] } } }
      if (r.kind !== 'saved' || !r.record) return { ok: false, detail: `save kind=${r.kind}` }
      const [start, end] = r.record.source.eventRange
      const s = await call('memory_source', { memoryId: r.record.id }, exec) as { kind: string; lines?: string[] }
      const hit = (s.lines ?? []).some(l => l.includes(probe))
      return {
        ok: second.seq > 0 && start === second.seq && end === session.seq - 1 && s.kind === 'ok' && hit,
        detail: `eventRange=[${start},${end}] secondTurnStart=${second.seq} sessionSeq=${session.seq} source=${s.kind} hit=${hit}`,
      }
    })

    // H15 外部写入可见、快照走本插件自己的消息：插件已在 wsA 上跑过多次操作之后，绕过工具直接往该 workspace 的记忆目录
    // 写一个手建文件（只有 name / type / 正文），再经宿主 agent 工厂建一个真 Agent（不跑模型），照 agent 循环的派发方式
    // 走第一步的 agent/pre-step（带一条用户消息；宿主其他插件的 pre-step 监听照常参与）：返回的 decision 里要有本插件的
    // 快照消息且含这条记忆，中间不经任何刷新调用。按宿主顺序先写系统提示词、再写 decision 后，可见历史第一条是系统提示词、
    // 第二条是快照；同一会话再走一次空 decision 的第二步，快照还是一份。按 .workspace 标记找目录，不依赖目录名算法。
    await attempt('H15-EXTERNAL-WRITE-INJECTED', async () => {
      const agents = ctx.get('agents') as Agents | undefined
      if (!agents) return { ok: false, detail: 'agents service unavailable' }
      const dir = readdirSync(memoriesRoot).map(d => join(memoriesRoot, d))
        .find(d => existsSync(join(d, '.workspace')) && readFileSync(join(d, '.workspace'), 'utf8').trim() === wsA)
      if (dir === undefined) return { ok: false, detail: `找不到 ${wsA} 的记忆目录` }
      const probe = 'H15 外部写入探针：新会话第一步的快照必须带上它'
      writeFileSync(join(dir, 'h15-external-probe.md'), `---\nname: h15-external-probe\ntype: preference\n---\n\n${probe}\n`)
      const handle = await agents.create({ sessionId: `h15-${Math.random().toString(36).slice(2, 8)}`, meta: { cwd: wsA } })
      try {
        const { agent } = handle
        const session = agent.session
        const bus = ctx as unknown as { waterfall(name: string, ...args: unknown[]): Promise<unknown> }
        const preStep = (step: number, messages: unknown[]) => bus.waterfall('agent/pre-step', {
          agent, messages, turn: 1, step, signal: new AbortController().signal,
        }, async () => ({ kind: 'enter', messages })) as Promise<DecisionLike>
        const said = createUserMessage({ content: [{ type: 'text', text: 'H15 用户消息' }], source: { kind: 'user' } })
        const first = await preStep(1, [said])
        const snapshot = first.messages?.find(m => m.source.kind === 'plastic-memory')
        const hasProbe = snapshot?.content.some(b => b.text?.includes(probe)) ?? false
        session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('H15 系统提示词') }, { surfaceOp: 'append' })
        for (const m of first.messages ?? []) session.append('user/message', m, { surfaceOp: 'append' })
        const order = session.deriveMessages().map(m => m.source.kind)
        await preStep(2, [])
        const snapshots = session.deriveMessages().filter(m => m.source.kind === 'plastic-memory').length
        return {
          ok: first.kind === 'enter' && hasProbe && order[0] === 'system-prompt' && order[1] === 'plastic-memory' && snapshots === 1,
          detail: `decision=${first.kind} hasProbe=${hasProbe} order=${order.join(',')} snapshotsAfterStep2=${snapshots}`,
        }
      } finally {
        await handle.dispose()
      }
    })

    // H16 宿主 grep 工具搜记忆根目录：.archive/ 是隐藏目录，宿主 grep 基于 ripgrep 且不传 --hidden，所以顶层文件命中、
    // 归档文件不命中——归档不可见靠的是宿主 grep 工具不搜隐藏目录，这里在真机复核。grep 工具不在 ctx.tools 里则 SKIPPED。
    await attempt('H16-GREP-SKIPS-ARCHIVE', async () => {
      if (tools.get('grep') === undefined) return { ok: true, skipped: true, detail: 'SKIPPED: 宿主没有注册 grep 工具' }
      const dir = readdirSync(memoriesRoot).map(d => join(memoriesRoot, d))
        .find(d => existsSync(join(d, '.workspace')) && readFileSync(join(d, '.workspace'), 'utf8').trim() === wsA)
      if (dir === undefined) return { ok: false, detail: `找不到 ${wsA} 的记忆目录` }
      const token = `H16GREPPROBE${Math.random().toString(36).slice(2, 8)}`
      writeFileSync(join(dir, 'h16-top.md'), `---\nname: h16-top\ntype: knowledge\n---\n\n${token} 顶层\n`)
      mkdirSync(join(dir, '.archive'), { recursive: true })
      writeFileSync(join(dir, '.archive', 'h16-archived.md'), `---\nname: h16-archived\ntype: knowledge\nstatus: deleted\ndeletedAt: ${new Date().toISOString()}\n---\n\n${token} 归档\n`)
      // 不带 agent：宿主 grep 对带 agent 的 exec 会经 workingDirectory.ensure 取真 Agent 的 fiber（合成 exec 没有），
      // 无 agent 时按 process.cwd() 起搜；这里搜的是绝对路径，工作目录不影响结果
      const r = await call('grep', { pattern: token, path: memoriesRoot }, { signal: new AbortController().signal } as unknown as Exec) as { matches?: Array<{ path: string; line: string }> }
      const paths = (r.matches ?? []).map(m => m.path)
      const topHit = paths.some(p => p.endsWith('h16-top.md'))
      const archiveHit = paths.some(p => p.includes('.archive'))
      return { ok: topHit && !archiveHit, detail: `topHit=${topHit} archiveHit=${archiveHit} matches=${JSON.stringify(paths)}` }
    })

    // H19 真子会话写入待确认记忆：宿主真 Session 带委派 header（delegationDepth 1、parentSession 指向父会话，宿主 childSessionMeta
    // 写的同两项），不经 subagents 服务派发。子会话先落一轮里的一条宿主 tool/result（agent-loop 同款 createToolResultMessage），再存一条：
    // 文件带 delegation、根会话经宿主 sessionQuery 解析到父会话 → 父会话检索时排在主档之后、带待确认标注 → 子会话溯源自己的记录读到
    // 工具结果原文、溯源父会话的记录回 subagent-restricted → 接受前新会话第一步的快照不带它，父会话 accept-subagent 后带。
    await attempt('H19-SUBAGENT-PENDING-LIFECYCLE', async () => {
      const agents = ctx.get('agents') as Agents | undefined
      if (!agents) return { ok: false, detail: 'agents service unavailable' }
      const ws = mkWs('h19')
      const parent = sessions.create(undefined, { meta: { cwd: ws } })
      const child = sessions.create(undefined, { meta: { cwd: ws, delegationDepth: 1, parentSession: parent.header.id } })
      const execOf = (session: SessionLike): Exec => ({ agent: { session, options: {} }, signal: new AbortController().signal })
      /** 新会话第一步的快照消息正文（同 H15 的走法），用完销毁。 */
      const firstStepSnapshot = async (): Promise<string> => {
        const handle = await agents.create({ sessionId: `h19-${Math.random().toString(36).slice(2, 8)}`, meta: { cwd: ws } })
        try {
          const bus = ctx as unknown as { waterfall(name: string, ...args: unknown[]): Promise<unknown> }
          const said = createUserMessage({ content: [{ type: 'text', text: 'H19 用户消息' }], source: { kind: 'user' } })
          const decision = await bus.waterfall('agent/pre-step', { agent: handle.agent, messages: [said], turn: 1, step: 1, signal: new AbortController().signal },
            async () => ({ kind: 'enter', messages: [said] })) as DecisionLike
          return (decision.messages ?? []).filter(m => m.source.kind === 'plastic-memory').flatMap(m => m.content.map(b => b.text ?? '')).join('\n')
        } finally {
          await handle.dispose()
        }
      }

      const token = `H19PROBE${Math.random().toString(36).slice(2, 8)}`
      const observed = `H19 工具结果：${token} 在 main 上跑 pnpm test 会挂`
      child.append('turn/start', { turn: 1 })
      child.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'h19-call' as never, content: [{ type: 'text', text: observed }], isError: false }) }, { surfaceOp: 'append' })
      type Saved = { kind: string; record?: { id: string; delegation?: { sessionId: string; depth: number; parentSessionId: string; rootSessionId?: string } } }
      const saved = await call('memory_save', { action: 'create', name: 'h19-child', summary: '子会话观察', content: `子会话看到 ${token}「主干测试会挂」`, type: 'knowledge', scope: 'workspace', sourceMode: 'environment-observed', tags: [] }, execOf(child)) as Saved
      if (saved.kind !== 'saved' || !saved.record) return { ok: false, detail: `child save kind=${saved.kind}` }
      const id = saved.record.id
      const file = readMemoryFile(id) ?? ''
      const block = /^delegation:\n((?: {2}.*\n)+)/m.exec(file)?.[1] ?? ''
      const fileOk = block.includes(`sessionId: ${child.header.id}`) && block.includes('depth: 1') && block.includes(`parentSessionId: ${parent.header.id}`)
        && block.includes(`rootSessionId: ${parent.header.id}`) && !block.includes('reviewed')

      const settled = await call('memory_save', { action: 'create', name: 'h19-main', summary: '主会话记下', content: `主会话记下 ${token}「主档」`, ...MEMORY_BASE }, execOf(parent)) as Saved
      const searched = await call('memory_search', { query: token }, execOf(parent)) as { hits?: Array<{ id: string; sourceNote: string }> }
      const order = (searched.hits ?? []).map(h => h.id)
      const pendingHit = (searched.hits ?? []).find(h => h.id === id)
      const searchOk = order.length === 2 && order[0] === settled.record?.id && order[1] === id && (pendingHit?.sourceNote ?? '').includes('子 agent 写入，未确认')

      const own = await call('memory_source', { memoryId: id }, execOf(child)) as { kind: string; lines?: string[] }
      const ownOk = own.kind === 'ok' && (own.lines ?? []).some(l => l.includes(observed) && l.includes('tool:'))
      const other = await call('memory_source', { memoryId: settled.record?.id }, execOf(child)) as { kind: string; code?: string }
      const otherOk = other.kind === 'rejected' && other.code === 'subagent-restricted'

      const beforeAccept = await firstStepSnapshot()
      const accepted = await call('memory_confirm', { action: 'accept-subagent', memoryId: id }, execOf(parent)) as { kind: string }
      const reviewedOnDisk = /^delegation:\n(?: {2}.*\n)*? {2}reviewed:\n {4}by: main\n/m.test(readMemoryFile(id) ?? '')
      const afterAccept = await firstStepSnapshot()
      const injectOk = !beforeAccept.includes(id) && afterAccept.includes(id)
      return {
        ok: fileOk && searchOk && ownOk && otherOk && accepted.kind === 'accepted' && reviewedOnDisk && injectOk,
        detail: `file.delegation=${JSON.stringify(block.trim())} fileOk=${fileOk} | search order=${JSON.stringify(order)} pendingNote=${pendingHit?.sourceNote} | `
          + `source own=${own.kind} hasToolResult=${ownOk} other=${other.kind}/${other.code} | accept=${accepted.kind} reviewedOnDisk=${reviewedOnDisk} | `
          + `injected before=${beforeAccept.includes(id)} after=${afterAccept.includes(id)}`,
      }
    })

    // 无 key 档的宿主服务契约：命令服务或计时服务变了，这两项先红，不必等带 key 的 H17
    await attempt('PA-49-COMMANDS-GUI-CONTRACT', async () => {
      const ws = mkWs('pa49')
      // 界面的解码同一套：结果正文是 JSON，过 GUI 契约的 memoryCommandResultSchema
      const decode = async (line: string) => {
        const r = await runMemoryCommand(ws, line)
        if (typeof r === 'string') return { error: r }
        let json: unknown
        try { json = JSON.parse(r.text ?? '') } catch { return { error: `${r.kind}: 正文不是 JSON: ${r.text}` } }
        const parsed = memoryCommandResultSchema.safeParse(json)
        return parsed.success ? { result: parsed.data } : { error: `不合 GUI 契约: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` }
      }
      const info = await decode('/memory info')
      const resolve = await decode(`/memory resolve ${JSON.stringify({ decisionId: 'pd_host_contract_missing', verdict: 'keep-left' })}`)
      const isInfoOk = info.result?.ok === true && info.result.cmd === 'info' && info.result.info !== undefined
      const isNotFound = info.result !== undefined && resolve.result?.ok === false && resolve.result.code === 'not-found'
      return {
        ok: isInfoOk && isNotFound,
        detail: `info: ${info.error ?? `ok=${info.result?.ok} views=${Object.keys((info.result?.ok === true && info.result.info?.views) || {}).join(',')}`}`
          + ` | resolve(不存在的条目): ${resolve.error ?? (resolve.result?.ok === false ? `code=${resolve.result.code}` : 'ok=true')}`,
      }
    })
    // 调度器启动时在宿主计时服务登记第一次检查（之后换成周期检查），插件卸载时宿主替它停掉；不调模型。
    // 宿主计时服务把定时器登记成调用方 fiber 上的 effect，标签 ctx.timeout() / ctx.interval()，经诊断接口读出来
    await attempt('PA-50-SCHEDULER-TIMER', async () => {
      const registry = (ctx as unknown as { registry: Registry }).registry
      const labels: string[] = []
      const collect = (meta: EffectMeta): void => { labels.push(meta.label); meta.children.forEach(collect) }
      let timerFibers = 0
      for (const runtime of registry.values()) {
        for (const fiber of runtime.fibers) {
          if (fiber.name !== 'dsh-plastic-memory' || !('timer' in fiber.inject)) continue
          timerFibers++
          fiber.getEffects().forEach(collect)
        }
      }
      const isRegistered = labels.some(l => l === 'ctx.timeout()' || l === 'ctx.interval()')
      return {
        ok: isRegistered,
        detail: timerFibers === 0 ? '插件名下没有依赖 timer 的 fiber（宿主计时服务改了名，或插件没拿到它）' : `effects=${labels.join(',') || '（无）'}`,
      }
    })

    // 语义层两项：需要凭证 + 宿主可选默认模型
    const sel = readDefaultModel()
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
    // 自动体检真跑一次：无会话，模型由插件自己经宿主 agentDefaultModel 选（这里的 sel 只用来判前提），
    // 和后台定时体检同一条路径（调度器认领范围、全库扫描、写完成记录和最近一次结果），体检视图里记成自动体检做完
    await attempt('H17-AUTO-CHECKUP-DEFAULT-MODEL', async () => {
      const gate = semanticGate(); if (gate) return gate
      const wsC = mkWs('c')
      await seedMemories(wsC, 'c')
      const enabled = await enableAutoCheckup(wsC)
      if (enabled !== undefined) return { ok: false, detail: enabled }
      const s = await waitAutoCheckup(wsC)
      if (s === undefined) return { ok: false, detail: `${AUTO_CHECKUP_WAIT_MS / 1000}s 内自动体检没有结局` }
      const codes = (s.lastResult?.notes ?? []).map(n => n.code)
      return {
        ok: s.lastResult?.by === 'auto' && s.lastCheckupAt !== null && s.failure === null && s.modelUnavailable === null && !codes.includes('semantic-failed'),
        detail: `by=${s.lastResult?.by} lastCheckupAt=${s.lastCheckupAt} failure=${JSON.stringify(s.failure?.cause ?? null)} modelUnavailable=${JSON.stringify(s.modelUnavailable)} notes=${codes.join(',')}`,
      }
    })
    // H20 处理建议回查出处：两条项目记忆各在一个真会话里由用户说过一句（出处里带着各自适用的目录），
    // 账本里挂一条冲突（同体检挂账：记下两条所属的项目），界面同一条路发 /memory suggest，由真模型给建议。
    // 两条都回查到出处时建议记 isSourced；输出合格式。
    await attempt('H20-SUGGESTION-SOURCES', async () => {
      const gate = semanticGate(); if (gate) return gate
      const ws = mkWs('d')
      // 两条故意说法相近（要构成冲突），结构去重会拦第二条：带 force 存
      const saveAfterSaying = async (said: string, name: string, content: string): Promise<string | undefined> => {
        const exec = mkExec(ws, sel)
        const session = exec.agent.session as SessionLike
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: said }], source: { kind: 'user' } }), { surfaceOp: 'append' })
        const r = await call('memory_save', { action: 'create', name, summary: content, content, ...MEMORY_BASE, force: true }, exec) as { kind: string; record?: { id: string } }
        return r.record?.id
      }
      const a = await saveAfterSaying('web/ 目录下的前端单元测试用 vitest，跑测试前不用起 5173 端口的 dev server', '前端单测框架', '单元测试用 vitest')
      const b = await saveAfterSaying('scripts/ 目录里的老脚本测试还在用 jest，这批先别迁', '脚本单测框架', '单元测试用 jest')
      if (a === undefined || b === undefined) return { ok: false, detail: `保存失败 a=${a} b=${b}` }
      const sidecar = new SidecarStore({ root: memoriesRoot, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
      const ledger = new PendingDecisionsStore(sidecar.pending)
      const { entry } = await ledger.upsert({ memoryIds: [a, b], summary: '单元测试框架矛盾：一条说用 vitest，一条说用 jest', workspaces: [ws, ws], fingerprint: 'h20' }, Date.now())
      const suggest = () => runMemoryCommand(ws, `/memory suggest ${JSON.stringify({ decisionId: entry.id })}`, sel)
      let r = await suggest()
      if (typeof r === 'string') return { ok: false, detail: r }
      let saved = await ledger.get(entry.id)
      // 模型偶尔给出读不出的回复，插件如实记成失败、不自动重试；这里同用户点一次「再试一次」
      if (saved?.suggestion === undefined && saved?.suggestionFailure?.cause.kind === 'unparseable') {
        r = await suggest()
        if (typeof r === 'string') return { ok: false, detail: r }
        saved = await ledger.get(entry.id)
      }
      const suggestion = saved?.suggestion
      if (suggestion === undefined) return { ok: false, detail: `suggest → ${r.kind}: ${r.text}；没有建议，失败原因=${JSON.stringify(saved?.suggestionFailure?.cause ?? null)}` }
      const draft = suggestion.ops.find(op => op.kind === 'edit')
      return {
        ok: r.kind === 'success' && suggestion.isSourced,
        detail: `action=${suggestion.action} isSourced=${suggestion.isSourced} reason=${suggestion.reason} draft=${draft === undefined ? '（无）' : draft.content}`,
      }
    })
    // H14 指令文件按项目现读：一个项目根放 AGENTS.md，另一个什么都不放；各存一条记忆、账本里各挂一条和指令文件的冲突，
    // 界面同一条路发 /memory suggest。没有指令文件的回 no-baseline；有的那个，插件记下的基线指纹要和宿主函数直接取到的正文一致
    // （模型用不了时建议没生成，原因和依据照样记在条目上；拿不到模型时只能看到它过了缺基线那一关）。
    // 不用模型的那条证据：各再挂一条没有指纹的旧式条目，经 agent 工具 memory_confirm 裁决「保留」。插件按这条记忆所在项目的指令文件
    // 现算指纹记下，它要等于按宿主函数直接取到的正文算的；没有指令文件的那个算不出，条目移出账本、不记结论。
    const loadInstructions = async (cwd: string) => {
      const { loadBaselineInstructions } = await import('@deepseek-ai/dsh-agent-instructions')
      return (await loadBaselineInstructions({ cwd, maxBytes: INSTRUCTION_MAX_BYTES }))?.text
    }
    const h14Probe = 'H14 指令文件探针：这个项目的包管理统一用 pnpm'
    const wsH14 = mkWs('h14')
    mkdirSync(join(wsH14, '.git'), { recursive: true })
    writeFileSync(join(wsH14, 'AGENTS.md'), `${h14Probe}\n`)
    await attempt('H14-INSTRUCTIONS-INSTALLED', async () => {
      const wsNone = mkWs('h14-none')
      mkdirSync(join(wsNone, '.git'), { recursive: true })
      const sidecar = new SidecarStore({ root: memoriesRoot, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema } })
      const ledger = new PendingDecisionsStore(sidecar.pending)
      const suggestIn = async (ws: string) => {
        const saved = await call('memory_save', { action: 'create', name: 'h14-npm', summary: '包管理用 npm', content: '包管理用 npm', ...MEMORY_BASE }, mkExec(ws)) as { record?: { id: string } }
        if (saved.record === undefined) return { error: 'memory_save 没存下' }
        const { entry } = await ledger.upsert({ memoryIds: [saved.record.id], baselineRef: 'AGENTS.md：包管理', summary: '记忆说 npm，AGENTS.md 说 pnpm', workspaces: [ws], fingerprint: `h14-${ws}` }, Date.now())
        const r = await runMemoryCommand(ws, `/memory suggest ${JSON.stringify({ decisionId: entry.id })}`, sel)
        if (typeof r === 'string') return { error: r }
        const parsed = memoryCommandResultSchema.safeParse(JSON.parse(r.text ?? 'null'))
        if (!parsed.success) return { error: `结果不合 GUI 契约: ${r.text}` }
        const after = await ledger.get(entry.id)
        return { result: parsed.data, basis: after?.suggestion?.basis ?? after?.suggestionFailure?.basis }
      }
      const keepIn = async (ws: string) => {
        const saved = await call('memory_save', { action: 'create', name: 'h14-keep', summary: '注释用中文', content: '注释用中文', ...MEMORY_BASE }, mkExec(ws)) as { record?: { id: string; name: string; content: string } }
        if (saved.record === undefined) return undefined
        const { entry } = await ledger.upsert({ memoryIds: [saved.record.id], baselineRef: 'AGENTS.md：注释语言', summary: '旧式条目（没有指纹）', workspaces: [ws] }, Date.now())
        await call('memory_confirm', { action: 'resolve', decisionId: entry.id, verdict: 'keep-left' }, mkExec(ws))
        const settled = (await ledger.listSettled()).find(e => e.id === entry.id)
        return { record: saved.record, isOpen: await ledger.get(entry.id) !== undefined, settledFingerprint: settled?.fingerprint }
      }
      const none = await suggestIn(wsNone)
      const found = await suggestIn(wsH14)
      const keptNone = await keepIn(wsNone)
      const kept = await keepIn(wsH14)
      const direct = await loadInstructions(wsH14)
      const codeOf = (o: Awaited<ReturnType<typeof suggestIn>>) => ('error' in o ? o.error : o.result.ok ? 'ok' : o.result.code)
      const noneOk = codeOf(none) === 'no-baseline' && keptNone !== undefined && !keptNone.isOpen && keptNone.settledFingerprint === undefined
      const fingerprint = 'basis' in found ? found.basis?.baseline?.fingerprint : undefined
      h14Fingerprint = fingerprint
      const isSameText = direct !== undefined && direct.includes(h14Probe) && fingerprint === baselineFingerprint([direct])
      // 不用模型：插件现算的指纹和按宿主函数直接取到的正文算的一致，证明插件读到的就是这份 AGENTS.md
      const isKeptSame = kept !== undefined && direct !== undefined && direct.includes(h14Probe)
        && kept.settledFingerprint === conflictFingerprint([kept.record], [direct])
      const foundOk = isSameText || (fingerprint === undefined && codeOf(found) === 'llm-unavailable')
      return {
        ok: noneOk && foundOk && isKeptSame,
        detail: `without files: ${codeOf(none)} keep=${keptNone?.settledFingerprint === undefined && keptNone?.isOpen === false ? 'unrecorded' : 'recorded'}`
          + ` | with AGENTS.md: ${codeOf(found)} basisFingerprint=${fingerprint ?? '（没记依据）'} sameAsHostFunction=${isSameText} keepFingerprintSameAsHostFunction=${isKeptSame}`,
      }
    })
    // H14 有 key：在那个项目里开一个真会话跑一轮，宿主送进这一轮的指令文件消息正文要和宿主函数返回的逐字相同，
    // 也和插件记下的基线指纹对得上（插件对照的就是模型在这个项目里读到的那份）。
    await attempt('H14-INSTRUCTIONS-MODEL-INPUT', async () => {
      const gate = semanticGate(); if (gate) return gate
      const agents = ctx.get('agents') as { create(options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: ModelOpts }): Promise<{ agent: RunnableAgent; dispose(): Promise<void> }> } | undefined
      if (!agents) return { ok: false, detail: 'agents service unavailable' }
      // 建 agent 不带模型时这一轮在第一步之前就以「没有 provider/model」结束，指令文件也就不会进会话：用宿主默认模型
      const handle = await agents.create({ sessionId: `h14-${Math.random().toString(36).slice(2, 8)}`, meta: { cwd: wsH14 }, agentOptions: sel })
      try {
        const { agent } = handle
        agent.followup(createUserMessage({ content: [{ type: 'text', text: '只回复 ok' }], source: { kind: 'user' } }))
        const deadline = Date.now() + H14_TURN_WAIT_MS
        let hasStarted = false
        while (Date.now() < deadline) {
          if (agent.status === 'running') hasStarted = true
          else if (hasStarted) break
          await new Promise(resolve => setTimeout(resolve, AUTO_CHECKUP_POLL_MS))
        }
        const sent = agent.session.deriveMessages().filter(m => m.source.kind === 'agent-instructions')
          .map(m => (m.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join(''))
        const direct = await loadInstructions(wsH14)
        const isSame = sent.length === 1 && direct !== undefined && sent[0] === direct
        const matchesPlugin = direct !== undefined && h14Fingerprint === baselineFingerprint([direct])
        return {
          ok: isSame && matchesPlugin,
          detail: `turnFinished=${hasStarted && agent.status !== 'running'} instructionMessages=${sent.length} sameAsHostFunction=${isSame} pluginFingerprintMatches=${matchesPlugin}`
            + ` messages=${agent.session.deriveMessages().map(m => m.source.kind).join(',')}`,
        }
      } finally {
        await handle.dispose()
      }
    })
    // H18 在第三趟（凭据换成无效 key）跑；没有 key 时第三趟不起，结果在这里标 SKIPPED
    if (!hasKey) push({ id: 'H18-AUTH-ERROR-MASKED', ok: true, skipped: true, detail: 'SKIPPED: 无 DEEPSEEK_API_KEY' })
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
