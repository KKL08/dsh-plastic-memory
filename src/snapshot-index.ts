import type { OverflowMode } from './contract-codes.ts'
import { CJK } from './search/tokenizer.ts'

/**
 * 注入索引区（主题目录和成员行）的两轮预算，纯函数：只吃排好的行，不碰记录和存储。
 *
 * 第一轮每个主题一行；第二轮按主题的先后发成员行，每个主题最多 memberLimit 行，放不下写「另有 N 条」（一行成员都放不下时，
 * 这一行放得下也写）。
 * 超出上限时按固定顺序降级：靠后主题的成员行 → 靠前主题里靠后的成员行 → 主题说明（从后往前）→ 主题行本身（从后往前，
 * 写「另有 N 个主题」）。开头的说明行、每个作用域的标题、「另有 N 个主题」和固定在最后的那个主题（「未整理」）必留，条数一定写出，
 * 必留的几行本身放不下时照样发，用量会超出上限。
 */

/** 按中文计价的字符：CJK 文字（与检索同一口径）加全角标点（CJK 符号与标点 U+3000–303F、全角形式 U+FF00–FFEF）。 */
const CJK_PRICED = new RegExp(String.raw`[${CJK}\u3000-\u303f\uff00-\uffef]`, 'u')

/**
 * token 估算，快照组装、超限档位、会话视图用量都只走这一个函数。按码点计价：中文字符每个 0.6，
 * 其余字符（字母、数字、空白、半角标点等）每个 0.3，合计向上取整。系数按 DeepSeek 实际分词校准，
 * 默认上限 4,000 约合 6,700 个中文字。按十分之一 token 的整数累加，避免 0.6 × 5 这类浮点误差多进一。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(tokenTenths(text) / 10)
}

/** estimateTokens 取整前的值，单位是十分之一 token。按码点边界分段时可以累加：各段之和除以十向上取整，等于整段的估算。 */
export function tokenTenths(text: string): number {
  let tenths = 0
  for (const ch of text) tenths += CJK_PRICED.test(ch) ? 6 : 3
  return tenths
}

/** 索引区的绝对上限（token）：放宽模式下也生效，和记忆条数无关。 */
export const INDEX_AREA_TOKEN_CAP = 2000
/** 每个主题最多发几条成员行（暂定，拿真实索引试过再调）。 */
export const TOPIC_MEMBER_LIMIT = 5

/** 索引区能用的 token：放宽模式用绝对上限；严格模式用必读全文用剩的预算和绝对上限里小的那个。 */
export function indexAreaLimit(mode: OverflowMode, budget: number, usedBeforeIndex: number): number {
  if (mode !== 'strict') return INDEX_AREA_TOKEN_CAP
  return Math.max(0, Math.min(budget - usedBeforeIndex, INDEX_AREA_TOKEN_CAP))
}

export interface PlanTopic {
  /** 带说明的主题行。 */
  line: string
  /** 去掉说明的主题行；没有说明时和 line 相同。 */
  bareLine: string
  /** 候选的成员行，按发的先后。 */
  members: readonly string[]
  /** 不出成员行、但「另有 N 条」要算上的条数（单条设成不列入的）。 */
  hidden: number
  /** 固定在作用域最后、不降级的主题（「未整理」、索引读不出时的那一组）。 */
  isPinned?: boolean
}
export interface PlanScope { heading: string; topics: readonly PlanTopic[] }
export interface PlanOptions {
  memberLimit: number
  moreMembers: (n: number) => string
  moreTopics: (n: number) => string
  /** 索引区开头的说明行（必留）；缺省不出。 */
  preface?: string
}
export interface IndexAreaPlan {
  lines: string[]
  /** 发出去的行（每行连同它前面的换行）合计的用量，单位是十分之一 token。 */
  tenths: number
  /** hasMore：这个主题写了「另有 N 条」。 */
  scopes: Array<{ droppedTopics: number; topics: Array<{ isShown: boolean; hasAbout: boolean; shownMembers: number; hasMore: boolean }> }>
}

/** 一行连同它前面的换行的用量（十分之一 token）：索引区拼进快照时每行前面都有一个换行。 */
const costOf = (line: string) => tokenTenths(`\n${line}`)

export function planIndexArea(scopes: readonly PlanScope[], limitTokens: number, opts: PlanOptions): IndexAreaPlan {
  const limit = Math.max(0, limitTokens) * 10
  const state = scopes.map(s => ({
    droppedTopics: 0,
    topics: s.topics.map(t => ({ isShown: true, hasAbout: t.line !== t.bareLine, shownMembers: 0, hasMore: false })),
  }))
  // 每行的用量只算一次，降级时按差值改总量，不再每去一行就整份重算：主题多了也只随行数线性增长
  const costs = scopes.map(s => s.topics.map(t => ({ line: costOf(t.line), bare: costOf(t.bareLine) })))
  const topicCost = (si: number, ti: number) => {
    const st = state[si]!.topics[ti]!
    return st.isShown ? (st.hasAbout ? costs[si]![ti]!.line : costs[si]![ti]!.bare) : 0
  }
  // 各作用域「另有 N 个主题」这一行眼下的用量（没去掉主题时为 0）
  const moreTopicsCost = scopes.map(() => 0)
  // 主题的先后：两个作用域接起来，靠后的先降级；固定的主题不参加
  const order = scopes.flatMap((s, si) => s.topics.map((t, ti) => ({ si, ti, t })))
  const movable = order.filter(o => o.t.isPinned !== true)
  let used = (opts.preface === undefined ? 0 : costOf(opts.preface))
    + scopes.reduce((sum, s, si) => sum + costOf(s.heading) + s.topics.reduce((n, _t, ti) => n + topicCost(si, ti), 0), 0)
  const isDegraded = used > limit
  // 第三步：从后往前去掉主题说明
  for (const o of [...movable].reverse()) {
    if (used <= limit) break
    const st = state[o.si]!.topics[o.ti]!
    if (!st.hasAbout) continue
    const before = topicCost(o.si, o.ti)
    st.hasAbout = false
    used += topicCost(o.si, o.ti) - before
  }
  // 第四步：从后往前去掉主题行
  for (const o of [...movable].reverse()) {
    if (used <= limit) break
    const sc = state[o.si]!
    used -= topicCost(o.si, o.ti) + moreTopicsCost[o.si]!
    sc.topics[o.ti]!.isShown = false
    sc.droppedTopics++
    moreTopicsCost[o.si] = costOf(opts.moreTopics(sc.droppedTopics))
    used += moreTopicsCost[o.si]!
  }

  // 第二轮：主题行都放下了（带说明）才发成员行；按先后发，有一个主题没发满就停，后面的都不发。
  // 有候选成员行、又有没列出的，就写「另有 N 条」，一行成员都放不下时也写；只有不出成员行的那些时不写，条数已在主题行上
  const moreCost = (t: PlanTopic, shown: number) => {
    const rest = t.members.length - shown + t.hidden
    return t.members.length > 0 && rest > 0 ? costOf(opts.moreMembers(rest)) : 0
  }
  if (!isDegraded) {
    for (const o of order) {
      const quota = Math.min(opts.memberLimit, o.t.members.length)
      let taken = quota
      // 前 taken 条成员行的用量：每行只算一次
      const prefix = [0]
      for (const line of o.t.members.slice(0, quota)) prefix.push(prefix.at(-1)! + costOf(line))
      // 从发满往下试，到一行成员都不发、只写「另有 N 条」为止；这一行也放不下时 taken 落到 -1，什么都不发
      for (; taken >= 0; taken--) {
        const n = prefix[taken]! + moreCost(o.t, taken)
        if (used + n <= limit) { used += n; break }
      }
      const st = state[o.si]!.topics[o.ti]!
      st.shownMembers = Math.max(taken, 0)
      st.hasMore = taken >= 0 && moreCost(o.t, taken) > 0
      if (taken < quota) break
    }
  }

  const lines: string[] = opts.preface === undefined ? [] : [opts.preface]
  for (const [si, s] of scopes.entries()) {
    lines.push(s.heading)
    const emit = (t: PlanTopic, ti: number) => {
      const st = state[si]!.topics[ti]!
      if (!st.isShown) return
      lines.push(st.hasAbout ? t.line : t.bareLine, ...t.members.slice(0, st.shownMembers))
      if (st.hasMore) lines.push(opts.moreMembers(t.members.length - st.shownMembers + t.hidden))
    }
    for (const [ti, t] of s.topics.entries()) if (t.isPinned !== true) emit(t, ti)
    if (state[si]!.droppedTopics > 0) lines.push(opts.moreTopics(state[si]!.droppedTopics))
    for (const [ti, t] of s.topics.entries()) if (t.isPinned === true) emit(t, ti)
  }
  // 总量一路按发出去的行累加：等于每行连同换行的用量之和
  return { lines, tenths: used, scopes: state }
}
