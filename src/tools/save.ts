import { isInEffect } from '../record-freshness.ts'
import { formatValidity } from '../validity.ts'
import { similarGuide } from '../create-gate.ts'
import type { SaveHints } from '../save-signals.ts'
import type { QueryTokenizerOptions } from '../search/jieba-segmenter.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryStore } from '../store.ts'
import type { TypeRegistry } from '../type-registry.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import { isPendingDelegated, type MemoryRecord } from '../record-schema.ts'
import { maskSecretSurface } from '../secrets.ts'
import { runSavePipeline, type PipelineResult, type SaveDelegation, type SaveInput } from '../pipeline.ts'
import { MEMORY_TOOL_NAMES } from '../contract-codes.ts'
import { anchorFactsOf, excludesPluginEvidence } from '../session-log.ts'
import type { HostSession } from './host-session.ts'

/** memory_save 运行时需要的会话上下文，由宿主会话适配器的 saveContextOf 提供。 */
export interface SaveContext {
  workspacePath: string | undefined
  /** turnStartSeq 是证据锚的起点（当轮 turn/start 的 seq）；宿主读不到时缺省，管线回退整会话锚。 */
  session: { id: string; lastSeq: number; turnStartSeq?: number }
  /** 子 agent 会话（delegationDepth ≥ 1）才有，由宿主 header 与投影填；主会话缺省。 */
  delegation?: SaveDelegation
}

/** memory_save 的入参：整条写入的必填项、tags 缺省值都由管线按 action 处理（精确修改时没传的沿用目标记忆的）。 */
export type SaveArgs = SaveInput

/** memory_save 工具的依赖，纯逻辑层与框架绑定层共用。 */
export interface SaveToolDeps {
  /** 新建闸与检索共用分词配置。 */
  tokenizer?: QueryTokenizerOptions
  /** 接线层按会话提供提示记账。 */
  saveHintsIn?: (sessionId: string) => SaveHints
  store: MemoryStore
  registry: TypeRegistry
  host: { saveContextOf(exec: ToolRunContext): Promise<SaveContext>; readSessionLog: HostSession['readSessionLog'] }
  /** 记忆文件根目录：参数里提到它的工具调用（读记忆文件）不算工具证据。缺省时只排除本插件的工具。 */
  memoryRoot?: string
  /** 家目录：认出记忆根目录的 ~ 写法。 */
  homeDir?: string
  /** 改写、替代前拍快照用（快照先行）；必填，测试传内存实现。 */
  snapshots: SnapshotStore
  /** 改写、替代后记撤销记录（对话卡、右侧栏的「撤销修改」）；生产接线传入已有实例，测试可缺省。 */
  decisions?: PendingDecisionsStore
  /** 新建成功后调用（会话视图的 savedIds：右侧栏「这次新写入的」，接线在 index.ts）。 */
  onSaved?: (sessionId: string, memoryId: string) => void
  /** 子会话新建配额（配置 subagent.maxSavesPerSession），每次调用现读；缺省按管线的默认值。 */
  maxSubagentSaves?: () => number
  /** 某个会话里已经回过缺改动性质引导的记忆（进程内存，见管线的 guided）；接线层按会话给，测试可缺省。 */
  guidedIn?: (sessionId: string) => { has(memoryId: string): boolean; add(memoryId: string): void }
  /** 状态变化的合并窗口，分钟（配置 history.mergeWindowMinutes），每次调用现读；缺省按落盘原语的默认值。 */
  mergeWindowMinutes?: () => number
}

/** 成功保存、改写时附在第一行末：记录是过程动作，界面已展示写入的记忆，回复里不必再报。 */
const QUIET_NOTE = '回复里不用提这次保存。'

/**
 * 把管线结果渲染成给模型看的一段文本，按当前时刻说明是否已生效。开头的「已保存记忆 <id>（<类型>，<作用域>）」「已更新记忆 <id>（<名称>）」
 * 是对话卡解析的格式（client/chat/tool-summary.ts），改了要同步那边；更新带名称，是因为只传 edits 的参数里没有名称。
 */
/** 摘要嵌进句子里：去掉摘要自带的句末句号，免得拼出「。。」 */
const summaryClause = (summary: string): string => summary.replace(/[。.]$/u, '')

/** 已更新里的名称：按整条记录判密钥（跨字段的疑似密钥也算），遮掉后折成一行，对话卡按首行解析。 */
const shownName = (record: MemoryRecord): string => maskSecretSurface(record, { severity: 'suspected' }).name.replace(/\s+/g, ' ').trim()

export function renderSaveResult(result: PipelineResult): string {
  let text: string
  const futureValidityNote = (result.kind === 'saved' || result.kind === 'updated') && !isInEffect(result.record, Date.now())
    ? `从 ${formatValidity(result.record.validFrom!)} 起才带入对话并可检索。`
    : ''
  switch (result.kind) {
    case 'saved':
      // 子 agent 存下的是待确认记录：没有通知通道，委派方只能从子 agent 的回复里知道，所以要它报出来
      if (isPendingDelegated(result.record)) {
        text = `已保存记忆 ${result.record.id}（${result.record.type}，${result.record.scope}），已存为待确认：${summaryClause(result.record.summary)}。不进主会话注入；在回复里报给委派方（id 和摘要），由它决定接受、改写或丢弃。`
        break
      }
      text = `已保存记忆 ${result.record.id}（${result.record.type}，${result.record.scope}）。${futureValidityNote || '下个会话注入；本会话若触发上下文压缩，压缩后即生效。'}${QUIET_NOTE}`
      break
    case 'updated':
      // 子 agent 改写自己的待确认记录：仍待确认，同新建一样要它报给委派方
      text = isPendingDelegated(result.record)
        ? `已更新记忆 ${result.record.id}（${shownName(result.record)}）。仍待确认：${summaryClause(result.record.summary)}。不进主会话注入；在回复里报给委派方（id 和摘要），由它决定接受、改写或丢弃。`
        : `已更新记忆 ${result.record.id}（${shownName(result.record)}）。${futureValidityNote}${QUIET_NOTE}`
      break
    case 'duplicate-suspected': {
      const e = result.existing
      const listed = `和已有记忆「${e.name}」（${e.id}）几乎一样，未保存。那条的摘要：${e.summary}`
      text = result.isFromSubagent
        ? `${listed}\n子 agent 改不了这条；有新内容或看法不同，在回复里向委派方说明（带上 ${e.id}），由它决定。`
        : `${listed}\n按情况选一条路：\n- 同一件事又被提到：对 ${e.id} 用 action=update、change=corroborate，只传 id 和 sourceMode。\n- 多了细节或值变了：对 ${e.id} 用 action=update，按改动性质填 change（值变了填 state-change）。\n- 确实是另一件事：在这次 create 上加 force: true 重发。`
      break
    }
    case 'rejected':
      text = `未保存：${result.reason}`
      break
  }

  // 渲染警告行
  if ((result.kind === 'saved' || result.kind === 'updated') && result.warnings) {
    const warnings = result.warnings.map(w => `⚠️ ${w.text}`).join('\n')
    text = `${text}\n${warnings}`
  }

  if (result.kind === 'saved' && result.similar?.length) {
    text += `\n相近的已有记忆：\n${result.similar.map(e => `- ${e.id}「${e.name}」${e.scope === 'global' ? '（全局）' : ''}：${e.summary}`).join('\n')}\n${similarGuide(isPendingDelegated(result.record))}`
  }
  return text
}

/** 配置里的分钟数换成毫秒；0 是不合并，负数和不是数的按缺省（不给）。 */
function mergeWindowMs(minutes: number | undefined): number | undefined {
  return minutes !== undefined && Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : undefined
}

/**
 * memory_save 工具的真正执行逻辑：解析上下文、归一化候选、跑写入管线。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeSave(
  args: SaveArgs,
  exec: ToolRunContext,
  deps: SaveToolDeps,
): Promise<PipelineResult> {
  const context = await deps.host.saveContextOf(exec)
  // 当轮是谁开的、有哪类证据：读整份会话日志机械判断，读不到按非用户发起。
  // 轮起点照宿主读到的给，读不到就是不知道，不拿整会话锚的 0 冒充当轮起点
  const { turnStartSeq, lastSeq } = context.session
  const isExcluded = excludesPluginEvidence({ toolNames: MEMORY_TOOL_NAMES, memoryRoot: deps.memoryRoot ?? '', homeDir: deps.homeDir })
  const turn = anchorFactsOf(await deps.host.readSessionLog(context.session.id), { turnStartSeq, lastSeq }, isExcluded)
  const result = await runSavePipeline(args, {
    store: deps.store,
    tokenizer: deps.tokenizer,
    hints: deps.saveHintsIn?.(context.session.id),
    registry: deps.registry,
    // 无条件传真实 workspace 上下文：pipeline 要靠它判断 global 是否降级为候选（scope=global 时
    // 也需要知道当前有没有 workspace 作用域）。global 记忆最终不带 workspacePath 由 pipeline 组装时归 undefined。
    workspacePath: context.workspacePath,
    session: context.session,
    snapshots: deps.snapshots,
    decisions: deps.decisions,
    callId: String(exec.callId ?? ''),
    // 委派信息只从上下文来：args 里同名字段不进候选、也不传到这里
    delegation: context.delegation,
    maxSubagentSaves: deps.maxSubagentSaves?.(),
    guided: deps.guidedIn?.(context.session.id),
    mergeWindowMs: mergeWindowMs(deps.mergeWindowMinutes?.()),
    turn,
  })
  if (result.kind === 'saved') deps.onSaved?.(context.session.id, result.record.id)
  return result
}
