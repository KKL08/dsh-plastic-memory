import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryLogger, MemoryStore } from '../store.ts'
import type { KvTable } from '../kv-table.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { AgentsMdWriter } from '../storage/agents-md.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { RecordNotFoundError } from '../errors.ts'
import { detectSecrets, hasSecret } from '../secrets.ts'
import { computeDigest } from '../storage/frontmatter.ts'
import { candidateFingerprint, isModelChange, kindOf, verdictLoser, type PendingDecisionsStore } from '../governance/decisions.ts'
import { editFingerprint, isConflicting, type SnapshotStore } from '../governance/snapshots.ts'
import type { PendingDecision, ScanCacheEntry, SnapshotRecord } from '../governance/schema.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import type { AdviceIgnoreStore } from '../governance/advice-ignores.ts'
import { executeConfirm } from '../tools/confirm.ts'
import { executeForget } from '../tools/forget.ts'
import { executePromote } from '../tools/promote.ts'
import { executeScan } from '../tools/scan.ts'
import { executeSnapshotTool, type SnapshotToolOptions } from '../tools/snapshot.ts'
import {
  crossWorkspaceNote, gateRecords, isCopyOf, locateCopy, workspaceLabel, type CrossWorkspaceRejection, type GovernanceContext,
} from '../tools/workspace-gate.ts'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, MEMORY_COMMAND_NAME, layerOfMemory, mergeKeeperIndex, parseMemoryCommand, sessionViewFile,
  type GuiErrorCode, type GuiLayerRef, type MemoryCommand, type MemoryCommandResult,
} from './contract.ts'
import type { ViewWriter } from './view-writer.ts'
import { generateDraft } from './model-draft.ts'
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
  cache: KvTable<ScanCacheEntry>
  /** 建议忽略表（ignore-advice / unignore-advice 写它）。 */
  ignores: AdviceIgnoreStore
  registry: TypeRegistry
  agentsMd: AgentsMdWriter
  views: Pick<ViewWriter, 'request' | 'rewriteAll' | 'collectViews'>
  /** 借来的会话 → workspace、子 agent 深度、会话 id（与工具共用接线层的同一个解析函数，exec 只带 agent）。 */
  resolveContext: (exec: ToolRunContext) => Promise<{ workspacePath: string | undefined; delegationDepth: number; session: { id: string } }>
  /** 在借来的会话的 agent 上解析模型；null = 拿不到。 */
  getLlm: (exec: ToolRunContext) => SemanticLlm | null
  getBaseline: (exec: ToolRunContext) => readonly string[] | null
  /** 体检开关（用时读配置）；关闭时治理类子命令返回 governance-disabled。缺省视为开启。 */
  isGovernanceEnabled?: () => boolean
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

/** 改待决项的子命令，先认领条目再执行，同一条同时只跑一个（resolve 由执行器 executeConfirm 自己认领）。 */
const CLAIMED_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['undo', 'promote', 'keep-local', 'dismiss-overflow'])

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
  const context = await deps.resolveContext(exec)
  if (command.cmd === 'info') return await info(deps, context.session.id)
  if (command.cmd === 'model-info') {
    const llm = deps.getLlm(exec)
    return llm === null ? fail(command.cmd, 'llm-unavailable', '借用的会话拿不到模型') : { ok: true, cmd: command.cmd, ...(llm.model !== undefined ? { model: llm.model } : {}) }
  }
  if (GOVERNANCE_COMMANDS.has(command.cmd) && deps.isGovernanceEnabled?.() === false && !(await isEditUndo(deps.decisions, command))) {
    return fail(command.cmd, 'governance-disabled', '体检已关闭，可在插件设置里打开')
  }
  if (context.delegationDepth > 0) return fail(command.cmd, 'subagent-readonly', '借用的会话是子 agent，记忆只读')
  const now = deps.now?.() ?? Date.now()
  const gov = { workspacePath: context.workspacePath }
  let result: MemoryCommandResult
  if ('decisionId' in command && CLAIMED_COMMANDS.has(command.cmd)) {
    // 两个标签页或两个宿主进程同时处理同一条（提升与留在本项目、两次撤销）：只让一条执行，另一条什么都不动
    const claimed = await deps.decisions.withClaim(command.decisionId, () => dispatch(deps, command, gov, exec, now))
    result = claimed.isClaimed ? claimed.value : fail(command.cmd, 'claimed', `待决项 ${command.decisionId} 正在被另一次操作处理，未做任何改动`)
  } else {
    result = await dispatch(deps, command, gov, exec, now)
  }
  // scan / refresh-views 自己做全量重写
  if (result.ok && command.cmd !== 'scan' && command.cmd !== 'refresh-views' && !READ_ONLY_COMMANDS.has(command.cmd)) await deps.views.request()
  return result
}

/** 提升候选所在项目的那一份（同 id 在会话项目里另有一份时不动错）；旧条目没记项目时按会话定位。 */
function candidateCopy(entry: PendingDecision): { target?: GuiLayerRef } {
  const workspacePath = entry.workspaces?.[0]
  return workspacePath === undefined || workspacePath === 'global' ? {} : { target: { kind: 'workspace', workspacePath } }
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
        ...(sessionId !== 'unknown' ? { session: at(sessionViewFile(sessionId)) } : {}),
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

  /** 按快照恢复这些记忆；返回恢复了的 id，或错误结果（快照过期、跨项目被拒、快照后被改过）。 */
  const restoreFrom = async (snapshotId: string, memoryIds: string[], allowCrossWorkspace: boolean | undefined, options: SnapshotToolOptions = {}): Promise<string[] | Err> => {
    const r = await executeSnapshotTool({ action: 'restore', snapshotId, memoryIds, allowCrossWorkspace }, gov, executorDeps, options)
    if (r.kind === 'error') return fail(cmd, 'not-found', r.message)
    if (r.kind !== 'restored') return fail(cmd, 'failed', r.message)
    if (r.rejected.length > 0) return fail(cmd, 'cross-workspace', r.message, r.rejected)
    if (r.skipped.length > 0) return fail(cmd, 'failed', r.message)
    return r.restored
  }
  const settledEntry = async (id: string) => (await deps.decisions.listSettled()).find(d => d.id === id)
  const openEntryOfKind = async (id: string, kind: ReturnType<typeof kindOf>): Promise<PendingDecision | Err> => {
    const entry = await deps.decisions.get(id)
    if (!entry) return notFound(id)
    if (kindOf(entry) !== kind) return fail(cmd, 'failed', `待决项 ${id} 不是 ${kind}（${kindOf(entry)}），未做任何改动`)
    return entry
  }
  const isErr = (v: unknown): v is Err => typeof v === 'object' && v !== null && 'ok' in v && v.ok === false
  /** 命令带了层就只认那一份，否则按借来的会话定位（当前项目优先）。 */
  const locate = (memoryId: string, layer: GuiLayerRef | undefined) =>
    layer === undefined ? deps.store.get(memoryId, { workspacePath: gov.workspacePath }) : locateCopy(deps.store, memoryId, layer)

  /**
   * 撤销直接改、直接合并：保留的那条此刻还是那次写下的内容，才按改前的快照把涉及的记忆都恢复（合并删掉的那条一起回来）；
   * 之后被别处改过的不覆盖，什么都不动。恢复后条目移出账本。
   */
  const undoEdit = async (entry: PendingDecision, allowCrossWorkspace: boolean | undefined): Promise<MemoryCommandResult> => {
    const snapshotId = entry.settled?.snapshotId
    const snapshot = snapshotId === undefined ? undefined : await deps.snapshots.get(snapshotId)
    const records = snapshot?.data.filter(r => entry.memoryIds.includes(r.id)) ?? []
    const before = records.find(r => r.id === entry.memoryIds[0])
    if (snapshotId === undefined || before === undefined) return notFound(`${entry.id} 改前的快照（可能已超过 14 天）`)
    // 先过跨项目门：放行一部分就恢复一部分，合并会只回来一半
    const { rejected } = gateRecords(records, gov, allowCrossWorkspace)
    if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
    const isOwnWrite = (r: MemoryRecord) => editFingerprint(r) === entry.fingerprint
    const current = await deps.store.get(before.id, { workspacePath: before.workspacePath, isExactLayer: true })
    if (current?.status !== 'active' || !isOwnWrite(current)) {
      return fail(cmd, 'failed', `记忆 ${before.id} 在这次修改之后又被改过或已删除，撤销会冲掉之后的改动，未做任何改动`)
    }
    // 要么全恢复、要么全不动：合并删掉的那条若已从最近删除恢复又改过，恢复会跳过它，保留的那条却已还原，所以先逐条核对
    for (const rec of records) {
      if (rec.id === before.id) continue
      const cur = await deps.store.get(rec.id, { workspacePath: rec.workspacePath, isExactLayer: true })
      if (isConflicting(cur, rec) && !isOwnWrite(cur!)) {
        return fail(cmd, 'failed', `记忆 ${rec.id} 在这次修改之后又被改过，撤销会冲掉之后的改动，未做任何改动`)
      }
    }
    const r = await restoreFrom(snapshotId, entry.memoryIds, allowCrossWorkspace, { isExactLayer: true, overwriteIf: isOwnWrite })
    if (isErr(r)) return r
    await deps.decisions.remove(entry.id)
    return { ok: true, cmd, decisionId: entry.id, memoryIds: r, snapshotId }
  }

  /**
   * 撤销模型改写、替代（对话卡片、右侧栏「这次新写入的」）：改写的那条仍在用、替代的那条仍是已取代，且内容还是那次写下的，
   * 才按改前的快照恢复它（替代的旧记忆回到在用，替代它的那条不动）；之后被手改、模型再改或删掉的不覆盖，回 stale。
   * 撤销后条目标已撤销、留到保留窗口结束，界面据此显示「已撤销」；已撤销的不能再撤。
   */
  const undoModelChange = async (entry: PendingDecision, allowCrossWorkspace: boolean | undefined): Promise<MemoryCommandResult> => {
    const snapshotId = entry.settled?.snapshotId
    const snapshot = snapshotId === undefined ? undefined : await deps.snapshots.get(snapshotId)
    const before = snapshot?.data.find(r => r.id === entry.memoryIds[0])
    if (entry.settled?.isUndone === true) return notFound(`${entry.id}（已撤销）`)
    if (snapshotId === undefined || before === undefined) return notFound(`${entry.id} 改前的快照（可能已超过 14 天）`)
    const { rejected } = gateRecords([before], gov, allowCrossWorkspace)
    if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
    const status = kindOf(entry) === 'rewrite' ? 'active' : 'superseded'
    const isOwnWrite = (r: MemoryRecord) => r.status === status && editFingerprint(r) === entry.fingerprint
    const current = await deps.store.get(before.id, { workspacePath: before.workspacePath, isExactLayer: true })
    const changed = () => fail(cmd, 'stale', `记忆 ${before.id} 在这次修改之后又被改过或已删除，撤销会冲掉之后的改动，未做任何改动`)
    if (current === undefined || !isOwnWrite(current)) return changed()
    // 写入那一刻按最新内容再核对一次：之间被改过的跳过，什么都没写
    const r = await restoreFrom(snapshotId, [before.id], allowCrossWorkspace, { isExactLayer: true, overwriteIf: isOwnWrite })
    if (isErr(r)) return r.code === 'failed' ? changed() : r
    await deps.decisions.markUndone(entry.id)
    return { ok: true, cmd, decisionId: entry.id, memoryIds: r, snapshotId }
  }

  /**
   * 撤销移到项目：项目里那份此刻还是移过去时的内容，才把它搬回全局。一次搬家，全局那份回来的同时项目里那份就不在了，
   * 不会只做成一半；之后被改过、删掉，或全局又有了这个 id 的，什么都不动。搬回后条目移出账本。
   */
  const undoMove = async (entry: PendingDecision, allowCrossWorkspace: boolean | undefined): Promise<MemoryCommandResult> => {
    const memoryId = entry.memoryIds[0] ?? ''
    const workspacePath = entry.workspaces?.[0]
    const current = workspacePath === undefined ? undefined : await locateCopy(deps.store, memoryId, { kind: 'workspace', workspacePath })
    if (current === undefined) return notFound(`${memoryId} 移过去的那一份`)
    const { rejected } = gateRecords([current], gov, allowCrossWorkspace)
    if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
    const isOwnWrite = (r: MemoryRecord) => r.status === 'active' && editFingerprint(r) === entry.fingerprint
    const changed = () => fail(cmd, 'failed', `记忆 ${memoryId} 移过去之后又被改过或已删除，撤销会冲掉之后的改动，未做任何改动`)
    if (!isOwnWrite(current)) return changed()
    if ((await locateCopy(deps.store, memoryId, { kind: 'global' })) !== undefined) {
      return fail(cmd, 'target-taken', `全局已有记忆 ${memoryId}，搬回去会盖掉它，未做任何改动`)
    }
    let isMoved = false
    try {
      await deps.store.update(current, (cur) => {
        // 锁内按磁盘上的现状再核对一次
        isMoved = isOwnWrite(cur)
        if (!isMoved) return cur
        const { workspacePath: _workspacePath, ...rest } = cur
        return { ...rest, scope: 'global' }
      }, { workspacePath, isExactLayer: true })
    } catch (error) {
      if (!(error instanceof RecordNotFoundError)) throw error
    }
    if (!isMoved) return changed()
    await deps.decisions.remove(entry.id)
    const snapshotId = entry.settled?.snapshotId
    return { ok: true, cmd, decisionId: entry.id, memoryIds: [memoryId], ...(snapshotId !== undefined ? { snapshotId } : {}) }
  }

  /** 结清这次提升或留下，返回条目 id。 */
  type SettleCandidate = (verdict: 'promoted' | 'keep-local', opts: { snapshotId?: string; fingerprint?: string }) => Promise<string>
  /** 写进 AGENTS.md 后插件不再管理它：有条目就移出账本（返回它的 id），没有就什么都不记。 */
  type DropCandidate = () => Promise<string | undefined>

  /**
   * 按记忆 id 提升或留在本项目。等你决定里已有它的提升候选条目：先认领那一条，和待处理卡、体检、另一处的就地处理互斥，
   * 认领后条目仍未决、记忆仍符合条件才做，做完结清那一条。还没有条目：直接做，做成之后才记一条已结清的，
   * 账本里不留没做成的条目，体检也清不掉一条还没记的。isInPlace（对话卡片、右侧栏）时这样新记的条目标 isBornSettled，撤销时移出账本。
   */
  const onCandidateEntry = async (
    memoryId: string, layer: GuiLayerRef | undefined, isEligible: (r: MemoryRecord) => boolean, isInPlace: boolean,
    act: (rec: MemoryRecord, settle: SettleCandidate, drop: DropCandidate) => Promise<MemoryCommandResult>,
  ): Promise<MemoryCommandResult> => {
    const seen = await locate(memoryId, layer)
    if (!seen || !isEligible(seen)) return notFound(memoryId)
    const open = (await deps.decisions.list())
      .find(e => kindOf(e) === 'promote-candidate' && e.memoryIds[0] === seen.id && e.workspaces?.[0] === seen.workspacePath)
    if (open === undefined) {
      return await act(seen, async (verdict, opts) => {
        const { entry, created } = await deps.decisions.upsert(
          { kind: 'promote-candidate', memoryIds: [seen.id], summary: seen.summary, workspaces: [seen.workspacePath!], fingerprint: candidateFingerprint(seen) }, now,
        )
        await deps.decisions.settle(entry.id, verdict, now, created && isInPlace ? { ...opts, isBornSettled: true } : opts)
        return entry.id
      }, async () => undefined)
    }
    const claimed = await deps.decisions.withClaim(open.id, async () => {
      const rec = await locate(memoryId, layer)
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

  /** 留在本项目：清掉候选标记，条目按记忆此刻的内容记指纹结清（上次体检后模型改过内容的话，账本里的旧指纹对不上，同内容再被标记会白提示一次）。 */
  const keepLocal = async (
    memoryId: string, workspacePath: string | undefined, allowCrossWorkspace: boolean | undefined, settle: SettleCandidate,
    options: { target?: GuiLayerRef } = {},
  ): Promise<MemoryCommandResult> => {
    const r = await executePromote(
      { confirmedIds: [memoryId], target: 'global', dismiss: true, allowCrossWorkspace },
      gov, { store: deps.store, agentsMd: deps.agentsMd, snapshots: deps.snapshots, now: () => now }, options,
    )
    if (r.rejected.length > 0) return fail(cmd, 'cross-workspace', r.message, r.rejected)
    if (r.dismissed.length === 0) return fail(cmd, 'failed', r.message)
    const current = await deps.store.get(memoryId, { workspacePath })
    const decisionId = await settle('keep-local', current !== undefined ? { fingerprint: candidateFingerprint(current) } : {})
    return { ok: true, cmd, decisionId, memoryIds: r.dismissed }
  }

  switch (command.cmd) {
    case 'resolve': {
      if (!(await deps.decisions.get(command.decisionId))) return notFound(command.decisionId)
      const r = await executeConfirm({ action: 'resolve', decisionId: command.decisionId, verdict: command.verdict, allowCrossWorkspace: command.allowCrossWorkspace }, gov, executorDeps)
      if (r.kind === 'error') return r.code === 'cross-workspace' ? fail(cmd, 'cross-workspace', r.message, r.rejected) : fail(cmd, r.code ?? 'failed', r.message)
      const snapshotId = (await settledEntry(command.decisionId))?.settled?.snapshotId
      return { ok: true, cmd, decisionId: command.decisionId, ...(snapshotId !== undefined ? { snapshotId } : {}) }
    }

    case 'undo': {
      // 去掉 settled；记了快照的按它恢复败方（删一方的裁决）或恢复原位（提升为全局）
      const entry = await settledEntry(command.decisionId)
      if (!entry?.settled) return notFound(command.decisionId)
      if (kindOf(entry) === 'edit') return await undoEdit(entry, command.allowCrossWorkspace)
      if (isModelChange(entry)) return await undoModelChange(entry, command.allowCrossWorkspace)
      if (kindOf(entry) === 'move') return await undoMove(entry, command.allowCrossWorkspace)
      const { verdict, snapshotId } = entry.settled
      const loser = verdictLoser(entry, verdict)
      const targets = loser !== undefined ? [loser] : verdict === 'promoted' ? entry.memoryIds : []
      // 撤销提升只搬全局那一份：之后又移到别的项目的，按快照恢复会顺着全目录兜底把那个项目里的副本搬走
      if (verdict === 'promoted') {
        for (const memoryId of targets) {
          if ((await locateCopy(deps.store, memoryId, { kind: 'global' })) === undefined) return notFound(`${memoryId} 全局那一份`)
        }
      }
      let restored: string[] = []
      if (targets.length > 0 && snapshotId !== undefined) {
        const r = await restoreFrom(snapshotId, targets, command.allowCrossWorkspace)
        if (isErr(r)) return r
        restored = r
      }
      if (verdict === 'keep-local') {
        // 「留在本项目」清掉了候选标记、没拍快照：撤销时把标记放回去，否则条目回到待处理也找不到候选
        const memoryId = entry.memoryIds[0] ?? ''
        const rec = await deps.store.get(memoryId, { workspacePath: entry.workspaces?.[0] ?? gov.workspacePath })
        if (!rec || rec.status !== 'active') return notFound(memoryId)
        const { rejected } = gateRecords([rec], gov, command.allowCrossWorkspace)
        if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
        // 同 keep-local：不是内容编辑，updatedAt 不动
        if (!(await deps.store.updateIfLive(rec, r => ({ ...r, globalCandidate: true })))) return notFound(memoryId)
        restored = [memoryId]
      }
      // 就地处理时才记的条目：移出账本，回到没点过的样子；其余回到待处理
      if (entry.settled.isBornSettled === true) await deps.decisions.remove(entry.id)
      else await deps.decisions.unsettle(entry.id)
      return { ok: true, cmd, decisionId: entry.id, memoryIds: restored, ...(snapshotId !== undefined ? { snapshotId } : {}) }
    }

    case 'restore': {
      // 最近删除里的一条：被裁决删掉的走撤销那条路（按裁决的快照恢复，冲突回到待处理、沿用原条目）；
      // 其余按最近一份含它的快照恢复；没有快照覆盖的（不经插件删除的归档文件）恢复归档文件本身
      const { memoryId, layer } = command
      const rec = await locate(memoryId, layer)
      if (!rec || rec.status !== 'deleted') return notFound(memoryId)
      // 带了层时，裁决条目与快照都得覆盖那一份：同 id 别的副本的快照不拿来恢复它
      const snapshots = await deps.snapshots.list()
      const covers = (s: (typeof snapshots)[number] | undefined) =>
        s?.data.some(r => r.id === memoryId && !r.redacted && (layer === undefined || isCopyOf(r, layer))) === true
      const entry = (await deps.decisions.listSettled()).filter(d => verdictLoser(d, d.settled!.verdict) === memoryId
        && (layer === undefined || covers(snapshots.find(s => s.id === d.settled!.snapshotId)))).at(-1)
      const snapshotId = entry?.settled?.snapshotId ?? snapshots.find(covers)?.id
      if (snapshotId === undefined) {
        // 快照里只剩脱敏副本的是密钥硬删过的：归档里残留的副本也不复活
        if (snapshots.some(s => s.data.some(r => r.id === memoryId && r.redacted === true && (layer === undefined || isCopyOf(r, layer))))) {
          return fail(cmd, 'not-found', `${memoryId} 含密钥已物理删除，快照里只剩脱敏副本，不可恢复`)
        }
        const { rejected } = gateRecords([rec], gov, command.allowCrossWorkspace)
        if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
        if (!(await deps.store.restoreArchived(rec, { isExactLayer: layer !== undefined }))) return notFound(memoryId)
        return { ok: true, cmd, memoryIds: [memoryId] }
      }
      const restore = async (): Promise<MemoryCommandResult> => {
        const r = await restoreFrom(snapshotId, [memoryId], command.allowCrossWorkspace, { isExactLayer: layer !== undefined })
        if (isErr(r)) return r
        if (entry) await deps.decisions.unsettle(entry.id)
        return { ok: true, cmd, memoryIds: r, snapshotId, ...(entry ? { decisionId: entry.id } : {}) }
      }
      if (!entry) return await restore()
      // 裁决删掉的：同撤销，先认领条目、认领后重读，期间被撤销或重新裁决过的不再按旧裁决恢复、重开
      const claimed = await deps.decisions.withClaim(entry.id, async () => {
        const current = await settledEntry(entry.id)
        if (current?.settled?.at !== entry.settled!.at || verdictLoser(current, current.settled.verdict) !== memoryId) return notFound(memoryId)
        return await restore()
      })
      return claimed.isClaimed ? claimed.value : fail(cmd, 'claimed', `待决项 ${entry.id} 正在被另一次操作处理，未做任何改动`)
    }

    case 'promote': {
      const entry = await openEntryOfKind(command.decisionId, 'promote-candidate')
      if (isErr(entry)) return entry
      const r = await executePromote(
        { confirmedIds: entry.memoryIds.slice(0, 1), target: command.target, allowCrossWorkspace: command.allowCrossWorkspace },
        gov, { store: deps.store, agentsMd: deps.agentsMd, snapshots: deps.snapshots, now: () => now }, candidateCopy(entry),
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
          { target: { kind: 'workspace', workspacePath: rec.workspacePath! } },
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
        }, { workspacePath: undefined, isExactLayer: true })
      } catch (error) {
        if (!(error instanceof RecordNotFoundError)) throw error
      }
      if (written === undefined) return notFound(memoryId)
      const entry = await deps.decisions.addSettled({
        kind: 'move', memoryIds: [rec.id], summary: rec.summary, workspaces: [workspacePath], fingerprint: editFingerprint(written),
      }, 'moved', now, snapshot.id)
      const located = await deps.store.locate(rec.id, { workspacePath, isExactLayer: true })
      return { ok: true, cmd, decisionId: entry.id, memoryIds: [rec.id], snapshotId: snapshot.id, ...(located !== undefined ? { filePath: located.filePath } : {}) }
    }

    case 'keep-local': {
      const entry = await openEntryOfKind(command.decisionId, 'promote-candidate')
      if (isErr(entry)) return entry
      return await keepLocal(entry.memoryIds[0]!, entry.workspaces?.[0], command.allowCrossWorkspace, async (verdict, opts) => {
        await deps.decisions.settle(entry.id, verdict, now, opts)
        return entry.id
      })
    }

    case 'forget':
    case 'hard-delete': {
      const isHardDelete = command.cmd === 'hard-delete'
      if (isHardDelete) {
        const rec = await locate(command.memoryId, command.layer)
        if (!rec) return notFound(command.memoryId)
        if (rec.status === 'deleted') {
          // 最近删除里的一条：不等 14 天到期，现在就清掉。先清账本、再抹快照、最后物理删除归档文件（召回统计行由存储层
          // 按「哪层都没有它了」清）；中途失败时归档文件还在，重试即可，此时恢复就是普通恢复。只认它自己那一层，别层同 id 的副本不碰
          const { rejected } = gateRecords([rec], gov, command.allowCrossWorkspace)
          if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
          // 别层还有这个 id 的副本时，快照里那一层的副本是它的历史，留着
          const snapshots = await deps.snapshots.list()
          const kept = new Set<string>()
          for (const r of snapshots.flatMap(s => s.data)) {
            const layer = layerOfMemory(r)
            if (r.id !== rec.id || layer === undefined || isCopyOf(rec, layer) || kept.has(workspaceLabel(r))) continue
            if ((await locateCopy(deps.store, rec.id, layer)) !== undefined) kept.add(workspaceLabel(r))
          }
          const isPurged = (r: SnapshotRecord) => r.id === rec.id && !kept.has(workspaceLabel(r))
          // 撤销要靠的那份快照副本马上就没了：裁决条目先清掉，之后恢复不再说冲突会回到待处理
          const lost = new Set(snapshots.filter(s => s.data.some(isPurged)).map(s => s.id))
          for (const d of await deps.decisions.listSettled()) if (lost.has(d.settled?.snapshotId ?? '')) await deps.decisions.remove(d.id)
          await deps.snapshots.purge(isPurged)
          // 锁内复核：定位之后被别处恢复成在用的，不删
          let isRestored = false
          if (!(await deps.store.hardDelete(rec, { isExactLayer: true }, current => (isRestored = current.status !== 'deleted')))) {
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
      if (targets.some(t => hasSecret(t.record))) return fail(cmd, 'has-secret', '含密钥的记忆不能在这里改：界面上是遮盖后的正文，保存会把占位文字写回去。未做任何改动')
      const stale = () => fail(cmd, 'stale', '这条记忆刚被改过，刷新后再改。未做任何改动')
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
      // 快照先行，项目记忆也拍（memory_save 只给全局拍），否则撤销无从兑现；合并的两条同拍一份
      const snapshot = await deps.snapshots.capture({
        operation: 'pre-update',
        description: removed === undefined ? `直接改记忆 ${kept.record.id} 前` : `直接合并 ${kept.record.id} 与 ${removed.record.id} 前`,
        records: targets.map(t => t.record),
      }, now)
      // 出处、类型、作用域、有效期、置信度、取代关系不动：这是用户亲手改的内容，不是借来的会话说的
      const hint = { workspacePath: kept.record.workspacePath, isExactLayer: true }
      let isWritten = false
      try {
        await deps.store.update(kept.record, (cur) => {
          // 锁内按磁盘上的现状再核对一次：读过之后被改过就原样不写
          isWritten = cur.status === 'active' && !isStale(cur, kept.base)
          if (!isWritten) return cur
          const { handEdited: _handEdited, ...rest } = cur
          return { ...rest, content, name, summary, tags, updatedAt: now, lastConfirmedAt: now }
        }, hint)
      } catch (error) {
        if (!(error instanceof RecordNotFoundError)) throw error
      }
      if (!isWritten) return stale()
      // 另一条走删除的老路：软删进最近删除，账本里指向它的条目一并清掉（同 forget）；快照上面已经拍过。
      // 核对之后另一个会话才写进密钥的不删（极少见），这次只算改了保留的那条
      const isRemoved = removed === undefined || (await deps.store.softDeleteUnlessSecret(removed.record, { isExactLayer: true, now })) !== 'has-secret'
      if (removed !== undefined && isRemoved) await deps.decisions.removeByMemoryIds([removed.record.id])
      const written = await deps.store.locate(kept.record.id, hint)
      const memoryIds = removed !== undefined && isRemoved ? [kept.record.id, removed.record.id] : [kept.record.id]
      const entry = await deps.decisions.addSettled({
        kind: 'edit', memoryIds, summary: name, fingerprint: written === undefined ? '' : editFingerprint(written.record),
        workspaces: memoryIds.map(id => workspaceLabel(targets.find(t => t.record.id === id)!.record)),
      }, memoryIds.length === 2 ? 'merged' : 'edited', now, snapshot.id)
      if (!isRemoved) return fail(cmd, 'has-secret', `保留的那条已改好；另一条（${removed!.record.id}）刚被写进密钥，没有删除`)
      return { ok: true, cmd, decisionId: entry.id, memoryIds, snapshotId: snapshot.id, ...(written !== undefined ? { filePath: written.filePath } : {}) }
    }

    case 'draft-edit': {
      const refs = command.memories
      if (refs.length === 2 && refs[0].memoryId === refs[1]!.memoryId) return fail(cmd, 'invalid-args', `要合并的两条是同一条记忆：${refs[0].memoryId}`)
      const records = await Promise.all(refs.map(ref => locate(ref.memoryId, ref.layer)))
      if (!records.every(r => r?.status === 'active')) return notFound(refs.map(ref => ref.memoryId).join('、'))
      // 原文不发给模型：明确密钥和疑似密钥都算
      if (records.some(r => hasSecret(r!))) return fail(cmd, 'has-secret', '含密钥的记忆不发给模型。未做任何改动')
      const llm = deps.getLlm(exec)
      if (llm === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型')
      const r = await generateDraft({ adviceType: command.adviceType, records: records.map(rec => rec!), request: command.request, previous: command.previous }, llm)
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
      if (refs.some((ref, i) => isStale(records[i]!, ref.base))) return fail(cmd, 'stale', '这条记忆刚被改过，刷新后再看。未做任何改动')
      const entry = await deps.ignores.ignore(command.type, records.map(r => r!), now)
      return { ok: true, cmd, memoryIds: entry.memoryIds }
    }

    case 'unignore-advice':
      await deps.ignores.unignore(command.type, command.memoryIds)
      return { ok: true, cmd, memoryIds: [...command.memoryIds].sort() }

    case 'scan': {
      // 在借来的会话的 agent 上解析模型，拿不到就不扫（只跑规则层会让界面以为体检做完了）
      if (deps.getLlm(exec) === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型，可在对话里让 agent 体检')
      // 新增条数与分数是附带的：收集视图出错只记日志、结果里不带它们，不挡体检本身，也不把做完的体检报成失败
      const collect = () => deps.views.collectViews().catch((err: unknown) => {
        (deps.log ?? console).warn('[plastic-memory] 体检结果的视图收集失败，这次不给新增条数与分数', err)
        return undefined
      })
      // 体检前的待处理，和体检后比出新增
      const before = (await collect())?.pending
      const r = await executeScan(
        { scope: command.workspacePath ?? 'all', layers: 'full' },
        { store: deps.store, registry: deps.registry, decisions: deps.decisions, cache: deps.cache, getBaseline: deps.getBaseline, getLlm: deps.getLlm, resolveContext: deps.resolveContext, now: () => now },
        exec,
      )
      await deps.decisions.sweep(now)
      const after = await deps.views.rewriteAll() ?? (before === undefined ? undefined : await collect())
      if (r.kind === 'error') return fail(cmd, 'failed', r.message)
      // 项目体检读的是本项目的可见集合（全局 + 本项目），全库体检是全部层
      const covered = command.workspacePath === undefined ? 'all' : [{ kind: 'global' as const }, { kind: 'workspace' as const, workspacePath: command.workspacePath }]
      const notes = r.notes.map(n => n.code)
      const extras = {
        ...(r.semanticBatches !== undefined ? { semanticBatches: r.semanticBatches } : {}),
        ...(r.usageTokens !== undefined ? { usageTokens: r.usageTokens } : {}),
      }
      return before === undefined || after === undefined
        ? { ok: true, cmd, notes, ...extras }
        : { ok: true, cmd, notes, ...extras, ...scanOutcome(before, after, covered) }
    }

    case 'refresh-views':
      await deps.decisions.sweep(now)
      await deps.views.rewriteAll()
      return { ok: true, cmd }
  }
}
