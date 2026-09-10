/**
 * AGENTS.md/CLAUDE.md 权威基线：从 session 日志按事件顺序折叠，拉模型按需推导。
 * 拉模型的理由不变：插件热重载（HMR）后旧注册清理、缓存清空，若靠事件推送灌入，存量 session 的基线
 * 永久丢失、垂直冲突检测静默失效；get 时直接从日志推，缓存按 session 隔离（WeakMap）——指令内容随
 * workspace 不同而不同，插件级单槽会让并存会话互相串台。
 *
 * 宿主 0.1.5 起 Session 不再暴露整份事件数组，读取代价显式化：`seq` 是下一条事件的位置（O(1)），
 * `snapshotEvents(from, to)` 按半开区间物化。缓存键因此改为 seq：不变直接返回；前进只物化新增区间
 * 折叠进状态。冷读一次与分批读折的是同一串事件，结果逐字一致。
 */

// 只为拿到 dsh-agent-instructions 对 MessageSourceMap 的类型增广（source.kind === 'agent-instructions'
// 收窄到 AgentInstructionSource：baseline / changes 编译期可见）；类型引用不产生运行时导入。
/// <reference types="@deepseek-ai/dsh-agent-instructions" />
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

type AgentInstructionSource = MessageSourceMap['agent-instructions']

/** 一条指令消息在折叠状态里的残留：正文 + 尚未被后来消息取代的 scope。 */
interface Entry {
  readonly text: string
  readonly scopes: ReadonlySet<string>
}

/** 折叠状态：仍然有效的指令消息（按事件顺序），以及最近一条完整基线覆盖的 scope。 */
export interface BaselineState {
  readonly entries: readonly Entry[]
  readonly baselineScopes: ReadonlySet<string>
}

export const EMPTY_BASELINE: BaselineState = { entries: [], baselineScopes: new Set() }

/** 宿主 Session 的日志读取面（结构约束，由 index.ts 传入真 Session 时经编译期校验）。 */
export interface EventLog {
  readonly seq: number
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[]
}

/** 从一条事件里取出指令消息；非指令消息返回 undefined。 */
function instructionMessage(event: SessionEvent): { seq: number; source: AgentInstructionSource; text: string } | undefined {
  if (event.type !== 'user/message') return undefined
  const { source, content } = event.data
  if (source.kind !== 'agent-instructions') return undefined
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return { seq: event.seq, source, text }
}

/**
 * 按事件顺序折叠。宿主按 scope（目录 + 文件名）维护指令状态：每条消息的 `changes` 说明它 set/replace/remove
 * 了哪些 scope，完整基线（`baseline: true`）只覆盖 global 加祖先目录链，子目录规则内容不变时不再重发，换基线
 * 时旧 scope 以显式 remove 出现；compaction 后重发的基线则不带 remove。所以插件按 scope 取代：新消息触碰过的
 * scope 使早先消息失去该 scope，一条消息的 scope 全被取代才退出；新的完整基线额外取代上一条完整基线覆盖的
 * 全部 scope（完整基线就是对这些 scope 的整体重述）。多 scope 消息被部分取代时整条保留（宁可多留，不可漏掉
 * 仍有效的规则）。remove 的提示语照样进入文本，语义扫描由 LLM 读，提示语足以表达。
 *
 * 形状漂移不静默：正文没有 text 块，或没有 `changes` 数组，都经 warn 留痕；前者仍按 changes 取代、不追加
 * 文本，后者当作没触碰任何 scope 的消息追加且永不退出。
 */
export function foldBaseline(state: BaselineState, events: readonly SessionEvent[], warn: (message: string) => void): BaselineState {
  let { entries, baselineScopes } = state
  for (const event of events) {
    const instr = instructionMessage(event)
    if (instr === undefined) continue
    const changes: unknown = instr.source.changes
    if (!Array.isArray(changes)) {
      warn(`agent-instructions message at seq ${instr.seq} carries no changes array; keeping its text without scope tracking`)
      entries = [...entries, { text: instr.text, scopes: new Set() }]
      continue
    }
    const own = new Set(changes.map(change => change.scope))
    const isBaseline = instr.source.baseline === true
    const touched = isBaseline ? new Set([...own, ...baselineScopes]) : own
    if (isBaseline) baselineScopes = own
    entries = entries.flatMap(entry => {
      if (entry.scopes.size === 0) return [entry]
      const live = new Set([...entry.scopes].filter(scope => !touched.has(scope)))
      if (live.size === 0) return []
      return live.size === entry.scopes.size ? [entry] : [{ text: entry.text, scopes: live }]
    })
    if (instr.text.length === 0) {
      warn(`agent-instructions message at seq ${instr.seq} carries no text blocks; baseline may be incomplete`)
      continue
    }
    entries = [...entries, { text: instr.text, scopes: own }]
  }
  return entries === state.entries && baselineScopes === state.baselineScopes ? state : { entries, baselineScopes }
}

/** 当前有效指令消息的正文，按事件顺序（越靠后越新）；从未见过任何指令时为空。 */
export function baselineTexts(state: BaselineState): readonly string[] {
  return state.entries.map(entry => entry.text)
}

/** 按 session 隔离、按 seq 增量物化的基线缓存。 */
export class BaselineCache {
  private bySession = new WeakMap<object, { seq: number; state: BaselineState }>()

  constructor(private readonly warn: (message: string) => void) {}

  /** 该 session 当前有效的指令消息正文（按事件顺序）；null = 没有生效的指令（垂直冲突检测跳过）。 */
  get(session: EventLog | undefined): readonly string[] | null {
    if (!session) return null
    let cached = this.bySession.get(session) ?? { seq: 0, state: EMPTY_BASELINE }
    if (session.seq > cached.seq) {
      cached = { seq: session.seq, state: foldBaseline(cached.state, session.snapshotEvents(cached.seq, session.seq), this.warn) }
      this.bySession.set(session, cached)
    }
    const texts = baselineTexts(cached.state)
    return texts.length === 0 ? null : texts
  }
}
