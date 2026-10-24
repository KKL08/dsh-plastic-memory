import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryLogger, MemoryStore } from '../store.ts'
import type { KvTable } from '../kv-table.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { AgentsMdWriter } from '../storage/agents-md.ts'
import { hasSecret } from '../secrets.ts'
import { candidateFingerprint, kindOf, verdictLoser, type PendingDecisionsStore } from '../governance/decisions.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { PendingDecision, ScanCacheEntry } from '../governance/schema.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import { executeConfirm } from '../tools/confirm.ts'
import { executeForget } from '../tools/forget.ts'
import { executePromote } from '../tools/promote.ts'
import { executeScan } from '../tools/scan.ts'
import { executeSnapshotTool } from '../tools/snapshot.ts'
import type { CrossWorkspaceRejection, GovernanceContext } from '../tools/workspace-gate.ts'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, MEMORY_COMMAND_NAME, parseMemoryCommand, sessionViewFile,
  type GuiErrorCode, type MemoryCommand, type MemoryCommandResult,
} from './contract.ts'
import type { ViewWriter } from './view-writer.ts'

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
  registry: TypeRegistry
  agentsMd: AgentsMdWriter
  views: Pick<ViewWriter, 'request' | 'rewriteAll'>
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

/** 依赖体检开关的子命令（对应四个治理工具的能力）；forget / restore / hard-delete / refresh-views 不受开关影响。 */
// dismiss-overflow 不在此列：超限提醒在体检关闭时照样入账，忽略它不属于治理动作
const GOVERNANCE_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['resolve', 'undo', 'promote', 'keep-local', 'scan'])

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
  if (GOVERNANCE_COMMANDS.has(command.cmd) && deps.isGovernanceEnabled?.() === false) {
    return fail(command.cmd, 'governance-disabled', '体检已关闭，可在插件设置里打开')
  }
  if (context.delegationDepth > 0) return fail(command.cmd, 'subagent-readonly', '借用的会话是子 agent，记忆只读')
  const now = deps.now?.() ?? Date.now()
  const result = await dispatch(deps, command, { workspacePath: context.workspacePath }, exec, now)
  // scan / refresh-views 自己做全量重写
  if (result.ok && command.cmd !== 'scan' && command.cmd !== 'refresh-views') await deps.views.request()
  return result
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
  command: Exclude<MemoryCommand, { cmd: 'info' }>,
  gov: GovernanceContext,
  exec: ToolRunContext,
  now: number,
): Promise<MemoryCommandResult> {
  const { cmd } = command
  const executorDeps = { store: deps.store, decisions: deps.decisions, snapshots: deps.snapshots, log: deps.log, now: () => now }
  const notFound = (what: string) => fail(cmd, 'not-found', `不存在或已处理：${what}`)

  /** 按快照恢复这些记忆；返回恢复了的 id，或错误结果（快照过期、跨项目被拒、快照后被改过）。 */
  const restoreFrom = async (snapshotId: string, memoryIds: string[], allowCrossWorkspace: boolean | undefined): Promise<string[] | Err> => {
    const r = await executeSnapshotTool({ action: 'restore', snapshotId, memoryIds, allowCrossWorkspace }, gov, executorDeps)
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

  switch (command.cmd) {
    case 'resolve': {
      if (!(await deps.decisions.get(command.decisionId))) return notFound(command.decisionId)
      const r = await executeConfirm({ action: 'resolve', decisionId: command.decisionId, verdict: command.verdict, allowCrossWorkspace: command.allowCrossWorkspace }, gov, executorDeps)
      if (r.kind === 'error') return r.code === 'cross-workspace' ? fail(cmd, 'cross-workspace', r.message, r.rejected) : fail(cmd, 'failed', r.message)
      const snapshotId = (await settledEntry(command.decisionId))?.settled?.snapshotId
      return { ok: true, cmd, decisionId: command.decisionId, ...(snapshotId !== undefined ? { snapshotId } : {}) }
    }

    case 'undo': {
      // 去掉 settled；记了快照的按它恢复败方（删一方的裁决）或恢复原位（提升为全局）
      const entry = await settledEntry(command.decisionId)
      if (!entry?.settled) return notFound(command.decisionId)
      const { verdict, snapshotId } = entry.settled
      const loser = verdictLoser(entry, verdict)
      const targets = loser !== undefined ? [loser] : verdict === 'promoted' ? entry.memoryIds : []
      let restored: string[] = []
      if (targets.length > 0 && snapshotId !== undefined) {
        const r = await restoreFrom(snapshotId, targets, command.allowCrossWorkspace)
        if (isErr(r)) return r
        restored = r
      }
      await deps.decisions.unsettle(entry.id)
      return { ok: true, cmd, decisionId: entry.id, memoryIds: restored, ...(snapshotId !== undefined ? { snapshotId } : {}) }
    }

    case 'restore': {
      // 最近删除里的一条：被裁决删掉的走撤销那条路（按裁决的快照恢复，冲突回到待处理、沿用原条目）；
      // 其余按最近一份含它的快照恢复
      const rec = await deps.store.get(command.memoryId, { workspacePath: gov.workspacePath })
      if (!rec || rec.status !== 'deleted') return notFound(command.memoryId)
      const entry = (await deps.decisions.listSettled()).filter(d => verdictLoser(d, d.settled!.verdict) === command.memoryId).at(-1)
      const snapshotId = entry?.settled?.snapshotId
        ?? (await deps.snapshots.list()).find(s => s.data.some(r => r.id === command.memoryId && !r.redacted))?.id
      if (snapshotId === undefined) return fail(cmd, 'not-found', `没有覆盖 ${command.memoryId} 的快照（可能已超过保留窗口）`)
      const r = await restoreFrom(snapshotId, [command.memoryId], command.allowCrossWorkspace)
      if (isErr(r)) return r
      if (entry) await deps.decisions.unsettle(entry.id)
      return { ok: true, cmd, memoryIds: r, snapshotId, ...(entry ? { decisionId: entry.id } : {}) }
    }

    case 'promote': {
      const entry = await openEntryOfKind(command.decisionId, 'promote-candidate')
      if (isErr(entry)) return entry
      const r = await executePromote(
        { confirmedIds: entry.memoryIds.slice(0, 1), target: command.target, allowCrossWorkspace: command.allowCrossWorkspace },
        gov, { store: deps.store, agentsMd: deps.agentsMd, snapshots: deps.snapshots, now: () => now },
      )
      if (r.rejected.length > 0) return fail(cmd, 'cross-workspace', r.message, r.rejected)
      if (r.promoted.length === 0) return fail(cmd, 'failed', r.message)
      // 提升为全局留账供 14 天内撤销；写进 AGENTS.md 后插件不再管理它，条目移出账本
      if (command.target === 'global') await deps.decisions.settle(entry.id, 'promoted', now, r.snapshotId !== null ? { snapshotId: r.snapshotId } : {})
      else await deps.decisions.remove(entry.id)
      return { ok: true, cmd, decisionId: entry.id, memoryIds: r.promoted.map(p => p.id), ...(r.snapshotId !== null ? { snapshotId: r.snapshotId } : {}) }
    }

    case 'keep-local': {
      const entry = await openEntryOfKind(command.decisionId, 'promote-candidate')
      if (isErr(entry)) return entry
      const r = await executePromote(
        { confirmedIds: entry.memoryIds.slice(0, 1), target: 'global', dismiss: true, allowCrossWorkspace: command.allowCrossWorkspace },
        gov, { store: deps.store, agentsMd: deps.agentsMd, snapshots: deps.snapshots, now: () => now },
      )
      if (r.rejected.length > 0) return fail(cmd, 'cross-workspace', r.message, r.rejected)
      if (r.dismissed.length === 0) return fail(cmd, 'failed', r.message)
      // 指纹按记忆此刻的内容记：上次体检后模型改过内容的话，账本里的旧指纹对不上，同内容再被标记会白提示一次
      const current = await deps.store.get(entry.memoryIds[0]!)
      await deps.decisions.settle(entry.id, 'keep-local', now, current !== undefined ? { fingerprint: candidateFingerprint(current) } : {})
      return { ok: true, cmd, decisionId: entry.id, memoryIds: r.dismissed }
    }

    case 'forget':
    case 'hard-delete': {
      const rec = await deps.store.get(command.memoryId, { workspacePath: gov.workspacePath })
      if (command.cmd === 'hard-delete') {
        // 只给密钥条目用：不含密钥的记忆 forget 会软删，与「彻底删除」的承诺不符
        if (!rec || rec.status === 'deleted') return notFound(command.memoryId)
        if (!hasSecret(rec)) return fail(cmd, 'failed', `记忆 ${command.memoryId} 不含密钥，彻底删除只用于密钥条目，未做任何改动`)
      } else if (rec && rec.status !== 'deleted' && hasSecret(rec)) {
        // forget 承诺 14 天可撤销，含密钥的记忆却只能物理删除：不动它，让界面先问用户再发 hard-delete
        return fail(cmd, 'has-secret', `记忆 ${command.memoryId} 含密钥，删除后不可恢复，未做任何改动`)
      }
      const r = await executeForget(
        { ids: [command.memoryId], reason: command.cmd === 'hard-delete' ? '用户在记忆页彻底删除密钥条目' : '用户在记忆页删除', allowCrossWorkspace: command.allowCrossWorkspace },
        gov, executorDeps,
      )
      if (r.rejected.length > 0) return fail(cmd, 'cross-workspace', r.message, r.rejected)
      if (!r.ok) return fail(cmd, 'not-found', r.message)
      return { ok: true, cmd, memoryIds: r.forgotten, ...(r.snapshotId !== null ? { snapshotId: r.snapshotId } : {}) }
    }

    case 'dismiss-overflow': {
      const entry = await openEntryOfKind(command.decisionId, 'overflow')
      if (isErr(entry)) return entry
      await deps.decisions.settle(entry.id, 'dismiss', now)
      return { ok: true, cmd, decisionId: entry.id }
    }

    case 'scan': {
      // 在借来的会话的 agent 上解析模型，拿不到就不扫（只跑规则层会让界面以为体检做完了）
      if (deps.getLlm(exec) === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型，可在对话里让 agent 体检')
      const r = await executeScan(
        { scope: command.workspacePath ?? 'all', layers: 'full' },
        { store: deps.store, registry: deps.registry, decisions: deps.decisions, cache: deps.cache, getBaseline: deps.getBaseline, getLlm: deps.getLlm, resolveContext: deps.resolveContext, now: () => now },
        exec,
      )
      await deps.decisions.sweep(now)
      await deps.views.rewriteAll()
      if (r.kind === 'error') return fail(cmd, 'failed', r.message)
      return { ok: true, cmd, notes: r.notes.map(n => n.code) }
    }

    case 'refresh-views':
      await deps.decisions.sweep(now)
      await deps.views.rewriteAll()
      return { ok: true, cmd }
  }
}
