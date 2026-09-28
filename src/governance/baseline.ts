/**
 * AGENTS.md/CLAUDE.md 权威基线，注册成宿主 session projection（键 `plasticMemoryBaseline`）。
 *
 * 为什么是投影：宿主 0.1.7 起弃用同步读取 session 历史的那组方法，方向是不再把完整事件序列留在内存里；
 * 要从会话历史派生状态，宿主认可的做法就是注册 projection。插件只提供纯折叠，读侧经 `stateOf` 取状态
 * （见 index.ts），自己不再读 session 日志。
 *
 * 宿主替插件做三件事：每条提交的事件过一次 `apply`；插件晚注册（热重载）或会话早于注册时，首次用到就对
 * 内存日志补折；状态按 `(sessionId, key, ver, seq, val)` 落 checkpoint，会话恢复后可以从 checkpoint
 * 接着折，不必重放完整历史。cell 按 session 隔离，并存会话互不串台。
 *
 * 状态是纯 JSON（宿主写 checkpoint 前有无损 JSON 守卫，Set 会直接抛错）。`stateVersion` 从 1 起：
 * 改状态字段或折叠语义的提交必须递增，旧 checkpoint 才会被丢弃重折，而不是被错误地续折。
 *
 * 指令消息的形状漂移记进状态的 `drift`，只留最近 32 条，上游长期漂移时状态和 checkpoint 不会无界增长。
 * `apply` 必须纯，告警由读侧 `readBaseline` 还原：同一 session 对象、同一插件生命周期内每条漂移只告警
 * 一次，插件重载或宿主重启后对历史漂移会再告警一次。告警不放进 `apply`，是因为宿主补折和 checkpoint
 * 恢复都会重放它，放进去会重复刷屏。
 */

// 只为拿到 dsh-agent-instructions 对 MessageSourceMap 的类型增广（source.kind === 'agent-instructions'
// 收窄到 AgentInstructionSource：baseline / changes 编译期可见）；类型引用不产生运行时导入。
/// <reference types="@deepseek-ai/dsh-agent-instructions" />
import { z } from 'zod'
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

type AgentInstructionSource = MessageSourceMap['agent-instructions']

/** 一条指令消息在折叠状态里的残留：正文 + 尚未被后来消息取代的 scope（有序去重）。 */
export interface BaselineEntry {
  readonly text: string
  readonly scopes: readonly string[]
}

/** 一次形状漂移：`no-changes` = 缺 `changes` 数组，`no-text` = 正文拼接后为空。 */
export interface BaselineDrift {
  readonly seq: number
  readonly kind: 'no-changes' | 'no-text'
}

/** 折叠状态：仍然有效的指令消息（按事件顺序）、最近一条完整基线覆盖的 scope、最近的形状漂移（至多 32 条）。 */
export interface BaselineState {
  readonly entries: readonly BaselineEntry[]
  readonly baselineScopes: readonly string[]
  readonly drift: readonly BaselineDrift[]
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    /** dsh-plastic-memory：当前生效的 AGENTS.md/CLAUDE.md 指令正文（host-only，无 wire）。 */
    plasticMemoryBaseline: BaselineState
  }
}

const baselineStateSchema: z.ZodType<BaselineState> = z.object({
  entries: z.array(z.object({ text: z.string(), scopes: z.array(z.string()) })),
  baselineScopes: z.array(z.string()),
  drift: z.array(z.object({ seq: z.number(), kind: z.enum(['no-changes', 'no-text']) })),
})

/** drift 只留最近这么多条：上游长期漂移时状态与 checkpoint 不会无界增长。 */
const DRIFT_LIMIT = 32

/** 追加一条漂移，超出上限丢最旧。 */
const withDrift = (drift: readonly BaselineDrift[], seq: number, kind: BaselineDrift['kind']): BaselineDrift[] =>
  [...drift, { seq, kind }].slice(-DRIFT_LIMIT)

/** 有序去重：scope 集合落成排序数组，状态相等即 JSON 相等。 */
const scopeList = (scopes: Iterable<string>): string[] => [...new Set(scopes)].sort()

/** 从一条事件里取出指令消息；非指令消息返回 undefined。 */
function instructionMessage(event: SessionEvent): { source: AgentInstructionSource; text: string } | undefined {
  if (event.type !== 'user/message') return undefined
  const { source, content } = event.data
  if (source.kind !== 'agent-instructions') return undefined
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return { source, text }
}

/**
 * 按事件顺序折叠。宿主按 scope（目录 + 文件名）维护指令状态：每条消息的 `changes` 说明它 set/replace/remove
 * 了哪些 scope，完整基线（`baseline: true`）只覆盖 global 加祖先目录链，子目录规则内容不变时不再重发，换基线
 * 时旧 scope 以显式 remove 出现；compaction 后重发的基线则不带 remove。所以插件按 scope 取代：新消息触碰过的
 * scope 使早先消息失去该 scope，一条消息的 scope 全被取代才退出；新的完整基线额外取代上一条完整基线覆盖的
 * 全部 scope（完整基线就是对这些 scope 的整体重述）。多 scope 消息被部分取代时整条保留（宁可多留，不可漏掉
 * 仍有效的规则）。remove 的提示语照样进入文本，语义扫描由 LLM 读，提示语足以表达。
 *
 * 形状漂移记进 `drift`（apply 必须纯，告警由读侧 readBaseline 还原）：没有 `changes` 数组时当作没触碰任何
 * scope 的消息追加（哪怕正文为空）且永不退出，记 `no-changes`；正文拼接后为空时仍按 changes 取代、不追加
 * 文本，记 `no-text`。不相关事件原样返回同一状态引用（宿主据 Object.is 判定零下游工作）。
 */
function applyBaseline(state: BaselineState, event: SessionEvent): BaselineState {
  const instr = instructionMessage(event)
  if (instr === undefined) return state
  const changes: unknown = instr.source.changes
  if (!Array.isArray(changes)) {
    return {
      ...state,
      entries: [...state.entries, { text: instr.text, scopes: [] }],
      drift: withDrift(state.drift, event.seq, 'no-changes'),
    }
  }
  const own = new Set(changes.map(change => change.scope))
  const isBaseline = instr.source.baseline === true
  const touched = isBaseline ? new Set([...own, ...state.baselineScopes]) : own
  const baselineScopes = isBaseline ? scopeList(own) : state.baselineScopes
  const entries = state.entries.flatMap(entry => {
    if (entry.scopes.length === 0) return [entry]
    const live = entry.scopes.filter(scope => !touched.has(scope))
    if (live.length === 0) return []
    return live.length === entry.scopes.length ? [entry] : [{ text: entry.text, scopes: live }]
  })
  if (instr.text.length === 0) return { ...state, entries, baselineScopes, drift: withDrift(state.drift, event.seq, 'no-text') }
  return { ...state, entries: [...entries, { text: instr.text, scopes: scopeList(own) }], baselineScopes }
}

/** 宿主 session projection 定义：host-only 单元，状态见 BaselineState。 */
export const baselineProjectionDefinition = {
  key: 'plasticMemoryBaseline',
  stateVersion: 1,
  stateSchema: baselineStateSchema,
  init: (): BaselineState => ({ entries: [], baselineScopes: [], drift: [] }),
  apply: applyBaseline,
} satisfies Omit<ProjectionDefinition<'plasticMemoryBaseline'>, 'wire'>

/** 当前有效指令消息的正文，按事件顺序（越靠后越新）；从未见过任何指令时为空。 */
export function baselineTexts(state: BaselineState): readonly string[] {
  return state.entries.map(entry => entry.text)
}

const driftMessage = ({ seq, kind }: BaselineDrift): string => kind === 'no-changes'
  ? `agent-instructions message at seq ${seq} carries no changes array; keeping its text without scope tracking`
  : `agent-instructions message at seq ${seq} carries no text blocks; baseline may be incomplete`

/**
 * 读侧：状态 → 正文与本次新告警。`warned` 是该 session 已告警过的 seq，只对不在其中的漂移产出告警并记入。
 * 去重范围由调用方决定（index.ts 按 session 对象存在 WeakMap 里，随插件生命周期）。
 * drift 是滑动窗口，退出窗口的 seq 不会再出现，顺手从 `warned` 里清掉，集合大小随 DRIFT_LIMIT 封顶。
 */
export function readBaseline(state: BaselineState, warned: Set<number>): { texts: readonly string[]; warnings: readonly string[] } {
  const warnings: string[] = []
  const retained = new Set(state.drift.map(drift => drift.seq))
  for (const seq of warned) if (!retained.has(seq)) warned.delete(seq)
  for (const drift of state.drift) {
    if (warned.has(drift.seq)) continue
    warned.add(drift.seq)
    warnings.push(driftMessage(drift))
  }
  return { texts: baselineTexts(state), warnings }
}
