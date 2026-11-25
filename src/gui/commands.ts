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
import {
  baselineBasisOf, candidateFingerprint, conflictFingerprint, isBaselineCurrent, isBasisCurrent, suggestionBasis, type MisplacedIgnore, type PendingDecisionsStore,
} from '../governance/decisions.ts'
import { isModelChange } from '../governance/undo-rules.ts'
import { editFingerprint, type SnapshotStore } from '../governance/snapshots.ts'
import { genId, kindOf, type LinkIds, type PendingDecision, type ProposalOp, type ScanCacheEntry, type SnapshotRecord, type SuggestionBasis } from '../governance/schema.ts'
import type { AdviceIgnoreStore } from '../governance/advice-ignores.ts'
import { baselineFor, type ReadInstructions } from '../governance/instructions.ts'
import type { CheckupRecordStore } from '../governance/checkup-records.ts'
import { memberScanFingerprints } from '../governance/checkup-plan.ts'
import type { AutoCheckupSettingStore } from '../governance/auto-checkups.ts'
import type { DreamsStore } from '../governance/dreams-records.ts'
import { listModelChoices, type ModelSelectionStore } from '../governance/background-llm.ts'
import { executeConfirm, type ConfirmOptions } from '../tools/confirm.ts'
import { executeForget } from '../tools/forget.ts'
import { executePromote, type PromoteResult } from '../tools/promote.ts'
import { hasDropped, linksOutside, withoutLinks } from '../links.ts'
import { executeUndo, restoreDeleted, type UndoResult } from '../tools/undo.ts'
import { applyChangeset, receiptsOfEntry, rollBackEntry } from '../tools/changeset.ts'
import { basisOf, scopeKeyOf, type ChangeOp } from '../governance/changeset.ts'
import {
  copyHistory, crossWorkspaceNote, gateRecords, locateCopy, workspaceLabel, type CrossWorkspaceRejection, type GovernanceContext,
} from '../tools/workspace-gate.ts'
import {
  GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, MEMORY_COMMAND_NAME, VIEW_BEHIND_CODES, mergeKeeperIndex, parseMemoryCommand, sessionViewFile, verdictOfAction,
  type ApplyEditOp, type DraftPlanOp, type DroppedLinksEntry, type GuiErrorCode, type MemoryCommand, type MemoryCommandResult, type ProposalSource, type RequestedProposal,
} from './contract.ts'
import type { ViewWriter } from './view-writer.ts'
import { generateDraft } from './model-draft.ts'
import { generateProposal, generateSuggestion, generateVerticalProposal, generateVerticalSuggestion } from './model-suggestion.ts'
import { readSuggestionSources } from './suggestion-source.ts'
import type { ReadEventFn } from '../tools/source.ts'
import { generatePlan } from './model-plan.ts'
import { generatePlanDrafts } from './model-draft-plan.ts'
import { processInterval, runCheckup, type IntervalTimer } from './checkup-run.ts'
import type { ScanCoreDeps } from '../tools/scan.ts'
import type { CheckupSuggestions } from './checkup-suggestions.ts'
import { runOrganize } from './organize-run.ts'
import { INDEX_MAX_TOPICS_DEFAULT } from '../topic-index.ts'
import { sameScope, scopeAt, scopeKey, scopeOfLedger, scopeOfMemory, type Scope } from '../scope.ts'
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
  /** 后台模型的选择表（set-model-selection 写它）。 */
  selections: Pick<ModelSelectionStore, 'set'>
  /** delete-dialogue-records 调它删对话记录库，删不掉要抛；缺省什么都不做（没接对话记录库）。 */
  deleteDialogueRecords?: () => void
  /** set-auto-checkup 写完设置表、重写体检视图后调用：本进程的自动体检调度立刻重算。缺省不通知（没有调度器）。 */
  onAutoCheckupChanged?: () => void
  /** scan 持有范围认领期间的心跳计时；缺省用进程自己的 setInterval。 */
  heartbeat?: IntervalTimer
  /** 主题数上限（organize-index 用，用时读配置）；缺省用默认值。 */
  maxTopics?: () => number
  /** scan 做完之后的后续段（给冲突生成处理建议，不等它跑完就回结果）；缺省不生成。 */
  suggestions?: Pick<CheckupSuggestions, 'run'>
  /** 插件卸载的取消信号：传给 scan 之后的后续段。 */
  signal?: AbortSignal
  /** 建议忽略表（ignore-advice / unignore-advice 写它）。 */
  ignores: AdviceIgnoreStore
  registry: TypeRegistry
  agentsMd: AgentsMdWriter
  views: Pick<ViewWriter, 'request' | 'rewriteAll' | 'collectViews' | 'requestCheckups'>
  /** 宿主会话（与工具共用同一个适配器，exec 只带 agent）：借来的会话 → workspace、子 agent 深度、会话 id；
   *  在它的 agent 上解析模型（null = 拿不到）；list-models 经它取宿主的模型目录（缺省当宿主没有，列出空表）。 */
  host: ContextHost<{ workspacePath: string | undefined; delegationDepth: number; session: { id: string } }> & Pick<HostSession, 'llmOf'> & Partial<Pick<HostSession, 'modelCatalog'>>
  /** 按作用域取指令文件（AGENTS.md / CLAUDE.md）：体检、垂直冲突的建议与采纳都按记忆对应的那份，和借来的会话在哪个项目无关。 */
  instructions: ReadInstructions
  /** 增量体检：体检结果库和整次的 token 上限（见 tools/scan.ts ScanToolDeps）。缺省每次整批重查、用默认上限。 */
  incremental?: Pick<ScanCoreDeps, 'checkupCache' | 'tokenCap'>
  /** 体检开关（用时读配置）；关闭时治理类子命令返回 governance-disabled。缺省视为开启。 */
  isGovernanceEnabled?: () => boolean
  /** 旧 KV 导入是否已结清（导完且旧行已删）；缺省视为已结清。没结清时彻底删除回 failed：续传会把旧快照里的明文放回来。 */
  isLegacyImportSettled?: () => Promise<boolean>
  /** 宿主的读事件服务（用时探测，同 memory_source）：生成处理建议时回查两条记忆的出处。缺省或返回 null 时不带出处。 */
  getReadEvent?: () => ReadEventFn | null
  /** 记忆梦境的侧表：撤销梦境的合并组时记下撤销过的结论。缺省不记。 */
  dreams?: Pick<DreamsStore, 'noteUndoneMerges'>
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
const GOVERNANCE_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['resolve', 'apply-proposal', 'undo', 'promote', 'promote-memory', 'move-memory', 'keep-local', 'keep-local-memory', 'scan', 'suggest', 'draft-proposal'])

/** 不写任何东西的子命令：成功后也不重写视图。 */
const READ_ONLY_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['draft-edit', 'plan-edits', 'draft-plan', 'draft-proposal'])

/** 自己写视图的子命令：成功后不再按常规重写全部视图。 */
const SELF_WRITING_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['scan', 'refresh-views', 'set-auto-checkup', 'set-model-selection'])
// organize-index 不在 SECTION_COMMANDS 里：调模型在锁外，每个操作各进一次写入段

/** 改待决项的子命令，先认领条目再执行，同一条同时只跑一个（resolve、undo 由执行器 executeConfirm、executeUndo 自己认领）。 */
const CLAIMED_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set(['promote', 'keep-local', 'dismiss-overflow'])

/**
 * 一次改一条记忆（合并是一次改两条）的子命令，整条命令在一个写入段里：快照、记忆文件、账本之间拿锁超时不会只做一半
 * （比如改了文件却没留撤销），同进程别的写入也插不进中间。认领的命令已在认领段里；批量命令逐项各占一段，不在这里。
 * 这些命令都不调模型、不等视图写入（视图在命令返回后才重写）。
 */
const SECTION_COMMANDS: ReadonlySet<MemoryCommand['cmd']> = new Set([
  'restore', 'promote-memory', 'keep-local-memory', 'move-memory', 'forget', 'hard-delete', 'confirm', 'edit-memory', 'merge-memories',
])

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
  // 只读，和借来的会话无关：子 agent 会话也能列
  if (command.cmd === 'list-models') return { ok: true, cmd: command.cmd, providers: await listModelChoices(deps.host.modelCatalog?.()) }
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
  } else if (SECTION_COMMANDS.has(command.cmd)) {
    result = await deps.store.writeSection(() => dispatch(deps, command, gov, exec, now))
  } else {
    result = await dispatch(deps, command, gov, exec, now)
  }
  // scan / refresh-views 自己做全量重写，set-auto-checkup、set-model-selection 只重写体检视图
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

/** 撤销的是直接改、直接合并、模型改写与替代、只挂关联、整理索引、记忆梦境的批次：改本身不受体检开关影响，撤销也不受。 */
async function isEditUndo(decisions: PendingDecisionsStore, command: MemoryCommand): Promise<boolean> {
  return command.cmd === 'undo' && (await decisions.listSettled()).some(d => d.id === command.decisionId
    && (kindOf(d) === 'edit' || kindOf(d) === 'index-organize' || kindOf(d) === 'brewing-dreams-run' || kindOf(d) === 'link' || isModelChange(d)))
}

/** 命令结果里的 droppedLinks：没去掉的时候不带这个字段。 */
function droppedField(entries: readonly DroppedLinksEntry[]): { droppedLinks?: DroppedLinksEntry[] } {
  return entries.length > 0 ? { droppedLinks: [...entries] } : {}
}

/** 提升为全局结清时记下的：改前快照，和越界去掉的关联、前提（撤销时核对全局那份要用）。 */
function promotedSettle(r: PromoteResult): { snapshotId?: string; droppedLinks?: LinkIds } {
  const dropped = r.droppedLinks[0]
  return {
    ...(r.snapshotId !== null ? { snapshotId: r.snapshotId } : {}),
    ...(dropped !== undefined ? { droppedLinks: { related: dropped.related, premises: dropped.premises } } : {}),
  }
}

/** 记忆和卡片加载时的版本对不上：updatedAt 变了（插件写过），或卡片内容指纹变了（手改过文件）。 */
function isStale(r: MemoryRecord, base: { updatedAt: number; digest: string }): boolean {
  return r.updatedAt !== base.updatedAt || editFingerprint(r) !== base.digest
}

/** 不改写的结论每条记忆的操作，按条目的记忆顺序（横向 A、B；垂直只有那一条记忆）。 */
const KEEP_OPS = {
  horizontal: { 'keep-a': ['keep', 'forget'], 'keep-b': ['forget', 'keep'], 'keep-both': ['keep', 'keep'] },
  vertical: { 'delete': ['forget'], 'keep-both': ['keep'] },
} as const

/** 冲突条目的样子：横向两条记忆，垂直一条记忆加它对应的指令文件；不是这两种（提升候选、超限、不合规的条目）为 undefined。 */
type ConflictShape = 'horizontal' | 'vertical'
function conflictShape(entry: PendingDecision): ConflictShape | undefined {
  if (kindOf(entry) !== 'conflict') return undefined
  if (entry.baselineRef === undefined) return entry.memoryIds.length === 2 ? 'horizontal' : undefined
  return entry.memoryIds.length === 1 ? 'vertical' : undefined
}

/**
 * 界面带回来的按要求生成的方案，操作和结论对得上：每条记忆恰好一项、按条目顺序；不改写的结论按 KEEP_OPS，
 * 融合是一条改写（正文、名称不空）加一条删除，垂直改写是那条记忆的一条改写。保留方是不是合并规则选的那条，要读到记忆才知道，写入前另查。
 */
function isProposalShaped(proposal: Pick<RequestedProposal, 'action' | 'ops'>, memoryIds: readonly string[], shape: ConflictShape): boolean {
  const { action, ops } = proposal
  if (ops.length !== memoryIds.length || ops.some((op, i) => op.memoryId !== memoryIds[i])) return false
  const kinds = ops.map(op => op.kind)
  const isDraftFilled = ops.every(op => op.kind !== 'edit' || (op.content.trim() !== '' && op.name.trim() !== ''))
  const keeps: Partial<Record<string, readonly string[]>> = KEEP_OPS[shape]
  const kept = keeps[action]
  if (kept !== undefined) return kinds.join() === kept.join()
  if (shape === 'vertical') return action === 'rewrite' && kinds.join() === 'edit' && isDraftFilled
  return action === 'merge' && [...kinds].sort().join() === 'edit,forget' && isDraftFilled
}

/**
 * 「整理所选」各命令的输入校验（模型调用、快照之前）：目标 id 不重复，命令里写了作用域的都是同一个。不合规时给原因。
 * 没写作用域的按会话定位，定位之后再用 isOneScope 核对一次。
 */
function batchRefsProblem(refs: readonly { memoryId: string; layer?: Scope | undefined }[]): string | undefined {
  const ids = refs.map(r => r.memoryId)
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i)
  if (repeated !== undefined) return `同一条记忆选了两次：${repeated}`
  const layers = refs.flatMap(r => (r.layer === undefined ? [] : [r.layer]))
  return layers.every(l => sameScope(l, layers[0]!)) ? undefined : '选中的记忆不在同一个作用域（全局和项目、或不同项目混在一起）'
}

/**
 * draft-plan 的改写项和承接对不上选中的记忆：改写项是选中记忆的无重复子集；承接的记忆在选中里、不是改写项，每条最多被一项承接。不合规时给原因。
 */
function draftOpsProblem(memoryIds: readonly string[], ops: readonly DraftPlanOp[]): string | undefined {
  const rewrites = new Set<string>()
  for (const op of ops) {
    if (!memoryIds.includes(op.memoryId)) return `改写项不在选中的记忆里：${op.memoryId}`
    if (rewrites.has(op.memoryId)) return `同一条改写项列了两次：${op.memoryId}`
    rewrites.add(op.memoryId)
  }
  const absorbed = new Set<string>()
  for (const id of ops.flatMap(op => op.absorbs ?? [])) {
    if (!memoryIds.includes(id)) return `承接的记忆不在选中的记忆里：${id}`
    if (rewrites.has(id)) return `承接的记忆也是改写项：${id}`
    if (absorbed.has(id)) return `同一条记忆被承接了两次：${id}`
    absorbed.add(id)
  }
  return undefined
}

/** apply-edits 的删除项承接不对：into 要指向本批的某个改写项或 keep 里的一条。不合规时给原因。 */
function applyOpsProblem(ops: readonly ApplyEditOp[], keep: readonly { memoryId: string }[]): string | undefined {
  const hosts = new Set([...ops.flatMap(op => (op.kind === 'edit' ? [op.memoryId] : [])), ...keep.map(ref => ref.memoryId)])
  const stray = ops.find(op => op.kind === 'forget' && op.into !== undefined && !hosts.has(op.into))
  return stray === undefined ? undefined : `删除项 ${stray.memoryId} 的承接 ${stray.kind === 'forget' ? stray.into : ''} 不是本批的改写项或核对项`
}

/** 用户在界面里定下的四个面写进去（直接改、直接合并、整理所选的改写项、冲突采纳）：updatedAt、lastConfirmedAt 记为现在；出处、类型、作用域等不动。 */
function withUserEdits(cur: MemoryRecord, fields: { content: string; name: string; summary: string; tags: string[] }, now: number): MemoryRecord {
  // 子 agent 写的待确认记录：用户亲手改过就算升档；已升档的不改写升档来源
  const delegation = isPendingDelegated(cur) ? { delegation: { ...cur.delegation!, reviewed: { by: 'user' as const, at: now } } } : {}
  const { content, name, summary, tags } = fields
  return { ...cur, content, name, summary, tags, updatedAt: now, lastConfirmedAt: now, ...delegation }
}

/** 一批里写成的一项：written 是这一项实际提交的那份，之后的回执、结账都按它。 */
interface BatchWrite { memoryId: string; op: ApplyEditOp['kind']; written: MemoryRecord }

/**
 * 一批里的一项：改写成这四个面，或软删。record 是刚定位到、已核对过等于卡片（或方案依据）版本的那一份：
 * 落盘时在写入段里再按它核对（依据的扫描指纹、要改的字段还是读到时的值）。isSecret 是软删时哪些算含密钥、软删不了（缺省两级都算）。
 */
interface BatchItem {
  record: MemoryRecord
  /** 删除项的 into：这条并进了哪条（融合），历史版本以后归到那条名下。 */
  op: { kind: 'edit'; content: string; name: string; summary: string; tags: string[] } | { kind: 'forget'; into?: MemoryRecord }
}

/** 第一项没做成的原因：锁内发现被改过、已不在，软删时刚被写进密钥，或写入抛错。 */
type BatchFailure = { kind: 'stale' | 'not-found' | 'has-secret'; memoryId: string } | { kind: 'thrown'; error: unknown }

/**
 * 一批的结果：全做成了；或没做成，已做的按回执撤回（kept 是撤回出错、仍是这次写下的；unrecorded 是已被别处接着改过的）。
 * release：这次运行占着整理记录，调用方结完账调它放开。
 */
type BatchResult =
  | { kind: 'done'; runId: string; writes: BatchWrite[] }
  | { kind: 'failed'; runId: string; failure: BatchFailure; kept: BatchWrite[]; unrecorded: string[] }
type BatchOutcome = BatchResult & { release: () => Promise<void> }

/**
 * 整理所选、按方案处理冲突的逐项执行：组成一个变更集交给执行器，每项各占一次写入段、各记一条回执（先记在一条临时的整理记录 runId 上）。
 * 一项对不上整批退：已做的按回执逆序撤回。also 是只核对、不写的记忆（整理所选的「不动」项）：和这一批的每一条一起当依据，
 * 期间任何一条内容变了，后面的都不做。
 */
async function runBatch(
  items: readonly BatchItem[], also: readonly MemoryRecord[], input: { summary: string; isSecret?: (current: MemoryRecord) => boolean },
  deps: Pick<MemoryCommandDeps, 'store' | 'snapshots' | 'decisions'>, now: number,
): Promise<BatchOutcome> {
  const runId = genId('pd')
  // 依据按卡片上的版本指纹比，和进来时的版本核对同一个口径：两处之间落进来的改动（别的会话补证）同样算被改过
  const basis = [...items.map(item => item.record), ...also].map(r => ({ ...basisOf(r), fingerprint: editFingerprint(r) }))
  const ops: ChangeOp[] = items.map(({ record, op }, i) => ({
    id: `o${i + 1}`, memoryId: record.id, scopeKey: scopeKeyOf(record), basis,
    ...(op.kind === 'forget'
      ? { kind: 'forget' as const, ...(op.into !== undefined ? { into: { memoryId: op.into.id, scopeKey: scopeKeyOf(op.into), as: 'merge' as const } } : {}) }
      : {
          kind: 'edit' as const,
          patch: { content: op.content, name: op.name, summary: op.summary, tags: op.tags },
          expect: { content: record.content, name: record.name, summary: record.summary, tags: record.tags },
        }),
  }))
  // 逐项写的这段时间占着整理记录：它已经在账本里，另一个标签页这时撤销它会撤掉前几项、拿走条目，后几项就没有撤销入口了
  const held = await deps.decisions.hold(runId)
  const release = async () => { await held?.().catch(() => {}) }
  try {
    return { ...(await runHeld()), release }
  } catch (error) {
    await release()
    throw error
  }

  async function runHeld(): Promise<BatchResult> {
  const recorded = async () => (await deps.decisions.listSettled()).find(d => d.id === runId)
  try {
    await deps.decisions.addChangeRun(runId, {
      kind: 'edit', summary: input.summary, memoryIds: items.map(item => item.record.id), workspaces: items.map(item => workspaceLabel(item.record)),
    }, 'batch-edited', now)
  } catch (error) {
    // 写进去之后才抛错（清扫过期条目出错）：整理记录已在就接着做
    if ((await recorded().catch(() => undefined)) === undefined) throw error
  }
  const r = await applyChangeset(ops, {
    entryId: runId, by: 'gui', at: now, isSecretChecked: false, isAllOrNothing: true, isUserConfirmed: true, fingerprint: editFingerprint, ...(input.isSecret !== undefined ? { isSecret: input.isSecret } : {}),
  }, deps)
  // 稿和现在的内容一模一样的那一项没有可写的：照做成了算（写下的就是现在这份），不让它从结果里消失
  const unchanged = (memoryId: string) => items.find(item => item.record.id === memoryId)?.record
  const applied = r.outcomes.flatMap((o): BatchWrite[] => {
    if (o.kind === 'applied') return [{ memoryId: o.memoryId, op: o.opKind === 'forget' ? 'forget' : 'edit', written: o.written }]
    const same = o.kind === 'skipped' && o.reason === 'no-change' ? unchanged(o.memoryId) : undefined
    return same === undefined ? [] : [{ memoryId: o.memoryId, op: 'edit', written: same }]
  })
  if (r.isRolledBack !== true) return { kind: 'done', runId, writes: applied }
  const skipped = r.outcomes.find(o => o.kind === 'skipped' && o.reason !== 'no-change')
  // 拼出的记录过不了格式校验不是「被改过」：当出错报，带上原因
  const invalid = skipped?.kind === 'skipped' && (skipped.reason === 'invalid' || skipped.reason === 'link-invalid') ? new Error(skipped.detail ?? '改后的记忆不合格式') : undefined
  const failure: BatchFailure = r.thrown !== undefined || invalid !== undefined || skipped?.kind !== 'skipped'
    ? { kind: 'thrown', error: r.thrown ?? invalid }
    : { kind: skipped.reason === 'gone' ? 'not-found' : skipped.reason === 'has-secret' ? 'has-secret' : 'stale', memoryId: skipped.memoryId }
  return { kind: 'failed', runId, failure, kept: applied.filter(w => r.kept?.includes(w.memoryId) === true), unrecorded: r.unrecorded ?? [] }
  }
}

/**
 * 一批的结账：删除项按 id 清掉指向它们的账本条目（同 forget，keepId 那条留着），再把那条整理记录收尾（补上给旧版本读的整条回执）。
 * 一项都没留下的，整理记录移出账本，返回 undefined。
 */
async function settleBatch(
  runId: string, writes: readonly BatchWrite[], deps: Pick<MemoryCommandDeps, 'decisions'>, keepId?: string,
): Promise<PendingDecision | undefined> {
  try {
    const forgotten = writes.filter(w => w.op === 'forget').map(w => w.memoryId)
    if (forgotten.length > 0) await deps.decisions.removeByMemoryIds(forgotten, keepId === undefined ? runId : [runId, keepId])
    return await deps.decisions.finishChangeRun(runId, { writes, summary: `整理所选 ${writes.length} 条`, workspaces: writes.map(w => workspaceLabel(w.written)) })
  } catch (error) {
    // 收尾抛错时重读账本：整理记录在、回执也在，就算记上了（撤销按回执做，不靠收尾补的那几项）
    const recorded = (await deps.decisions.listSettled().catch(() => [])).find(d => d.id === runId)
    if (recorded?.changes !== undefined && recorded.changes.length > 0) return recorded
    throw error
  }
}

/** 定位到的记忆都在同一个作用域。 */
const isOneScope = (records: readonly MemoryRecord[]) => new Set(records.map(r => scopeKey(scopeAt(r.workspacePath)))).size <= 1

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
  command: Exclude<MemoryCommand, { cmd: 'info' | 'model-info' | 'list-models' }>,
  gov: GovernanceContext,
  exec: ToolRunContext,
  now: number,
): Promise<MemoryCommandResult> {
  const { cmd } = command
  const executorDeps = { store: deps.store, decisions: deps.decisions, snapshots: deps.snapshots, log: deps.log, instructions: deps.instructions, now: () => now }
  const notFound = (what: string) => fail(cmd, 'not-found', `不存在或已处理：${what}`)
  /** 界面落后于磁盘（卡片版本对不上、要动的已经不在）：失败结果带上是哪几条，界面据此等视图换成最新内容。 */
  const behind = (code: 'stale' | 'not-found', memoryIds: readonly string[], detail: string): Err => ({ ...fail(cmd, code, detail), memoryIds: [...memoryIds] })
  /** 与 memory_save 同口径：要写进去的四个面一起查，高危直接拦，疑似等用户确认后带 allowSecret 重发。 */
  const editSecretsProblem = (edits: readonly { content: string; name: string; summary: string; tags: string[] }[], allowSecret: boolean | undefined): Err | undefined => {
    const hits = detectSecrets(edits.map(f => `${f.content}\n${f.name}\n${f.summary}\n${f.tags.join(' ')}`).join('\n'))
    const names = (severity: 'critical' | 'suspected') => [...new Set(hits.filter(h => h.severity === severity).map(h => h.name))].join('、')
    if (names('critical') !== '') return fail(cmd, 'secret-critical', `检测到高危密钥（${names('critical')}），未保存`)
    if (names('suspected') !== '' && allowSecret !== true) return fail(cmd, 'secret-suspected', `检测到疑似密钥（${names('suspected')}），未保存；确认不是密钥后带 allowSecret 重发`)
    return undefined
  }
  // 撤销与最近删除的恢复：时钟现读，恢复收尾要判快照是不是途中刚过期被清扫，用命令开头的时刻判不出来
  const undoDeps = {
    store: deps.store, decisions: deps.decisions, snapshots: deps.snapshots, ignores: deps.ignores, now: () => deps.now?.() ?? Date.now(),
    ...(deps.dreams !== undefined ? { dreams: deps.dreams } : {}), ...(deps.log !== undefined ? { log: deps.log } : {}),
  }
  const fromUndo = (r: UndoResult): MemoryCommandResult => (r.kind === 'error'
    ? fail(cmd, r.code, r.message, r.rejected)
    : {
        ok: true, cmd, decisionId: r.decisionId, memoryIds: r.restored, ...(r.snapshotId !== undefined ? { snapshotId: r.snapshotId } : {}), ...(r.skipped !== undefined ? { undoSkipped: r.skipped } : {}),
        ...droppedField(r.droppedLinks ?? []),
      })

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
  /**
   * 「整理所选」各命令的定位与核对：按页面上那一份定位，都还在用（否则 not-found）、在同一个作用域（否则 invalid-args）、
   * 版本和卡片对得上（否则 stale）；not-found、stale 带上是哪几条。都过了返回定位到的记忆，顺序同 refs。
   */
  const locateBatch = async (refs: readonly { memoryId: string; layer?: Scope | undefined; base: { updatedAt: number; digest: string } }[]): Promise<MemoryRecord[] | Err> => {
    const located = await Promise.all(refs.map(ref => locate(ref.memoryId, ref.layer)))
    const gone = refs.filter((_, i) => located[i]?.status !== 'active').map(ref => ref.memoryId)
    if (gone.length > 0) return behind('not-found', gone, `不存在或已处理：${gone.join('、')}`)
    const records = located as MemoryRecord[]
    if (!isOneScope(records)) return fail(cmd, 'invalid-args', '选中的记忆不在同一个作用域（全局和项目、或不同项目混在一起）')
    const staleIds = refs.filter((ref, i) => isStale(records[i]!, ref.base)).map(ref => ref.memoryId)
    if (staleIds.length > 0) return behind('stale', staleIds, '有记忆刚被改过，界面已换成最新内容。未做任何改动')
    return records
  }

  /** 结清这次提升或留下，返回条目 id。 */
  type SettleCandidate = (verdict: 'promoted' | 'keep-local', opts: { snapshotId?: string; fingerprint?: string; misplacedIgnore?: MisplacedIgnore; droppedLinks?: LinkIds }) => Promise<string>
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

  /**
   * 裁决一条冲突（直接选，或采纳建议 adopt）。结果同一种形状：败方含高危密钥已物理删除时 isHardDeleted，结论没记下时 isUnrecorded，
   * 记了快照的带 snapshotId 供撤销。
   */
  const resolveConflict = async (
    decisionId: string, verdict: 'keep-left' | 'keep-right' | 'keep-both', allowCrossWorkspace: boolean | undefined,
    adopt?: { basis: NonNullable<ConfirmOptions['adopt']>; memoryIds: string[] },
  ): Promise<MemoryCommandResult> => {
    // 垂直冲突：采纳时核对依据里的基线；升级前导入的没有指纹，两边都留时要按这条记忆对应的指令文件现算
    const r = await executeConfirm(
      { action: 'resolve', decisionId, verdict, allowCrossWorkspace },
      gov, executorDeps, adopt !== undefined ? { adopt: adopt.basis } : {},
    )
    if (r.kind === 'error') {
      if (r.code === 'cross-workspace') return fail(cmd, 'cross-workspace', r.message, r.rejected)
      if (r.code === 'stale') return behind('stale', adopt?.memoryIds ?? [], r.message)
      // 认领之后重读才发现条目没了（刚被别处裁决完）：和一开始就查不到同一个说法
      if (r.code === 'not-found') return notFound(decisionId)
      return fail(cmd, r.code ?? 'failed', r.message)
    }
    if (r.kind === 'resolved' && r.isUnrecorded) return { ok: true, cmd, decisionId, isUnrecorded: true }
    if (r.kind === 'resolved' && r.isHardDeleted) return { ok: true, cmd, decisionId, isHardDeleted: true }
    const snapshotId = (await settledEntry(decisionId))?.settled?.snapshotId
    return { ok: true, cmd, decisionId, ...(snapshotId !== undefined ? { snapshotId } : {}) }
  }

  // —— 采纳融合建议（票 06）、按要求融合（票 07）、垂直冲突改写这条记忆（票 10）——

  /**
   * 改写记忆要落盘的方案：结论（融合、垂直改写）、来源、逐条操作、依据版本；按要求的方案带用户对疑似密钥的确认（allowSecret）。
   * 采纳建议时由认领后重读的条目给出（建议已换了一份或结论不同为 undefined，按依据失效算）。
   */
  type RewritePlan = { action: 'merge' | 'rewrite'; source: ProposalSource; ops: readonly ProposalOp[]; basis: SuggestionBasis; allowSecret?: boolean | undefined }

  /**
   * 先认领条目、再认领冲突身份（同要删一方的裁决），和裁决、撤销、体检挂账、另一个标签页的采纳互斥；认领后重读条目再动手。
   */
  const adoptPlan = async (decisionId: string, planOf: (entry: PendingDecision) => RewritePlan | undefined, allowCrossWorkspace: boolean | undefined): Promise<MemoryCommandResult> => {
    const claimed = await deps.decisions.withClaim(decisionId, async () => {
      const entry = await deps.decisions.get(decisionId)
      if (entry === undefined) return notFound(decisionId)
      const paired = await deps.decisions.withPairClaim(entry, () => planClaimed(entry, planOf(entry), allowCrossWorkspace))
      return paired.isClaimed ? paired.value : fail(cmd, 'claimed', `待决项 ${entry.id} 的这一对记忆正在被另一次操作处理，未做任何改动`)
    })
    return claimed.isClaimed ? claimed.value : fail(cmd, 'claimed', `待决项 ${decisionId} 正在被另一次操作处理，未做任何改动`)
  }

  /**
   * 持有认领时按方案改写记忆：核对方案还在（采纳建议时建议 id 一致）和依据（冲突指纹、涉及记忆的完整内容指纹和作用域键）。
   * 融合：保留方改写成融合稿、另一条软删；垂直改写：那条记忆改写成改写稿，另按这条记忆此刻对应的指令文件核对依据里的基线（取不到
   * 或指令文件改过按失效算），指令文件不碰。用整理所选的逐项执行（写入那一刻锁内按依据里的指纹再比一次）。整批一份快照。
   * 结账自己做（plan-applied，见 settlePlanned）；某一项没写成时同整理所选：已写的按写入记录条件回退，没退干净的仍是这次写下的照常记一笔可撤销的账，
   * 别处接着改过的列进 unrecordedIds，冲突条目不结清。允许全局与项目之间的冲突（写进哪条由生成建议时的合并规则定）。
   */
  const planClaimed = async (entry: PendingDecision, plan: RewritePlan | undefined, allowCrossWorkspace: boolean | undefined): Promise<MemoryCommandResult> => {
    const isRewrite = plan?.action === 'rewrite'
    const subject = isRewrite ? '这条记忆' : '这两条'
    const draftName = isRewrite ? '改写稿' : '融合稿'
    const stale = () => behind('stale', entry.memoryIds, plan?.source === 'request'
      ? `${subject}${isRewrite ? '或指令文件' : ''}在方案生成后被改过，处理方案已失效。未做任何改动`
      : `${subject}${isRewrite ? '或指令文件' : ''}刚被改过或建议已换了一份，建议已失效。未做任何改动`)
    if (plan === undefined) return stale()
    // 同裁决的定位口径；不在用的按对不上算
    const located = await Promise.all(entry.memoryIds.map(id => locate(id, undefined)))
    const live = located.map(r => (r?.status === 'active' ? r : undefined))
    if (!isBasisCurrent(entry, plan.basis, live)) return stale()
    const records = live as MemoryRecord[]
    const edit = plan.ops.find(op => op.kind === 'edit')
    const keeper = records.find(r => r.id === edit?.memoryId)
    const loser = records.find(r => r.id !== keeper?.id && plan.ops.some(op => op.kind === 'forget' && op.memoryId === r.id))
    // 垂直改写：采纳时按这条记忆此刻对应的指令文件重算，和依据里记的对上才执行
    const baseline = isRewrite ? await baselineFor(deps.instructions, records[0]!) : null
    if (isRewrite && !isBaselineCurrent(plan.basis, baseline)) return stale()
    // 写进哪条按合并规则定（全局优先，其次先建的）：界面带回来的方案也不能把融合稿写到另一条上
    const isShaped = isRewrite
      ? plan.ops.length === 1 && edit?.kind === 'edit' && keeper === records[0]
      : edit?.kind === 'edit' && keeper !== undefined && loser !== undefined && records[mergeKeeperIndex(records as [MemoryRecord, MemoryRecord])] === keeper
    if (!isShaped || edit?.kind !== 'edit' || keeper === undefined) {
      return fail(cmd, 'invalid-args', isRewrite ? `待决项 ${entry.id} 的改写方案不是这条记忆的一条改写，未做任何改动` : `待决项 ${entry.id} 的融合方案不是保留方一条改写加另一条删除，未做任何改动`)
    }
    const { rejected } = gateRecords(records, gov, allowCrossWorkspace)
    if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
    // 建议存盘时已保证稿里的疑似值都出自原文，采纳不再等确认；按要求的稿等用户确认（allowSecret）。高危照拦
    const secretProblem = editSecretsProblem([edit], plan.source === 'suggestion' ? true : plan.allowSecret)
    if (secretProblem !== undefined) return secretProblem

    const what = isRewrite ? (plan.source === 'request' ? '按要求改写' : '采纳改写建议') : (plan.source === 'request' ? '按要求融合' : '采纳融合建议')
    // 两条都当依据：哪一条的内容在这之后变了，都不往里写、也不按它删另一条
    const ran = await runBatch([
      { record: keeper, op: edit },
      ...(loser !== undefined && !isRewrite ? [{ record: loser, op: { kind: 'forget' as const, into: keeper } }] : []),
    // 疑似密钥是用户存下时确认过的，照常软删、可恢复；只有高危软删不了（依据比对已先挡下，这里是锁内兜底）
    ], isRewrite ? [] : records.filter(r => r !== keeper && r !== loser), { summary: `${what}（${entry.id}）`, isSecret: hasCriticalSecret }, deps, now)
    try {
    let left: { kept: BatchWrite[]; unrecorded: string[] }
    if (ran.kind === 'done') {
      const unsettled = await settlePlanned(entry, plan, ran.runId, ran.writes, isRewrite ? baseline ?? undefined : undefined)
      if (unsettled === undefined) {
        const snapshotId = (await deps.decisions.listSettled().catch(() => [])).find(d => d.id === entry.id)?.settled?.snapshotId
        return { ok: true, cmd, decisionId: entry.id, memoryIds: ran.writes.map(w => w.memoryId), ...(snapshotId !== undefined ? { snapshotId } : {}) }
      }
      left = unsettled
    } else {
      left = ran
      if (left.kept.length === 0 && left.unrecorded.length === 0) {
        await deps.decisions.finishChangeRun(ran.runId, { writes: [] }).catch(() => {})
        const { failure } = ran
        if (failure.kind === 'thrown') throw failure.error
        if (failure.kind === 'has-secret') return fail(cmd, 'has-secret', `记忆 ${failure.memoryId} 刚被写进密钥，没有删除；${draftName}已退回`)
        return behind(failure.kind, [failure.memoryId], `${subject}刚被改过，界面已换成最新内容；${draftName}已退回`)
      }
    }
    // 没退干净的记一笔可撤销的账（冲突条目留着，不结清）；账也记不上的列进没记上账的，改前的内容仍在各自的撤销快照里
    const { kept } = left
    const batch = await settleBatch(ran.runId, kept, deps, entry.id).catch(() => undefined)
    return {
      ok: true, cmd, ...(batch !== undefined ? { decisionId: batch.id } : {}), memoryIds: batch !== undefined ? kept.map(w => w.memoryId) : [],
      ...(batch?.settled?.snapshotId !== undefined ? { snapshotId: batch.settled.snapshotId } : {}),
      isPartial: true, unrecordedIds: batch !== undefined || kept.length === 0 ? left.unrecorded : [...left.unrecorded, ...kept.map(w => w.memoryId)],
    }
    } finally {
      await ran.release()
    }
  }

  /**
   * 按方案改写的结账：冲突条目结清为 plan-applied，这次的逐操作回执从整理记录挪到它上面（撤销按它们逐个还原），改后指纹按写下的那几份算
   * （垂直改写再加这条记忆对应的指令文件，同体检）；结清之后才清掉引用被删那条的其他条目（冲突条目自己留着；垂直改写没有被删的），
   * 结清不成时那些条目原样留着。结清之后重读被删的那条：已被别处彻底删除就把这条结清也撤掉（彻底删除的连带清理可能正好落在结清的读写之间）；
   * 改写的那条被别处删掉同理。任一步抛错时重读账本：已结清就算记上了；没有就按回执撤回，撤干净了把错误抛出去，没撤干净的交回调用方如实报「部分完成」。
   * 结清了返回 undefined。
   */
  const settlePlanned = async (
    entry: PendingDecision, plan: RewritePlan, runId: string, writes: readonly BatchWrite[], baseline: readonly string[] | undefined,
  ): Promise<{ kept: BatchWrite[]; unrecorded: string[] } | undefined> => {
    const changes = await receiptsOfEntry(deps.decisions, runId)
    const snapshotId = changes.find(c => c.snapshotId !== undefined)?.snapshotId ?? ''
    try {
      const written = new Map(writes.map(w => [w.memoryId, w.written]))
      const isSettled = await deps.decisions.settlePlan(entry.id, {
        writes, changes,
        proposal: { source: plan.source, action: plan.action }, snapshotId,
        fingerprint: conflictFingerprint(entry.memoryIds.map(id => written.get(id)!), baseline),
        memberScanFingerprints: memberScanFingerprints(entry.memoryIds.map(id => written.get(id)!)),
      }, now)
      if (!isSettled) throw new Error(`待决项 ${entry.id} 已不在待处理，这次${plan.action === 'rewrite' ? '改写' : '融合'}没有记上`)
      // 回执已经在冲突条目上：临时的整理记录不再留
      await deps.decisions.remove(runId).catch(() => {})
      for (const w of writes.filter(w => w.op === 'forget')) {
        const scope = scopeOfMemory(w.written)
        if (scope !== undefined && (await locateCopy(deps.store, w.memoryId, scope)) === undefined) {
          await deps.decisions.dropDependingOn(new Set(changes.flatMap(c => (c.snapshotId !== undefined ? [c.snapshotId] : []))), w.memoryId)
        }
      }
      await deps.decisions.removeByMemoryIds(writes.filter(w => w.op === 'forget').map(w => w.memoryId), entry.id)
      // 改写的那条同理：结清的读写之间被别处删掉，删除的连带清理已经跑过，这条结清（连同建议稿）是被写回来的，照删除的规矩清掉
      const dropped: string[] = []
      for (const w of writes.filter(w => w.op === 'edit')) {
        const scope = scopeOfMemory(w.written)
        if (scope !== undefined && (await locateCopy(deps.store, w.memoryId, scope))?.status !== 'active') dropped.push(w.memoryId)
      }
      if (dropped.length > 0) await deps.decisions.removeByMemoryIds(dropped)
      return undefined
    } catch (error) {
      const recorded = (await deps.decisions.listSettled().catch(() => []))
        .some(d => d.id === entry.id && d.settled?.verdict === 'plan-applied' && d.settled.snapshotId === snapshotId)
      if (recorded) {
        await deps.decisions.remove(runId).catch(() => {})
        return undefined
      }
      const left = await rollBackEntry(runId, { by: 'gui' }, deps)
      if (left.kept === undefined && left.unrecorded === undefined) {
        await deps.decisions.finishChangeRun(runId, { writes: [] }).catch(() => {})
        throw error
      }
      return { kept: writes.filter(w => left.kept?.includes(w.memoryId) === true), unrecorded: left.unrecorded ?? [] }
    }
  }

  switch (command.cmd) {
    case 'resolve': {
      if (!(await deps.decisions.get(command.decisionId))) return notFound(command.decisionId)
      return await resolveConflict(command.decisionId, command.verdict, command.allowCrossWorkspace)
    }

    case 'apply-proposal': {
      const entry = await deps.decisions.get(command.decisionId)
      if (entry === undefined) return notFound(command.decisionId)
      const shape = conflictShape(entry)
      if (shape === undefined) return fail(cmd, 'invalid-args', `待决项 ${entry.id} 不是冲突，没有可采纳的建议`)
      const { proposal } = command
      if (proposal !== undefined) {
        // 按要求生成的方案由界面带回：先查操作和结论对得上，落盘时按带回的依据版本核对（认领后、锁内各一次）
        if (!isProposalShaped(proposal, entry.memoryIds, shape)) return fail(cmd, 'invalid-args', `处理方案的操作和结论对不上（${proposal.action}），未做任何改动`)
        const verdict = verdictOfAction(proposal.action)
        if (verdict === undefined) {
          const action = proposal.action === 'rewrite' ? 'rewrite' : 'merge'
          return await adoptPlan(entry.id, () => ({ action, source: 'request', ops: proposal.ops, basis: proposal.basis, allowSecret: command.allowSecret }), command.allowCrossWorkspace)
        }
        return await resolveConflict(entry.id, verdict, command.allowCrossWorkspace, { basis: { request: { action: proposal.action, basis: proposal.basis } }, memoryIds: entry.memoryIds })
      }
      const { suggestion } = entry
      const stale = () => behind('stale', entry.memoryIds, `${shape === 'vertical' ? '这条记忆' : '这两条'}刚被改过或建议已换了一份，建议已失效。未做任何改动`)
      if (suggestion === undefined || suggestion.id !== command.suggestionId) return stale()
      // 结论按账本上这一份定，不信界面；认领条目后执行器再核对一次 id 和依据
      const verdict = verdictOfAction(suggestion.action)
      if (verdict === undefined) {
        const { id: suggestionId, action } = suggestion
        if (action !== 'merge' && action !== 'rewrite') return stale()
        return await adoptPlan(entry.id, current => (current.suggestion?.id === suggestionId && current.suggestion.action === action
          ? { action, source: 'suggestion', ops: current.suggestion.ops, basis: current.suggestion.basis }
          : undefined), command.allowCrossWorkspace)
      }
      return await resolveConflict(entry.id, verdict, command.allowCrossWorkspace, { basis: { suggestionId: suggestion.id }, memoryIds: entry.memoryIds })
    }

    case 'undo': {
      // 整理索引、记忆梦境还在跑的时候不撤它那一条：回执还在往上记（两者和体检共用一个范围认领）
      const run = (await deps.decisions.listSettled()).find(d => d.id === command.decisionId && (kindOf(d) === 'index-organize' || kindOf(d) === 'brewing-dreams-run'))
      const organizing = run?.workspaces?.[0]
      if (organizing !== undefined && await deps.checkups.isInProgress(scopeOfLedger(organizing))) return fail(cmd, 'busy', '这个范围正在整理或体检，做完再撤')
      return fromUndo(await executeUndo({ decisionId: command.decisionId, snapshotId: command.snapshotId, op: command.op, allowCrossWorkspace: command.allowCrossWorkspace }, gov, undoDeps))
    }

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
      if (command.target === 'global') await deps.decisions.settle(entry.id, 'promoted', now, promotedSettle(r))
      else await deps.decisions.remove(entry.id)
      return { ok: true, cmd, decisionId: entry.id, memoryIds: r.promoted.map(p => p.id), ...(r.snapshotId !== null ? { snapshotId: r.snapshotId } : {}), ...droppedField(r.droppedLinks) }
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
        const decisionId = target === 'global' ? await settle('promoted', promotedSettle(r)) : await drop()
        return { ok: true, cmd, ...(decisionId !== undefined ? { decisionId } : {}), memoryIds: r.promoted.map(p => p.id), ...(r.snapshotId !== null ? { snapshotId: r.snapshotId } : {}), ...droppedField(r.droppedLinks) }
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
      // 只搬全局这一份（只认层）：内容、id、出处、时间戳不动；撞名由文件表按规则换文件名。
      // 在写入段里按目标项目重验关联和前提：指向别的项目的（手改出来的）去掉。
      // 按快照里的这一版算：锁内内容和它不一样（期间被改过）就不搬、不记账，算出来的、记下的就是实际搬走的那一版
      let written: MemoryRecord | undefined
      let isChangedInLock = false
      let dropped: LinkIds = { related: [], premises: [] }
      try {
        written = await deps.store.writeSection(async () => {
          dropped = await linksOutside(deps.store, rec, { kind: 'workspace', workspacePath })
          return deps.store.update(rec, (cur) => {
            if (cur.status !== 'active') throw new RecordNotFoundError(cur.id)
            if (editFingerprint(cur) !== editFingerprint(rec)) {
              isChangedInLock = true
              throw new RecordNotFoundError(cur.id)
            }
            return { ...withoutLinks(cur, dropped), scope: 'workspace', workspacePath }
          }, { kind: 'global' })
        })
      } catch (error) {
        if (!(error instanceof RecordNotFoundError)) throw error
      }
      if (isChangedInLock) return fail(cmd, 'stale', '这条记忆刚被改过，界面已换成最新内容。未做任何改动')
      if (written === undefined) return notFound(memoryId)
      // 去掉的记进账本：撤销时从改前快照放回去
      const entry = await deps.decisions.addMove(written, { summary: rec.summary, workspace: workspacePath, ...(hasDropped(dropped) ? { droppedLinks: dropped } : {}) }, snapshot.id, now)
      const located = await deps.store.locate(rec.id, scopeAt(workspacePath))
      return {
        ok: true, cmd, decisionId: entry.id, memoryIds: [rec.id], snapshotId: snapshot.id, ...(located !== undefined ? { filePath: located.filePath } : {}),
        ...droppedField(hasDropped(dropped) ? [{ id: rec.id, ...dropped }] : []),
      }
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
          if (!(await deps.store.hardDelete(rec, { at: scopeAt(rec.workspacePath), isHistoryCarried: true }, current => (isRestored = current.status !== 'deleted')))) {
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
      // 读到之后被别处改过或搬走：没删，不能报成功
      if (r.skipped.length > 0) return { ...fail(cmd, 'stale', `记忆 ${command.memoryId} 刚在别处被改过或移动，没有删除`), memoryIds: [command.memoryId] }
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
      const secretProblem = editSecretsProblem([command], command.allowSecret)
      if (secretProblem !== undefined) return secretProblem

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
          return (mine = withUserEdits(cur, command, now))
        }, own)
      } catch (error) {
        if (!(error instanceof RecordNotFoundError)) throw error
      }
      if (mine === undefined) return stale()
      // 另一条走删除的老路：软删进最近删除，账本里指向它的条目一并清掉（同 forget）；快照上面已经拍过。
      // 锁内再按卡片版本核对一次：核对之后被改过的不删，保留的那条退回改前（之间没被别处再改的话），整体回 stale；
      // 核对之后另一个会话才写进密钥的不删，这次只算改了保留的那条。卡片指纹含标签在内的全部内容字段，写进密钥必然先判成被改过，
      // 这一支在卡片路径上走不到，只留作密钥的防线
      const outcome = removed === undefined ? 'deleted'
        : await deps.store.softDeleteUnlessSecret(removed.record, {
            at: scopeAt(removed.record.workspacePath), now, isChanged: cur => cur.status !== 'active' || isStale(cur, removed.base),
            // 历史版本以后归到保留的那条名下
            mergedInto: { id: kept.record.id, scopeKey: scopeKeyOf(kept.record), as: 'merge' },
          })
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
        memoryIds, summary: command.name, workspaces: memoryIds.map(id => workspaceLabel(targets.find(t => t.record.id === id)!.record)),
      }, memoryIds.length === 2 ? 'merged' : 'edited', snapshot.id, now)
      if (!isRemoved) return fail(cmd, 'has-secret', `保留的那条已改好；另一条（${removed!.record.id}）刚被写进密钥，没有删除`)
      const located = await deps.store.locate(kept.record.id, own)
      return { ok: true, cmd, decisionId: entry.id, memoryIds, snapshotId: snapshot.id, ...(located !== undefined ? { filePath: located.filePath } : {}) }
    }

    case 'apply-edits': {
      const { ops } = command
      const keep = command.keep ?? []
      const refs = [...ops, ...keep]
      const problem = batchRefsProblem(refs) ?? applyOpsProblem(ops, keep)
      if (problem !== undefined) return fail(cmd, 'invalid-args', problem)
      // 都按页面上那一份定位，且此刻仍在用：已删、不存在的什么都不动；ops 和 keep 都核对版本：删除依据涉及的「不动」项被改过，删除的理由可能已不成立
      const records = await locateBatch(refs)
      if (isErr(records)) return records
      const targets = ops.map((op, i) => ({ op, record: records[i]! }))
      // keep 只核对版本、不写，不过门
      const { rejected } = gateRecords(targets.map(t => t.record), gov, command.allowCrossWorkspace)
      if (rejected.length > 0) return fail(cmd, 'cross-workspace', crossWorkspaceNote(rejected, []), rejected)
      // 改写的目标含高危密钥：界面上是遮盖后的正文（同直接改）；删除的目标含密钥（疑似也算）软删不了（同合并要删的那条）
      const secretHeld = targets.find(t => (t.op.kind === 'edit' ? hasCriticalSecret(t.record) : hasSecret(t.record)))
      if (secretHeld !== undefined) return fail(cmd, 'has-secret', `记忆 ${secretHeld.record.id} 含密钥，不能在这里整理：先彻底删除它，或手改文件去掉密钥。未做任何改动`)
      const secretProblem = editSecretsProblem(ops.flatMap(op => (op.kind === 'edit' ? [op] : [])), command.allowSecret)
      if (secretProblem !== undefined) return secretProblem

      // 逐项各占一次写入段、各拍各的改前快照；「不动」项和这一批的每一条都当依据，写入段里按刚读到的再核对一次
      // 删除项的承接（into）就是它并进的那条：历史版本以后归到那条名下
      const absorbed = (op: (typeof ops)[number]) => {
        const host = op.kind === 'forget' && op.into !== undefined ? records.find(r => r.id === op.into) : undefined
        return op.kind === 'forget' ? { kind: 'forget' as const, ...(host !== undefined ? { into: host } : {}) } : op
      }
      const ran = await runBatch(targets.map(({ op, record }) => ({ record, op: absorbed(op) })), records.slice(ops.length), { summary: `整理所选 ${ops.length} 条` }, deps, now)
      try {
      if (ran.kind === 'done') {
        const entry = await settleBatch(ran.runId, ran.writes, deps)
        return {
          ok: true, cmd, ...(entry !== undefined ? { decisionId: entry.id } : {}), memoryIds: ran.writes.map(w => w.memoryId),
          ...(entry?.settled?.snapshotId !== undefined ? { snapshotId: entry.settled.snapshotId } : {}),
        }
      }
      // 中途没做成：已写的按回执撤回了
      const { failure, kept, unrecorded } = ran
      if (kept.length === 0 && unrecorded.length === 0) {
        await deps.decisions.finishChangeRun(ran.runId, { writes: [] }).catch(() => {})
        if (failure.kind === 'thrown') throw failure.error
        // 锁内写进密钥必然先判成被改过，这一支只留作密钥的防线
        if (failure.kind === 'has-secret') return fail(cmd, 'has-secret', `记忆 ${failure.memoryId} 刚被写进密钥，没有删除；已写的都已退回`)
        return behind(failure.kind, [failure.memoryId], '有记忆刚被改过，界面已换成最新内容；已写的都已退回')
      }
      // 没退干净：仍是本批写下的照常结账、可撤销；被别处接着改过的停在别处的版本，列出来、不可撤销
      const entry = await settleBatch(ran.runId, kept, deps)
      return {
        ok: true, cmd, ...(entry !== undefined ? { decisionId: entry.id } : {}), memoryIds: kept.map(w => w.memoryId),
        ...(entry?.settled?.snapshotId !== undefined ? { snapshotId: entry.settled.snapshotId } : {}),
        isPartial: true, unrecordedIds: unrecorded,
      }
      } finally {
        await ran.release()
      }
    }

    case 'draft-edit': {
      const refs = command.memories
      const absorbs = command.absorbs ?? []
      if (refs.length === 2 && refs[0].memoryId === refs[1]!.memoryId) return fail(cmd, 'invalid-args', `要合并的两条是同一条记忆：${refs[0].memoryId}`)
      // 并入的记忆不与要改的重复、和要改的在同一个作用域（同整理所选），定位之后再核对一次
      const absorbProblem = absorbs.length > 0 ? batchRefsProblem([...refs, ...absorbs]) : undefined
      if (absorbProblem !== undefined) return fail(cmd, 'invalid-args', absorbProblem)
      const targets = [...refs, ...absorbs]
      const records = await Promise.all(targets.map(ref => locate(ref.memoryId, ref.layer)))
      const gone = targets.filter((_, i) => records[i]?.status !== 'active').map(ref => ref.memoryId)
      if (gone.length > 0) return behind('not-found', gone, `不存在或已处理：${gone.join('、')}`)
      if (absorbs.length > 0 && !isOneScope(records.map(r => r!))) return fail(cmd, 'invalid-args', '并入的记忆和要改的不在同一个作用域（全局和项目、或不同项目混在一起）')
      // 高危密钥的原文不发给模型（并入的记忆也是）；确认存下的疑似密钥同注入，照原文发
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
      const located = records.map(rec => rec!)
      const r = await generateDraft({
        adviceType, records: located.slice(0, refs.length), absorbed: located.slice(refs.length), request, priorRequests, planNote, previous,
      }, llm)
      if (!r.ok) return fail(cmd, r.code, r.detail)
      return { ok: true, cmd, draft: r.draft, ...(llm.model !== undefined ? { model: llm.model } : {}) }
    }

    case 'plan-edits': {
      const refs = command.memories
      const problem = batchRefsProblem(refs)
      if (problem !== undefined) return fail(cmd, 'invalid-args', problem)
      const records = await locateBatch(refs)
      if (isErr(records)) return records
      // 同 draft-edit：高危密钥的原文不发给模型，确认存下的疑似密钥照原文发；要求进提示词，命中高危就整次不发
      if (records.some(r => hasCriticalSecret(r))) return fail(cmd, 'has-secret', '含密钥的记忆不发给模型。未做任何改动')
      if (detectSecrets(command.request).some(h => h.severity === 'critical')) return fail(cmd, 'secret-critical', '要求里有高危密钥，不发给模型。未做任何改动')
      const llm = deps.host.llmOf(exec)
      if (llm === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型')
      const r = await generatePlan({ records, request: command.request }, llm)
      if (!r.ok) return fail(cmd, r.code, r.detail)
      return { ok: true, cmd, plan: r.plan, ...(llm.model !== undefined ? { model: llm.model } : {}) }
    }

    case 'draft-plan': {
      const refs = command.memories
      const problem = batchRefsProblem(refs) ?? draftOpsProblem(refs.map(ref => ref.memoryId), command.ops)
      if (problem !== undefined) return fail(cmd, 'invalid-args', problem)
      const records = await locateBatch(refs)
      if (isErr(records)) return records
      // 同 plan-edits：选中的全部记忆都进提示词（只作参考的也是）；要求和计划的文字同样进，命中高危就整次不发
      if (records.some(r => hasCriticalSecret(r))) return fail(cmd, 'has-secret', '含密钥的记忆不发给模型。未做任何改动')
      const asked = [command.request, ...command.ops.flatMap(op => [op.reason, op.question?.text ?? '', op.question?.placeholder ?? '', op.answer ?? ''])]
      if (detectSecrets(asked.join('\n')).some(h => h.severity === 'critical')) return fail(cmd, 'secret-critical', '要求或计划里有高危密钥，不发给模型。未做任何改动')
      const llm = deps.host.llmOf(exec)
      if (llm === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型')
      const r = await generatePlanDrafts({ records, request: command.request, ops: command.ops }, llm)
      if (!r.ok) return fail(cmd, r.code, r.detail)
      return { ok: true, cmd, drafts: r.drafts, ...(llm.model !== undefined ? { model: llm.model } : {}) }
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
        target, by: 'manual', llm,
        ...(currentWorkspace !== undefined ? { currentWorkspace } : {}),
        ...(command.isFullRecheck === true ? { isFullRecheck: true } : {}),
      }, {
        scan: { store: deps.store, registry: deps.registry, decisions: deps.decisions, cache: deps.cache, ignores: deps.ignores, instructions: deps.instructions, ...deps.incremental },
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
      // 体检结果和冲突卡先出：建议在后续段里逐条补到卡上，命令不等它（它自己兜住异常）
      void deps.suggestions?.run({
        target, by: 'manual', llm, outcome: r, ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      })
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

    case 'organize-index': {
      if (command.scope.kind === 'workspace' && !isAbsolute(command.scope.workspacePath)) {
        return fail(cmd, 'invalid-args', `项目路径必须是绝对路径：${command.scope.workspacePath}`)
      }
      const llm = deps.host.llmOf(exec)
      if (llm === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型')
      const r = await runOrganize({ scope: command.scope, llm, ...(deps.signal !== undefined ? { signal: deps.signal } : {}) }, {
        store: deps.store, decisions: deps.decisions, checkups: deps.checkups,
        interval: deps.heartbeat ?? processInterval,
        maxTopics: deps.maxTopics?.() ?? INDEX_MAX_TOPICS_DEFAULT,
        onClaimChanged: () => deps.views.requestCheckups(),
        now: () => deps.now?.() ?? Date.now(),
        log: deps.log ?? console,
      })
      switch (r.kind) {
        case 'busy': return fail(cmd, 'busy', `${r.scope.kind === 'global' ? '全局' : r.scope.workspacePath} 正在体检或整理，做完再来`)
        case 'failed': return fail(cmd, 'failed', r.message)
        case 'empty': return { ok: true, cmd, organized: { applied: 0, skipped: 0 } }
      }
      return {
        ok: true, cmd, organized: { applied: r.applied, skipped: r.skipped },
        ...(r.decisionId !== undefined ? { decisionId: r.decisionId } : {}), ...(r.isPartial ? { isPartial: true as const } : {}),
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

    case 'set-model-selection': {
      await deps.selections.set(command.key, command.selection)
      await deps.views.requestCheckups()
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

    case 'suggest': {
      const entry = await deps.decisions.get(command.decisionId)
      if (entry === undefined) return notFound(command.decisionId)
      const shape = conflictShape(entry)
      if (shape === undefined) return fail(cmd, 'invalid-args', `待决项 ${entry.id} 不是冲突，补不了建议`)
      // 同裁决的定位口径；写入时按同一口径重读核对
      const read = (id: string) => locate(id, undefined)
      const records = await Promise.all(entry.memoryIds.map(read))
      const gone = entry.memoryIds.filter((_, i) => records[i]?.status !== 'active')
      if (gone.length > 0) return behind('not-found', gone, `不存在或已处理：${gone.join('、')}`)
      const live = records as MemoryRecord[]
      // 高危密钥的原文不发给模型；确认存下的疑似密钥同注入，照原文发
      if (live.some(r => hasCriticalSecret(r))) return fail(cmd, 'has-secret', '含密钥的记忆不发给模型。未做任何改动')
      // 垂直冲突要这条记忆对应的指令文件（项目记忆是它所在项目的，全局记忆是全局层的）：取不到或不存在时不生成，也不记在条目上
      const baseline = shape === 'vertical' ? await baselineFor(deps.instructions, live[0]!) : null
      const side = shape === 'vertical' ? baselineBasisOf(live[0]!, baseline, entry.fingerprint) : undefined
      if (shape === 'vertical' && side === undefined) return fail(cmd, 'no-baseline', '这条记忆对应的指令文件读不到，或在体检后改过。重新体检后再试。未做任何改动')
      const isCurrent = entry.suggestion !== undefined && isBasisCurrent(entry, entry.suggestion.basis, live)
        && (side === undefined || isBaselineCurrent(entry.suggestion.basis, baseline))
      if (isCurrent) return { ok: true, cmd, decisionId: entry.id }
      const llm = deps.host.llmOf(exec)
      if (llm === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型')
      // 依据版本按生成前读到的算：生成在认领之外（模型调用可能超过认领的 60 秒），写入时认领、重读、核对它
      const basis = suggestionBasis(entry, live, side)
      // 出处按冲突所属的作用域回查；读不到的那条不带，是否回查过由生成器按实际放进提示词的片段定
      const sources = await readSuggestionSources({ workspaces: entry.workspaces, records: live }, deps.getReadEvent?.() ?? null)
      const generated = shape === 'vertical'
        ? await generateVerticalSuggestion({ summary: entry.summary, baselineRef: entry.baselineRef!, record: live[0]!, baseline: baseline!, source: sources[0] }, llm)
        : await generateSuggestion({ summary: entry.summary, records: live as [MemoryRecord, MemoryRecord], sources: [sources[0], sources[1]] }, llm)
      const model = llm.model !== undefined ? { model: llm.model } : {}
      const outcome = generated.ok
        ? { suggestion: { id: genId('sg'), action: generated.action, reason: generated.reason, ops: generated.ops, basis, isSourced: generated.isSourced, generatedAt: now } }
        : { failure: { basis, cause: generated.cause, at: now } }
      const written = await deps.decisions.writeSuggestion(entry.id, outcome, read)
      if (written === 'gone') return notFound(entry.id)
      if (written === 'claimed') return fail(cmd, 'claimed', `待决项 ${entry.id} 正在被另一次操作处理，这次生成的建议没有写入`)
      if (written === 'stale') return behind('stale', entry.memoryIds, `${shape === 'vertical' ? '这条记忆' : '这两条'}刚被改过，界面已换成最新内容；这次生成的建议没有写入`)
      // 别处已写下当前依据的建议：这一份丢弃，卡上显示那一份。模型判断不了哪条对也算答了：原因已记在条目上，视图带出
      if (written === 'has-current' || generated.ok || generated.cause.kind === 'undecided') return { ok: true, cmd, decisionId: entry.id, ...model }
      // 没生成成：原因已记在条目上，视图里是「生成失败」；run 只在成功时重写视图，这里自己重写
      await deps.views.request()
      const { cause } = generated
      if (cause.kind === 'model-error') return fail(cmd, 'llm-failed', cause.message ?? cause.hostCode)
      return fail(cmd, 'llm-invalid-output', cause.kind === 'secret-in-draft' ? '模型给的稿里带进了原文没有的密钥，这份建议已丢弃' : '模型的输出不是要求的 JSON 格式')
    }

    case 'draft-proposal': {
      const entry = await deps.decisions.get(command.decisionId)
      if (entry === undefined) return notFound(command.decisionId)
      const shape = conflictShape(entry)
      if (shape === undefined) return fail(cmd, 'invalid-args', `待决项 ${entry.id} 不是冲突，没法按要求生成处理方案`)
      const bases: readonly { updatedAt: number; digest: string }[] = command.bases
      if (bases.length !== entry.memoryIds.length) return fail(cmd, 'invalid-args', `卡片版本给了 ${bases.length} 条，待决项 ${entry.id} 涉及 ${entry.memoryIds.length} 条记忆`)
      // 同裁决的定位口径；生成完按同一口径重读核对
      const read = (id: string) => locate(id, undefined)
      const records = await Promise.all(entry.memoryIds.map(read))
      const gone = entry.memoryIds.filter((_, i) => records[i]?.status !== 'active')
      if (gone.length > 0) return behind('not-found', gone, `不存在或已处理：${gone.join('、')}`)
      const live = records as MemoryRecord[]
      // 用户写要求时看的是卡片上那一版：对不上就让界面先换成最新内容，再按新内容写要求
      const staleIds = entry.memoryIds.filter((_, i) => isStale(live[i]!, bases[i]!))
      if (staleIds.length > 0) return behind('stale', staleIds, '有记忆刚被改过，界面已换成最新内容。没有生成方案')
      // 高危密钥的原文不发给模型：记忆、要求、此前的要求、上一份方案（含它的稿）都查
      if (live.some(r => hasCriticalSecret(r))) return fail(cmd, 'has-secret', '含密钥的记忆不发给模型。未做任何改动')
      const previousText = command.previous === undefined ? [] : [
        command.previous.reason, ...command.previous.ops.flatMap(op => (op.kind === 'edit' ? [op.content, op.name, op.summary, ...op.tags] : [])),
      ]
      if (detectSecrets([command.request, ...(command.priorRequests ?? []), ...previousText].join('\n')).some(h => h.severity === 'critical')) {
        return fail(cmd, 'secret-critical', '要求或上一份方案里有高危密钥，没有发给模型')
      }
      // 垂直冲突同补上建议：要这条记忆对应的指令文件
      const baseline = shape === 'vertical' ? await baselineFor(deps.instructions, live[0]!) : null
      const side = shape === 'vertical' ? baselineBasisOf(live[0]!, baseline, entry.fingerprint) : undefined
      if (shape === 'vertical' && side === undefined) return fail(cmd, 'no-baseline', '这条记忆对应的指令文件读不到，或在体检后改过。重新体检后再试。没有生成方案')
      const llm = deps.host.llmOf(exec)
      if (llm === null) return fail(cmd, 'llm-unavailable', '借用的会话拿不到模型')
      // 只读、不认领：模型调用可能超过认领的 60 秒；依据版本按生成前读到的算，应用时认领、重读、核对它
      const basis = suggestionBasis(entry, live, side)
      const sources = await readSuggestionSources({ workspaces: entry.workspaces, records: live }, deps.getReadEvent?.() ?? null)
      const request = { text: command.request, prior: command.priorRequests ?? [], ...(command.previous !== undefined ? { previous: command.previous } : {}) }
      const generated = shape === 'vertical'
        ? await generateVerticalProposal({ summary: entry.summary, baselineRef: entry.baselineRef!, record: live[0]!, baseline: baseline!, source: sources[0], request }, llm)
        : await generateProposal({ summary: entry.summary, records: live as [MemoryRecord, MemoryRecord], sources: [sources[0], sources[1]], request }, llm)
      if (!generated.ok) {
        const { cause } = generated
        if (cause.kind === 'model-error') return fail(cmd, 'llm-failed', cause.message ?? cause.hostCode)
        return fail(cmd, 'llm-invalid-output', '模型的输出不是要求的 JSON 格式')
      }
      // 生成期间两条被改过（只改了摘要、标签也算）：这一份按旧内容出的，丢弃
      const after = await Promise.all(entry.memoryIds.map(read))
      if (!isBasisCurrent(entry, basis, after.map(r => (r?.status === 'active' ? r : undefined)))) {
        return behind('stale', entry.memoryIds, `${shape === 'vertical' ? '这条记忆' : '这两条'}在生成期间被改过，界面已换成最新内容；这份方案已丢弃`)
      }
      const model = llm.model !== undefined ? { model: llm.model } : {}
      if (generated.action === 'infeasible') return { ok: true, cmd, ...model, infeasible: { reason: generated.reason } }
      return { ok: true, cmd, ...model, proposal: { action: generated.action, reason: generated.reason, ops: generated.ops, basis } }
    }

    case 'refresh-views':
      await deps.decisions.sweep(now)
      await deps.views.rewriteAll()
      return { ok: true, cmd }

    case 'delete-dialogue-records':
      try {
        deps.deleteDialogueRecords?.()
      } catch (err) {
        return fail(cmd, 'failed', `对话记录没能删掉：${err instanceof Error ? err.message : String(err)}`)
      }
      return { ok: true, cmd }
  }
}
