import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryLogger, MemoryStore } from '../store.ts'
import type { CasKvTable } from '../kv-table.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { AgentsMdWriter } from '../storage/agents-md.ts'
import { isPendingDelegated, type MemoryRecord } from '../record-schema.ts'
import { RecordNotFoundError } from '../errors.ts'
import { detectSecrets, hasCriticalSecret, hasSecret } from '../secrets.ts'
import { computeDigest } from '../storage/frontmatter.ts'
import { candidateFingerprint, type MisplacedIgnore, type PendingDecisionsStore } from '../governance/decisions.ts'
import { isModelChange } from '../governance/undo-rules.ts'
import { editFingerprint, type SnapshotStore } from '../governance/snapshots.ts'
import { kindOf, type PendingDecision, type ScanCacheEntry, type SnapshotRecord } from '../governance/schema.ts'
import type { AdviceIgnoreStore } from '../governance/advice-ignores.ts'
import type { CheckupRecordStore } from '../governance/checkup-records.ts'
import type { AutoCheckupSettingStore } from '../governance/auto-checkups.ts'
import { executeConfirm } from '../tools/confirm.ts'
import { executeForget } from '../tools/forget.ts'
import { executePromote } from '../tools/promote.ts'
import { executeUndo, restoreDeleted, type UndoResult } from '../tools/undo.ts'
import {
  copyHistory, crossWorkspaceNote, gateRecords, locateCopy, workspaceLabel, type CrossWorkspaceRejection, type GovernanceContext,
} from '../tools/workspace-gate.ts'
import {
  GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, MEMORY_COMMAND_NAME, VIEW_BEHIND_CODES, mergeKeeperIndex, parseMemoryCommand, sessionViewFile,
  type GuiErrorCode, type MemoryCommand, type MemoryCommandResult,
} from './contract.ts'
import type { ViewWriter } from './view-writer.ts'
import { generateDraft } from './model-draft.ts'
import { processInterval, runCheckup, type IntervalTimer } from './checkup-run.ts'
import { scopeAt, scopeOfLedger, scopeOfMemory, type Scope } from '../scope.ts'
import { UNKNOWN_SESSION_ID, type ContextHost, type HostSession } from '../tools/host-session.ts'
import { scanOutcome } from './views.ts'

/**
 * `/memory` 人类命令（GUI 的动作通道）：解析契约参数 → 调现有执行器 → 返回契约 JSON 文本。
 * 自动快照、跨项目门由执行器保证；改了账本或记忆的子命令落盘后重写视图。
 * 不 import 框架包运行时：命令定义按宿主 CommandDefinition 的结构给出，由接线层交给 ctx.commands.register。
 */

export interface MemoryCommandDeps {
  memoryRoot: string
  store: MemoryStore
  decisions: PendingDecisionsStore
  snapshots: SnapshotStore
  cache: CasKvTable<ScanCacheEntry>
  /** 体检记录表：scan 做完给覆盖到的范围写完成记录（发起方界面手动）。 */
  checkups: CheckupRecordStore
  /** 自动体检设置表（set-auto-checkup 写它）。 */
  autoCheckups: AutoCheckupSettingStore
  /** set-auto-checkup 写完设置表、重写体检视图后调用：本进程的自动体检调度立刻重算。缺省不通知（没有调度器）。 */
  onAutoCheckupChanged?: () => void
  /** scan 持有范围认领期间的心跳计时；缺省用进程自己的 setInterval。 */
  heartbeat?: IntervalTimer
  /** 建议忽略表（ignore-advice / unignore-advice 写它）。 */
  ignores: AdviceIgnoreStore
  registry: TypeRegistry
  agentsMd: AgentsMdWriter
  views: Pick<ViewWriter, 'request' | 'rewriteAll' | 'collectViews' | 'requestCheckups'>
  /** 宿主会话（与工具共用同一个适配器，exec 只带 agent）：借来的会话 → workspace、子 agent 深度、会话 id；
   *  在它的 agent 上解析模型（null = 拿不到）、取它的 AGENTS.md 基线。 */
  host: ContextHost<{ workspacePath: string | undefined; delegationDepth: number; session: { id: string } }> & Pick<HostSession, 'llmOf' | 'baselineOf'>
  /** 体检开关（用时读配置）；关闭时治理类子命令返回 governance-disabled。缺省视为开启。 */
  isGovernanceEnabled?: () => boolean
  /** 旧 KV 导入是否已结清（导完且旧行已删）；缺省视为已结清。没结清时彻底删除回 failed：续传会把旧快照里的明文放回来。 */
  isLegacyImportSettled?: () => Promise<boolean>
  log?: MemoryLogger
  now?: () => number
}

/** 宿主 CommandInvocation 的结构子集。 */
export interface MemoryCommandInvocation {
  rawInput: string
  agent?: unknown
}

/** 宿主 CommandResult 的结构子集。 */
export type HostCommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** 宿主 CommandDefinition 的结构子集。 */
export interface MemoryCommandDefinition {
  name: string
  description: string
  handler: (invocation: MemoryCommandInvocation) => Promise<HostCommandResult>
}

/** 依赖体检开关的子命令（对应四个治理工具的能力）；forget / restore / hard-delete / confirm / edit-memory / merge-memories /
 *  refresh-views 不受开关影响，撤销直接改、直接合并、模型改写与替代的 undo 也不受（见 isEditUndo）。 */
// dismiss-overflow 不在此列：超限提醒在体检关闭时照样入账，忽略它不属于治理动作；
// ignore-advice / unignore-advice 同理：规则类建议在体检关闭时照样列出，忽略只是用户的处置
const GOVERNANCE_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['resolve', 'undo', 'promote', 'promote-memory', 'move-memory', 'keep-local', 'keep-local-memory', 'scan'])

/** 不写任何东西的子命令：成功后也不重写视图。 */
const READ_ONLY_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['draft-edit'])

/** 自己写视图的子命令：成功后不再按常规重写全部视图。 */
const SELF_WRITING_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['scan', 'refresh-views', 'set-auto-checkup'])

/** 改待决项的子命令，先认领条目再执行，同一条同时只跑一个（resolve、undo 由执行器 executeConfirm、executeUndo 自己认领）。 */
const CLAIMED_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['promote', 'keep-local', 'dismiss-overflow'])

type Ok = Extract<MemoryCommandResult, { ok: true }>
type Err = Extract<MemoryCommandResult, { ok: false }>

const fail = (cmd: string | undefined, code: GuiErrorCode, detail?: string, rejected?: CrossWorkspaceRejection[]): Err => ({
  ok: false, ...(cmd !== undefined ? { cmd } : {}), code,
  ...(rejected !== undefined ? { rejected: rejected.map(r => ({ id: r.id, workspacePath: r.workspacePath })) } : {}),
  ...(detail !== undefined ? { detail } : {}),
})

export function createMemoryCommand(deps: MemoryCommandDeps): MemoryCommandDefinition {
  return {
    name: MEMORY_COMMAND_NAME,
    description: 'Plastic Memory GUI actions',
    handler: async invocation => {
      let result: MemoryCommandResult
      try {
        result = await run(deps, invocation)
      } catch (error) {
        result = fail(undefined, 'failed', error instanceof Error ? error.message : String(error))
      }
      return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) }
    },
  }
}

async function run(deps: MemoryCommandDeps, invocation: MemoryCommandInvocation): Promise<MemoryCommandResult> {
  const parsed = parseMemoryCommand(invocation.rawInput)
  if (!parsed.ok) return fail(undefined, 'invalid-args', parsed.detail)
  const command = parsed.command
  const exec = { agent: invocation.agent } as unknown as ToolRunContext
  const context = await deps.host.contextOf(exec)
  if (command.cmd === 'info') return await info(deps, context.session.id)
  if (command.cmd === 'model-info') {
    const llm = deps.host.llmOf(exec)
    return llm === null ? fail(command.cmd, 'llm-unavailable', '借用的会话拿不到模型') : { ok: true, cmd: command.cmd, ...(llm.model !== undefined ? { model: llm.model } : {}) }
  }
  if (GOVERNANCE_COMMANDS.has(command.cmd) && deps.isGovernanceEnabled?.() === false && !(await isEditUndo(deps.decisions, command))) {
    return fail(command.cmd, 'governance-disabled', '体检已关闭，可在配置文件里把 governance.enabled 改成 true 打开')
  }
  if (context.delegationDepth > 0) return fail(command.cmd, 'subagent-readonly', '借用的会话是子 agent，记忆只读')
  const now = deps.now?.() ?? Date.now()
  const gov = { workspacePath: context.workspacePath }
  let result: MemoryCommandResult
  if ('decisionId' in command && CLAIMED_COMMANDS.has(command.cmd)) {
    // 两个标签页或两个宿主进程同时处理同一条（提升与留在本项目）：只让一条执行，另一条什么都不动
    const claimed = await deps.decisions.withClaim(command.decisionId, () => dispatch(deps, command, gov, exec, now))
    result = claimed.isClaimed ? claimed.value : fail(command.cmd, 'claimed', `待决项 ${command.decisionId} 正在被另一次操作处理，未做任何改动`)
  } else {
    result = await dispatch(deps, command, gov, exec, now)
  }
  // scan / refresh-views 自己做全量重写，set-auto-checkup 只重写体检视图
  if (result.ok && !SELF_WRITING_COMMANDS.has(command.cmd) && !READ_ONLY_COMMANDS.has(command.cmd)) await deps.views.request()
  // 卡片版本对不上、或要动的已经不在：界面落后于磁盘（多半是外面改过文件，视图没有文件监听），重写一次让界面换成现状
  else if (!result.ok && VIEW_BEHIND_CODES.has(result.code)) await deps.views.request()
  return result
}

/** 提升候选所在项目的那一份（同 id 在会话项目里另有一份时不动错）；旧条目没记项目时按会话定位。 */
function candidateCopy(entry: PendingDecision): { target?: Scope } {
  const label = entry.workspaces?.[0]
  const scope = label === undefined ? undefined : scopeOfLedger(label)
  return scope?.kind === 'workspace' ? { target: scope } : {}
}

/** 撤销的是直接改、直接合并、模型改写与替代：改本身不受体检开关影响，撤销也不受。 */
async function isEditUndo(decisions: PendingDecisionsStore, command: MemoryCommand): Promise<boolean> {
  return command.cmd === 'undo' && (await decisions.listSettled()).some(d => d.id === command.decisionId && (kindOf(d) === 'edit' || isModelChange(d)))
}

/** 记忆和卡片加载时的版本对不上：updatedAt 变了（插件写过），或名称、摘要、正文的摘要变了（手改过文件）。 */
function isStale(r: MemoryRecord, base: { updatedAt: number; digest: string }): boolean {
  return r.updatedAt !== base.updatedAt || computeDigest(r.name, r.summary, r.content) !== base.digest
}

/** 顺手把视图目录建出来：宿主的文件资源对「父目录还不存在」的缺失文件不跟踪之后的创建，客户端是先问 info 再订阅视图的。 */
async function info(deps: MemoryCommandDeps, sessionId: string): Promise<Ok> {
  const viewDir = join(deps.memoryRoot, GUI_VIEW_DIR)
  await mkdir(viewDir, { recursive: true })
  const at = (file: string) => join(viewDir, file)
  return {
    ok: true, cmd: 'info',
    info: {
      memoryRoot: deps.memoryRoot,
      viewDir,
      views: {
        pending: at(GUI_VIEW_FILES.pending), health: at(GUI_VIEW_FILES.health),
        library: at(GUI_VIEW_FILES.library), deleted: at(GUI_VIEW_FILES.deleted),
        checkups: at(GUI_CHECKUP_VIEW_FILE),
        ...(sessionId !== UNKNOWN_SESSION_ID ? { session: at(sessionViewFile(sessionId)) } : {}),
      },
      version: GUI_VIEW_VERSION,
    },
  }
}

async function dispatch(
  deps: MemoryCommandDeps,
  command: Exclude<MemoryCommand, { cmd: 'info' | 'model-info' }>,
  gov: GovernanceContext,
  exec: ToolRunContext,
  now: number,
): Promise<MemoryCommandResult> {
  const { cmd } = command
  const executorDeps = { store: deps.store, decisions: deps.decisions, snapshots: deps.snapshots, log: deps.log, now: () => now }
  const notFound = (what: string) => fail(cmd, 'not-found', `不存在或已处理：${what}`)
  // 撤销与最近删除的恢复：时钟现读，恢复收尾要判快照是不是途中刚过期被清扫，用命令开头的时刻判不出来
  const undoDeps = { store: deps.store, decisions: deps.decisions, snapshots: deps.snapshots, ignores: deps.ignores, now: () => deps.now?.() ?? Date.now() }
  const fromUndo = (r: UndoResult): MemoryCommandResult => (r.kind === 'error'
    ? fail(cmd, r.code, r.message, r.rejected)
    : { ok: true, cmd, decisionId: r.decisionId, memoryIds: r.restored, ...(r.snapshotId !== undefined ? { snapshotId: r.snapshotId } : {}) })

  const settledEntry = async (id: string) => (await deps.decisions.listSettled()).find(d => d.id === id)
  const openEntryOfKind = async (id: string, kind: ReturnType<typeof kindOf>): Promise<PendingDecision | Err> => {
    const entry = await deps.decisions.get(id)
    if (!entry) return notFound(id)
    if (kindOf(entry) !== kind) return fail(cmd, 'failed', `待决项 ${id} 不是 ${kind}（${kindOf(entry)}），未做任何改动`)
    return entry
  }
  const isErr = (v: unknown): v is Err => typeof v === 'object' && v !== null && 'ok' in v && v.ok === false
  /** 命令带了作用域就只认那一份，否则按借来的会话定位（当前项目优先）。 */
  const locate = (memoryId: string, scope: Scope | undefined) =>
    scope === undefined ? deps.store.get(memoryId, { workspacePath: gov.workspacePath }) : locateCopy(deps.store, memoryId, scope)

  /** 结清这次提升或留下，返回条目 id。 */
  type SettleCandidate = (verdict: 'promoted' | 'keep-local', opts: { snapshotId?: string; fingerprint?: string; misplacedIgnore?: MisplacedIgnore }) => Promise<string>
  /** 写进 AGENTS.md 后插件不再管理它：有条目就移出账本（返回它的 id），没有就什么都不记。 */
  type DropCandidate = () => Promise<string | undefined>

  /**
   * 按记忆 id 提升或留在本项目。等你决定里已有它的提升候选条目：先认领那一条，和待处理卡、体检、另一处的就地处理互斥，
   * 认领后条目仍未决、记忆仍符合条件才做，做完结清那一条。还没有条目：直接做，做成之后才记一条已结清的，
   * 账本里不留没做成的条目，体检也清不掉一条还没记的。isInPlace（对话卡片、右侧栏）时这样新记的条目标 isBornSettled，撤销时移出账本。
   */
  const isCandidateEntryOf = (e: PendingDecision, r: MemoryRecord) =>
    kindOf(e) === 'promote-candidate' && e.memoryIds[0] === r.id && e.workspaces?.[0] === r.workspacePath
  const onCandidateEntry = async (
    memoryId: string, scope: Scope | undefined, isEligible: (r: MemoryRecord) => boolean, isInPlace: boolean,
    act: (rec: MemoryRecord, settle: SettleCandidate, drop: DropCandidate) => Promise<MemoryCommandResult>,
  ): Promise<MemoryCommandResult> => {
    const seen = await locate(memoryId, scope)
    if (!seen || !isEligible(seen)) return notFound(memoryId)
    const open = (await deps.decisions.list()).find(e => isCandidateEntryOf(e, seen))
    if (open === undefined) {
      // 一步记成已结清：先记未决再结清的话，两步之间体检同步提升候选会把它当「已不是候选」清掉，撤销就找不到它
      return await act(seen, async (verdict, { fingerprint, ...opts }) => {
        // 动手期间体检刚挂进等你决定的：结清那一条，不另记一条
        const raced = (await deps.decisions.list()).find(e => isCandidateEntryOf(e, seen))
        if (raced !== undefined && await deps.decisions.settle(raced.id, verdict, now, { ...opts, ...(fingerprint !== undefined ? { fingerprint } : {}) })) return raced.id
        const entry = await deps.decisions.addSettled(
          { kind: 'promote-candidate', memoryIds: [seen.id], summary: seen.summary, workspaces: [seen.workspacePath!], fingerprint: fingerprint ?? candidateFingerprint(seen) },
          verdict, now, isInPlace ? { ...opts, isBornSettled: true } : opts,
        )
        return entry.id
      }, async () => undefined)
    }
    const claimed = await deps.decisions.withClaim(open.id, async () => {
      const rec = await locate(memoryId, scope)
      if ((await deps.decisions.get(open.id)) === undefined || !rec || !isEligible(rec)) return notFound(memoryId)
      return await act(rec, async (verdict, opts) => {
        await deps.decisions.settle(open.id, verdict, now, opts)
        return open.id
      }, async () => {
        await deps.decisions.remove(open.id)
        return open.id
      })
    })
    return claimed.isClaimed ? claimed.value : fail(cmd, 'claimed', `待决项 ${open.id} 正在被另一次操作处理，未做任何改动`)
  }
  const isProjectMemory = (r: MemoryRecord) => r.status === 'active' && r.scope === 'workspace'
  const isCandidate = (r: MemoryRecord) => isProjectMemory(r) && r.globalCandidate === true

  /**
   * 留在本项目：清掉候选标记，条目按记忆此刻的内容记指纹结清（上次体检后模型改过内容的话，账本里的旧指纹对不上，同内容再被标记会白提示一次）。
   * 顺带忽略这条记忆的「放错层」（指纹取此刻的记忆）：留下就是定了它放在本项目，可以整理里不再提、不再扣分。原本已经忽略着的不另写；
   * 写了的记进条目，撤销时只删这一条。
   */
  const keepLocal = async (
    memoryId: string, workspacePath: string | undefined, allowCrossWorkspace: boolean | undefined, settle: SettleCandidate,
    options: { target?: Scope } = {},
  ): Promise<MemoryCommandResult> => {
    const r = await executePromote(
      { confirmedIds: [memoryId], target: 'global', dismiss: true, allowCrossWorkspace },
      gov, { store: deps.store, agentsMd: deps.agentsMd, snapshots: deps.snapshots, now: () => now }, options,
    )
    if (r.rejected.length > 0) return fail(cmd, 'cross-workspace', r.message, r.rejected)
    if (r.dismissed.length === 0) return fail(cmd, 'failed', r.message)
    // 只认刚清掉标记的那一层：别层同 id 的副本不算它
    const current = await deps.store.get(memoryId, scopeAt(workspacePath))
    const written = current === undefined ? undefined : await deps.ignores.ignoreIfAbsent('misplaced', [current], now)
    const decisionId = await settle('keep-local', current === undefined ? {} : {
      fingerprint: candidateFingerprint(current),
      ...(written !== undefined ? { misplacedIgnore: { ignoredAt: written.ignoredAt, fingerprint: written.fingerprints[0]! } } : {}),
    })
    return { ok: true, cmd, decisionId, memoryIds: r.dismissed }
  }

  switch (command.cmd) {
    case 'resolve': {
      if (!(await deps.decisions.get(command.decisionId))) return notFound(command.decisionId)
      // 升级前导入的垂直冲突没有指纹，两边都留时要按基线现算
      const baseline = deps.host.baselineOf(exec)
      const r = await executeConfirm(
        { action: 'resolve', decisionId: command.decisionId, verdict: command.verdict, allowCrossWorkspace: command.allowCrossWorkspace },
        gov, executorDeps, baseline !== null ? { baseline } : {},
      )
      if (r.kind === 'error') return r.code === 'cross-workspace' ? fail(cmd, 'cross-workspace', r.message, r.rejected) : fail(cmd, r.code ?? 'failed', r.message)
      if (r.kind === 'resolved' && r.isUnrecorded) return { ok: true, cmd, decisionId: command.decisionId, isUnrecorded: true }
      if (r.kind === 'resolved' && r.isHardDeleted) return { ok: true, cmd, decisionId: command.decisionId, isHardDeleted: true }
      const snapshotId = (await settledEntry(command.decisionId))?.settled?.snapshotId
      return { ok: true, cmd, decisionId: command.decisionId, ...(snapshotId !== undefined ? { snapshotId } : {}) }
    }

    case 'undo':
      return fromUndo(await executeUndo({ decisionId: command.decisionId, allowCrossWorkspace: command.allowCrossWorkspace }, gov, undoDeps))

    case 'restore': {
      const r = await restoreDeleted({ memoryId: command.memoryId, scope: command.layer, allowCrossWorkspace: command.allowCrossWorkspace }, gov, undoDeps)
      if (r.kind === 'error') return fail(cmd, r.code, r.message, 'rejected' in r ? r.rejected : undefined)
      return { ok: true, cmd, memoryIds: r.restored, ...(r.snapshotId !== undefined ? { snapshotId: r.snapshotId } : {}), ...(r.decisionId !== undefined ? { decisionId: r.decisionId } : {}) }
    }

    case 'promote': {
      const entry = await openEntryOfKind(command.decisionId, 'promote-candidate')
      if (isErr(entry)) return entry
      const r = await executePromote(
        { confirmedIds: entry.memoryIds.slice(0, 1), target: command.target, allowCrossWorkspace: command.allowCrossWorkspace },
        gov, { store: deps.store, agentsMd: deps.agentsMd, snapshots: deps.snapshots, now: () => now }, { ...candidateCopy(entry), reviewedBy: 'user' },
      )
      if (r.rejected.length > 0) return fail(cmd, 'cross-workspace', r.message, r.rejected)
      if (r.taken.length > 0) return fail(cmd, 'target-taken', r.message)
      if (r.promoted.length === 0) return fail(cmd, 'failed', r.message)
      // 提升为全局留账供 14 天内撤销；写进 AGENTS.md 后插件不再管理它，条目移出账本
      if (command.target === 'global') await deps.decisions.settle(entry.id, 'promoted', now, r.snapshotId !== null ? { snapshotId: r.snapshotId } : {})
      else await deps.decisions.remove(entry.id)
      return { ok: true, cmd, decisionId: entry.id, memoryIds: r.promoted.map(p => p.id), ...(r.snapshotId !== null ? { snapshotId: r.snapshotId } : {}) }
    }

    case 'promote-memory': {
      // 只提升指明的那一份、且它此刻仍在项目里：已提升、已删、不存在的什么都不动；就地提升（isCandidateRequired）还要它此刻仍是候选，
      // 别处刚「留在本项目」的不再提升。去处同 promote：提升为全局留账供 14 天内撤销（按提升候选记，已在等你决定里时结清那一条），撤销走 undo；
      // 写进 AGENTS.md（含密钥的不写，回 failed）后插件不再管理它，条目移出账本
      const isInPlace = command.isCandidateRequired === true
      const target = command.target ?? 'global'
      return await onCandidateEntry(command.memoryId, command.layer, isInPlace ? isCandidate : isProjectMemory, isInPlace, async (rec, settle, drop) => {
        const r = await executePromote(
          { confirmedIds: [rec.id], target, allowCrossWorkspace: command.allowCrossWorkspace },
          gov, { store: deps.store, agentsMd: deps.agentsMd, snapshots: deps.snapshots, now: () => now },
          { target: { kind: 'workspace', workspacePath: rec.workspacePath! }, reviewedBy: 'user' },
        )
        if (r.rejected.length > 0) return fail(cmd, 'cross-workspace', r.message, r.rejected)
        if (r.taken.length > 0) return fail(cmd, 'target-taken', r.message)
        if (r.promoted.length === 0) return fail(cmd, 'failed', r.message)
        const decisionId = target === 'global' ? await settle('promoted', r.snapshotId !== null ? { snapshotId: r.snapshotId } : {}) : await drop()
        return { ok: true, cmd, ...(decisionId !== undefined ? { decisionId } : {}), memoryIds: r.promoted.map(p => p.id), ...(r.snapshotId !== null ? { snapshotId: r.snapshotId } : {}) }
      })
    }

    case 'keep-local-memory':
      // 只认此刻仍是候选的那一份：已提升、已留下、已删的什么都不动
      return await onCandidateEntry(command.memoryId, command.layer, isCandidate, true, (rec, settle) =>
        keepLocal(rec.id, rec.workspacePath, command.allowCrossWorkspace, settle, { target: { kind: 'workspace', workspacePath: rec.workspacePath! } }))

    case 'move-memory': {
      const { memoryId } = command
      if (!isAbsolute(command.workspacePath)) return fail(cmd, 'invalid-args', `目标项目不是绝对路径：${command.workspacePath}`)
      // 去掉末尾斜杠、.. 这类写法差异，之后的跨项目门、查重、落盘、记账都按这一个路径
      const workspacePath = resolve(command.workspacePath)
      // 只认全局那一份、且它此刻还在用：已移走、已删、不存在的什么都不动
      const rec = await locateCopy(deps.store, memoryId, { kind: 'global' })
      if (!rec || rec.status !== 'active') return notFound(memoryId)
      // 跨项目门按目标项目判：移过去之后它就是那个项目的记忆
      const { rejected } = gateRecords([{ id: rec.id, scope: 'workspace', workspacePath }], gov, command.allowCrossWorkspace)
      if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
      // 目标项目里已有这个 id（在用的或最近删除里的）：搬过去会盖掉或撞上它
      if ((await locateCopy(deps.store, rec.id, { kind: 'workspace', workspacePath })) !== undefined) {
        return fail(cmd, 'target-taken', `${workspacePath} 里已有记忆 ${rec.id}，未做任何改动`)
      }
      const snapshot = await deps.snapshots.capture({ operation: 'pre-update', description: `把记忆 ${rec.id} 从全局移到 ${workspacePath} 前`, records: [rec] }, now)
      // 只搬全局这一份（只认层）：内容、id、出处、时间戳不动；撞名由文件表按规则换文件名
      let written: MemoryRecord | undefined
      try {
        written = await deps.store.update(rec, (cur) => {
          if (cur.status !== 'active') throw new RecordNotFoundError(cur.id)
          return { ...cur, scope: 'workspace', workspacePath }
        }, { kind: 'global' })
      } catch (error) {
        if (!(error instanceof RecordNotFoundError)) throw error
      }
      if (written === undefined) return notFound(memoryId)
      const entry = await deps.decisions.addMove(written, { summary: rec.summary, workspace: workspacePath }, snapshot.id, now)
      const located = await deps.store.locate(rec.id, scopeAt(workspacePath))
      return { ok: true, cmd, decisionId: entry.id, memoryIds: [rec.id], snapshotId: snapshot.id, ...(located !== undefined ? { filePath: located.filePath } : {}) }
    }

    case 'keep-local': {
      const entry = await openEntryOfKind(command.decisionId, 'promote-candidate')
      if (isErr(entry)) return entry
      const workspacePath = entry.workspaces?.[0]
      // 同就地留下：只认候选所在的那一层
      return await keepLocal(entry.memoryIds[0]!, workspacePath, command.allowCrossWorkspace, async (verdict, opts) => {
        await deps.decisions.settle(entry.id, verdict, now, opts)
        return entry.id
      }, workspacePath === undefined ? {} : { target: { kind: 'workspace', workspacePath } })
    }

    case 'forget':
    case 'hard-delete': {
      const isHardDelete = command.cmd === 'hard-delete'
      if (isHardDelete) {
        if (deps.isLegacyImportSettled !== undefined && !(await deps.isLegacyImportSettled())) {
          return fail(cmd, 'failed', '旧数据迁移还没收尾（升级前的快照没导完，或宿主里的旧副本还没清掉），彻底删除暂不可用，下次启动会再试。未做任何改动')
        }
        const rec = await locate(command.memoryId, command.layer)
        if (!rec) return notFound(command.memoryId)
        if (rec.status === 'deleted') {
          // 最近删除里的一条：不等 14 天到期，现在就清掉。先清账本、再抹快照、最后物理删除归档文件（召回统计行由存储层
          // 按「哪层都没有它了」清）；中途失败时归档文件还在，重试即可，此时恢复就是普通恢复。只认它自己那一层，别层同 id 的副本不碰
          const { rejected } = gateRecords([rec], gov, command.allowCrossWorkspace)
          if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
          // 别层还有这个 id 的副本时，快照里那一层的副本是它的历史，留着
          const snapshots = await deps.snapshots.list()
          const target = scopeOfMemory(rec)
          const isPurged: (r: SnapshotRecord) => boolean = target === undefined
            ? r => r.id === rec.id
            : await copyHistory(deps.store, snapshots.flatMap(s => s.data), new Set([rec.id]), target)
          // 撤销要靠的那份快照副本马上就没了：依赖它的条目先清掉
          await deps.decisions.dropDependingOn(new Set(snapshots.filter(s => s.data.some(isPurged)).map(s => s.id)), rec.id)
          await deps.snapshots.purge(isPurged)
          // 锁内复核：定位之后被别处恢复成在用的，不删
          let isRestored = false
          if (!(await deps.store.hardDelete(rec, { at: scopeAt(rec.workspacePath) }, current => (isRestored = current.status !== 'deleted')))) {
            return isRestored ? fail(cmd, 'failed', `记忆 ${command.memoryId} 刚被恢复或改过，没有彻底删除`) : notFound(command.memoryId)
          }
          // 账本按 id 记：哪层都没有它了才清，指向它的裁决撤销随之找不到
          if ((await deps.store.get(rec.id)) === undefined) await deps.decisions.removeByMemoryIds([rec.id])
          return { ok: true, cmd, memoryIds: [rec.id] }
        }
        // 在用的只给密钥条目用：不含密钥的记忆 forget 会软删，与「彻底删除」的承诺不符
        if (!hasSecret(rec)) return fail(cmd, 'failed', `记忆 ${command.memoryId} 不含密钥，彻底删除只用于密钥条目，未做任何改动`)
      }
      // forget 承诺 14 天可撤销，含密钥的记忆却只能物理删除：只软删，含密钥的由执行器在决定删不删的那次读里交回，
      // 不动它，让界面先问用户再发 hard-delete
      const r = await executeForget(
        { ids: [command.memoryId], reason: isHardDelete ? '用户在记忆页彻底删除密钥条目' : '用户在记忆页删除', allowCrossWorkspace: command.allowCrossWorkspace },
        gov, executorDeps, { isSoftOnly: !isHardDelete, ...(command.layer !== undefined ? { target: command.layer } : {}) },
      )
      if (r.rejected.length > 0) return fail(cmd, 'cross-workspace', r.message, r.rejected)
      if ((r.skippedSecrets?.length ?? 0) > 0) return fail(cmd, 'has-secret', `记忆 ${command.memoryId} 含密钥，删除后不可恢复，未做任何改动`)
      if (!r.ok) return fail(cmd, 'not-found', r.message)
      return { ok: true, cmd, memoryIds: r.forgotten, ...(r.snapshotId !== null ? { snapshotId: r.snapshotId } : {}) }
    }

    case 'confirm': {
      const r = await executeConfirm(
        { action: 'refresh', memoryId: command.memoryId, allowCrossWorkspace: command.allowCrossWorkspace },
        gov, executorDeps, command.layer !== undefined ? { target: command.layer } : {},
      )
      if (r.kind === 'error') return r.code === 'cross-workspace' ? fail(cmd, 'cross-workspace', r.message, r.rejected) : fail(cmd, 'not-found', r.message)
      return { ok: true, cmd, memoryIds: [command.memoryId] }
    }

    case 'edit-memory':
    case 'merge-memories': {
      const refs = command.cmd === 'edit-memory' ? [command] : command.memories
      if (refs.length === 2 && refs[0]!.memoryId === refs[1]!.memoryId) return fail(cmd, 'invalid-args', `要合并的两条是同一条记忆：${refs[0]!.memoryId}`)
      // 都按页面上那一份定位，且此刻仍在用：已删、不存在的什么都不动
      const records = await Promise.all(refs.map(ref => locate(ref.memoryId, ref.layer)))
      if (!records.every(r => r?.status === 'active')) return notFound(refs.map(ref => ref.memoryId).join('、'))
      const targets = refs.map((ref, i) => ({ record: records[i]!, base: ref.base }))
      const { rejected } = gateRecords(targets.map(t => t.record), gov, command.allowCrossWorkspace)
      if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
      // 界面只遮高危密钥：确认存下的疑似密钥是原文，照常改
      if (targets.some(t => hasCriticalSecret(t.record))) return fail(cmd, 'has-secret', '含密钥的记忆不能在这里改：界面上是遮盖后的正文，保存会把占位文字写回去。未做任何改动')
      const stale = () => fail(cmd, 'stale', '这条记忆刚被改过，界面已换成最新内容。未做任何改动')
      if (targets.some(t => isStale(t.record, t.base))) return stale()
      // 与 memory_save 同口径：四个面一起查，高危直接拦，疑似等用户确认
      const { content, name, summary, tags } = command
      const hits = detectSecrets(`${content}\n${name}\n${summary}\n${tags.join(' ')}`)
      const names = (severity: 'critical' | 'suspected') => hits.filter(h => h.severity === severity).map(h => h.name).join('、')
      if (names('critical') !== '') return fail(cmd, 'secret-critical', `检测到高危密钥（${names('critical')}），未保存`)
      if (names('suspected') !== '' && command.force !== true) return fail(cmd, 'secret-suspected', `检测到疑似密钥（${names('suspected')}），未保存；确认不是密钥后带 force 重发`)

      const keepAt = targets.length === 2 ? mergeKeeperIndex([targets[0]!.record, targets[1]!.record]) : 0
      const kept = targets[keepAt]!
      const removed = targets.length === 2 ? targets[1 - keepAt]! : undefined
      // 另一条要软删：含密钥（疑似也算，同软删的口径）的软删不了，先拦下，免得保留的那条改了、另一条却删不掉
      if (removed !== undefined && hasSecret(removed.record)) {
        return fail(cmd, 'has-secret', `合并要删掉的那条（${removed.record.id}）含密钥，删除后不可恢复，不能在这里合并：先彻底删除它，或手改文件去掉密钥。未做任何改动`)
      }
      // 快照先行，项目记忆也拍（memory_save 只给全局拍），否则撤销无从兑现；合并的两条同拍一份
      const snapshot = await deps.snapshots.capture({
        operation: 'pre-update',
        description: removed === undefined ? `直接改记忆 ${kept.record.id} 前` : `直接合并 ${kept.record.id} 与 ${removed.record.id} 前`,
        records: targets.map(t => t.record),
      }, now)
      // 出处、类型、作用域、有效期、置信度、取代关系不动：这是用户亲手改的内容，不是借来的会话说的
      const own = scopeAt(kept.record.workspacePath)
      let mine: MemoryRecord | undefined
      let committed: MemoryRecord | undefined
      try {
        committed = await deps.store.update(kept.record, (cur) => {
          // 写盘前被改过时文件表会重读重来：每次都从头判，上一轮算的不算数
          mine = undefined
          // 锁内按磁盘上的现状再核对一次：读过之后被改过就原样不写
          if (cur.status !== 'active' || isStale(cur, kept.base)) return cur
          // 标手改：出处还是原来的会话，「已手编，出处可能不对应」照实；模型之后要改写、替代它得先问用户（同手改文件）
          // 子 agent 写的待确认记录：用户亲手改过就算升档；已升档的不改写升档来源
          const delegation = isPendingDelegated(cur) ? { delegation: { ...cur.delegation!, reviewed: { by: 'user' as const, at: now } } } : {}
          return (mine = { ...cur, content, name, summary, tags, updatedAt: now, lastConfirmedAt: now, handEdited: true, ...delegation })
        }, own)
      } catch (error) {
        if (!(error instanceof RecordNotFoundError)) throw error
      }
      if (mine === undefined) return stale()
      // 另一条走删除的老路：软删进最近删除，账本里指向它的条目一并清掉（同 forget）；快照上面已经拍过。
      // 锁内再按卡片版本核对一次：核对之后被改过的不删，保留的那条退回改前（之间没被别处再改的话），整体回 stale；
      // 核对之后另一个会话才写进密钥的不删（极少见），这次只算改了保留的那条
      const outcome = removed === undefined ? 'deleted'
        : await deps.store.softDeleteUnlessSecret(removed.record, { at: scopeAt(removed.record.workspacePath), now, isChanged: cur => cur.status !== 'active' || isStale(cur, removed.base) })
      if (outcome === 'changed') {
        const isMine = (cur: MemoryRecord) => cur.status === 'active' && cur.updatedAt === now && editFingerprint(cur) === editFingerprint(mine!)
        await deps.store.update(kept.record, cur => (isMine(cur) ? kept.record : cur), own).catch((error: unknown) => {
          if (!(error instanceof RecordNotFoundError)) throw error
        })
        return stale()
      }
      const isRemoved = outcome !== 'has-secret'
      if (removed !== undefined && isRemoved) await deps.decisions.removeByMemoryIds([removed.record.id])
      const memoryIds = removed !== undefined && isRemoved ? [kept.record.id, removed.record.id] : [kept.record.id]
      const entry = await deps.decisions.addEdit(committed!, {
        memoryIds, summary: name, workspaces: memoryIds.map(id => workspaceLabel(targets.find(t => t.record.id === id)!.record)),
      }, memoryIds.length === 2 ? 'merged' : 'edited', snapshot.id, now)
      if (!isRemoved) return fail(cmd, 'has-secret', `保留的那条已改好；另一条（${removed!.record.id}）刚被写进密钥，没有删除`)
      const located = await deps.store.locate(kept.record.id, own)
      return { ok: true, cmd, decisionId: entry.id, memoryIds, snapshotId: snapshot.id, ...(located !== undefined ? { filePath: located.filePath } : {}) }
    }

    case 'draft-edit': {
      const refs = command.memories
      if (refs.length === 2 && refs[0].memoryId === refs[1]!.memoryId) return fail(cmd, 'invalid-args', `要合并的两条是同一条记忆：${refs[0].memoryId}`)
      const records = await Promise.all(refs.map(ref => locate(ref.memoryId, ref.layer)))
      if (!records.every(r => r?.status === 'active')) return notFound(refs.map(ref => ref.memoryId).join('、'))
      // 高危密钥的原文不发给模型；确认存下的疑似密钥同注入，照原文发
      if (records.some(r => hasCriticalSecret(r!))) return fail(cmd, 'has-secret', '含密钥的记忆不发给模型。未做任何改动')
      // 要求、此前的要求、计划和上一稿同样进提示词；上一稿是模型回的原样，不遮，命中高危就整次不发
      const { previous, planNote } = command
      const asked = [
        command.request ?? '', ...(command.priorRequests ?? []),
        ...(planNote !== undefined ? [planNote.reason, planNote.question?.text ?? '', planNote.question?.placeholder ?? '', planNote.answer ?? ''] : []),
        ...(previous !== undefined ? [previous.content, previous.name ?? '', previous.summary, ...(previous.tags ?? [])] : []),
      ]
      if (detectSecrets(asked.join('\n')).some(h => h.severity === 'critical')) return fail(cmd, 'secret-critical', '要求、此前的要求、计划或上一稿里有高危密钥，不发给模型。未做任何改动')
      const llm = deps.host.llmOf(exec)
      if (llm === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型')
      const { adviceType, request, priorRequests } = command
      const r = await generateDraft({ adviceType, records: records.map(rec => rec!), request, priorRequests, planNote, previous }, llm)
      if (!r.ok) return fail(cmd, r.code, r.detail)
      return { ok: true, cmd, draft: r.draft, ...(llm.model !== undefined ? { model: llm.model } : {}) }
    }

    case 'dismiss-overflow': {
      const entry = await openEntryOfKind(command.decisionId, 'overflow')
      if (isErr(entry)) return entry
      await deps.decisions.settle(entry.id, 'dismiss', now)
      return { ok: true, cmd, decisionId: entry.id }
    }

    case 'ignore-advice': {
      const refs = command.memories
      const ids = refs.map(ref => ref.memoryId)
      // 内容重复是一组记忆一项，其余类型每条记忆一项
      if (command.type !== 'redundancy' && refs.length !== 1) return fail(cmd, 'invalid-args', `${command.type} 一项只对应一条记忆`)
      if (new Set(ids).size !== ids.length) return fail(cmd, 'invalid-args', `同一条记忆出现了两次：${ids.join('、')}`)
      // 只认卡片上那一份，且还是用户看到的那一版：指纹按它记
      const records = await Promise.all(refs.map(ref => locate(ref.memoryId, ref.layer)))
      if (!records.every(r => r?.status === 'active')) return notFound(ids.join('、'))
      if (refs.some((ref, i) => isStale(records[i]!, ref.base))) return fail(cmd, 'stale', '这条记忆刚被改过，界面已换成最新内容。未做任何改动')
      const entry = await deps.ignores.ignore(command.type, records.map(r => r!), now)
      return { ok: true, cmd, memoryIds: entry.memoryIds }
    }

    case 'unignore-advice':
      await deps.ignores.unignore(command.type, command.memoryIds)
      return { ok: true, cmd, memoryIds: [...command.memoryIds].sort() }

    case 'scan': {
      // 在借来的会话的 agent 上解析模型，拿不到就不扫（只跑规则层会让界面以为体检做完了）
      const llm = deps.host.llmOf(exec)
      if (llm === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型，可在对话里让 agent 体检')
      const target = command.layer !== undefined ? { kind: 'global' as const }
        : command.workspacePath !== undefined ? { kind: 'workspace' as const, workspacePath: command.workspacePath } : { kind: 'all' as const }
      const { workspacePath: currentWorkspace } = await deps.host.contextOf(exec)
      // 开跑前认领要查的范围（和自动体检共用一套认领）：正在体检就回 busy；「全部」要认领全局和每个项目，有一个认领不到整个回 busy
      const r = await runCheckup({
        target, by: 'manual', llm, baseline: deps.host.baselineOf(exec),
        ...(currentWorkspace !== undefined ? { currentWorkspace } : {}),
      }, {
        scan: { store: deps.store, registry: deps.registry, decisions: deps.decisions, cache: deps.cache, ignores: deps.ignores },
        checkups: deps.checkups, views: deps.views,
        interval: deps.heartbeat ?? processInterval,
        onClaimChanged: () => deps.views.requestCheckups(),
        // 时钟现读：完成记录的完成时间是体检做完的时刻，不是命令开始的时刻
        now: () => deps.now?.() ?? Date.now(),
        log: deps.log ?? console,
      })
      switch (r.kind) {
        case 'busy': return fail(cmd, 'busy', `${r.scope.kind === 'global' ? '全局' : r.scope.workspacePath} 正在体检，查完再来`)
        // 认领中途被别的进程接手：核心在写入检查点前停下了，这次没提交
        case 'cancelled': return fail(cmd, 'busy', '体检中途被别的进程接手，这次没有提交')
        case 'failed':
        case 'model-unavailable': return fail(cmd, 'failed', r.cause.message ?? r.cause.hostCode ?? r.cause.kind)
      }
      // 判新增的覆盖范围：项目体检读的是本项目的可见集合（全局 + 本项目），只查全局是全局，全库体检是全部作用域
      const covered = target.kind === 'global' ? [target]
        : target.kind === 'workspace' ? [{ kind: 'global' as const }, target] : 'all'
      return {
        ok: true, cmd, notes: r.notes.map(n => n.code),
        ...(r.semanticBatches !== undefined ? { semanticBatches: r.semanticBatches } : {}),
        ...(r.usageTokens !== undefined ? { usageTokens: r.usageTokens } : {}),
        ...(r.compared !== undefined ? scanOutcome(r.compared.before, r.compared.after, covered) : {}),
      }
    }

    case 'set-auto-checkup': {
      if (command.scope.kind === 'workspace' && !isAbsolute(command.scope.workspacePath)) {
        return fail(cmd, 'invalid-args', `项目路径必须是绝对路径：${command.scope.workspacePath}`)
      }
      await deps.autoCheckups.set(command.scope, command.frequency)
      await deps.views.requestCheckups()
      deps.onAutoCheckupChanged?.()
      return { ok: true, cmd }
    }

    case 'migrate-type': {
      const listing = await deps.store.listWorkspaceDirs()
      const scopes: Scope[] = [{ kind: 'global' }, ...[...new Set(listing.entries.map(e => e.workspacePath))].sort().map(workspacePath => ({ kind: 'workspace' as const, workspacePath }))]
      let migrated = 0
      let skippedSecrets = 0
      const failures: string[] = []
      for (const scope of scopes) {
        const workspacePath = scope.kind === 'workspace' ? scope.workspacePath : undefined
        const read = await deps.store.readRaw(scope, { includeArchive: true })
        const matched = read.records.map(l => l.record).filter(r => r.type === command.from)
        if (command.action === 'retype') {
          for (const r of matched) {
            // 锁内复核：读到之后被别处改了类型的不动；只改类型，更新、确认时间照旧（不改衰退计时）
            let isChanged = false
            try {
              await deps.store.update(r, current => {
                if (current.type !== command.from) return current
                isChanged = true
                return { ...current, type: command.to! }
              }, scopeAt(workspacePath))
            } catch (error) {
              failures.push(`${r.id}：${error instanceof Error ? error.message : String(error)}`)
              continue
            }
            if (isChanged) migrated++
          }
          continue
        }
        const ids = matched.filter(r => r.status === 'active').map(r => r.id)
        if (ids.length === 0) continue
        // 锁内复核：收集之后被别处改成别的类型的不删（同 retype）
        const r = await executeForget(
          { ids, reason: `用户在设置页删除或改名类型 ${command.from}`, allowCrossWorkspace: true },
          gov, executorDeps, { isSoftOnly: true, target: scope, isChanged: current => current.type !== command.from },
        )
        migrated += r.forgotten.length
        skippedSecrets += r.skippedSecrets?.length ?? 0
        if (!r.ok && r.forgotten.length === 0 && (r.skippedSecrets?.length ?? 0) === 0) failures.push(r.message)
      }
      if (failures.length > 0) {
        // 已经改了的照样重写视图（成功时由 run 统一重写）
        if (migrated > 0) await deps.views.request()
        return fail(cmd, 'failed', `${failures.length} 处没处理成功，可以重试：${failures.join('；')}`)
      }
      return { ok: true, cmd, migrated, ...(command.action === 'forget' ? { skippedSecrets } : {}) }
    }

    case 'refresh-views':
      await deps.decisions.sweep(now)
      await deps.views.rewriteAll()
      return { ok: true, cmd }
  }
}
