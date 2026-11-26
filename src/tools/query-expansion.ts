import type { DialogueTurnCandidate } from '../search/dialogue-rank.ts'
import { findMemoryCandidates, type MemoryCandidate, type MemoryCandidateDeps } from '../search/memory-candidates.ts'
import type { ModelSelectionStore } from '../governance/background-llm.ts'
import type { ModelSelectionKey } from '../gui/contract.ts'
import type { HostSession } from './host-session.ts'

/**
 * 原话检索的扩查：第一轮命中弱时，调一次聊天模型，看着这次的查询、用户这一轮说的话、第一轮给主模型的原话、
 * 相关记忆的名称和标签，给最多几组新关键词；每组各搜一路，和第一轮按名次融合，第一轮的头部位置不动。
 * 失败、超时都退回第一轮结果并说明一句。原话不另做遮盖：发出去的就是主模型在结果里看到的那几段。
 */

/** 扩查用的模型的选择键：存在后台模型的同一张选择表里，没选就用主对话的模型。 */
export const EXPANSION_SELECTION_KEY = 'expansion' as const satisfies ModelSelectionKey

/**
 * 一次扩查的时间上限（毫秒）：从判定要扩查、开始读选择表算起，读选择表、列模型、读当前这一轮的用户消息、等模型返回都在里面。
 * 原话这一路的两秒装不下一次模型调用，所以另计。暂定值，等真机探针和评测再定。
 */
export const EXPANSION_TIMEOUT_MS = 10_000

/** 模型给的关键词最多取几组：每组各搜一路，组数决定多查几次库。 */
export const EXPANSION_MAX_GROUPS = 3
/** 每组最多取几个词：词多了这一路就接近任一命中，补来的多是噪声。暂定值，等评测复核。 */
export const EXPANSION_MAX_TERMS = 5
/** 单个词最多几个字符（按码点）：关键词不会更长，更长的多半是模型把整句当成了词。 */
export const EXPANSION_TERM_MAX_CHARS = 32

/**
 * 扩查后位置固定的轮数：从第一轮给出来的命中轮里挑（不含附在记忆下面的轮，第一轮因预算没给的也不算），按第一轮的装填顺序取前几个；
 * 扩查只往这几轮后面补。暂定值，按「其他原话」默认约五段的预算取。
 */
export const EXPANSION_PINNED_TURNS = 3
/**
 * 扩查各路在融合里的权重；第一轮的各路（原查询、记忆）是 1。按融合的 k = 60 算，只被一组命中的轮：
 * 该组第 1 名得 0.9/61，落在原查询第 7、8 名之间；第 5 名落在第 12、13 名之间；第 10 名落在第 17、18 名之间。
 * 取这个值是要单组第 1 名进原查询前 10 名、又排在原查询第 1 名之后（权重要在 61/70 和 1 之间）；
 * 两组以上命中同一轮时分数相加，会排到头部固定的几轮之后的最前面。暂定值，等评测复核。
 */
export const EXPANSION_LANE_WEIGHT = 0.9
/** 请求里带第一轮的几轮原话：和位置固定的轮同一个挑法，从第一轮给出来的命中轮里按第一轮的装填顺序取前几个。 */
export const EXPANSION_EXCERPT_TURNS = 3
/** 请求里带前几条命中记忆的名称和标签（按记忆检索的名次）。 */
export const EXPANSION_MEMORY_HINTS = 5
/** 只查原话时，语义桥取几条记忆候选（同记忆检索缺省返回的条数）。 */
export const MEMORY_BRIDGE_LIMIT = 10
/**
 * 只查原话时，语义桥最晚在检索开始后多少毫秒取完；到点没取完、或第一轮查完时已过这个点，就不要这一路。
 * 原话这一路一共两秒，留另一半给融合、装填和读标题，语义桥慢了只丢它自己，不拖垮原话。
 */
export const MEMORY_BRIDGE_DEADLINE_MS = 1000
/**
 * 请求里当前这一轮用户的话最多带多少个字符（按码点）：超过时留开头和结尾各一半，中间换成段间省略号。
 * 用户这一轮的要求一般在开头或结尾；贴进来的长日志、长文档不必整份发给另一个模型。2000 个汉字约 1200 token，
 * 和节选的三轮原话（受「其他原话」预算约束）同一量级。
 */
export const EXPANSION_USER_MESSAGE_MAX_CHARS = 2000

/** 扩查请求的系统提示。措辞交提示词审，改措辞只动这里。 */
export const EXPANSION_SYSTEM_PROMPT = [
  '你帮主对话补全一次过往对话检索的关键词。',
  '用户消息里有这次检索用的查询词，可能还有用户在当前这一轮说的话、第一轮检索找到的几段原话、和查询相关的几条记忆的名称和标签。',
  '先弄清用户这一轮想找什么，再从给出的原话、记忆名称和标签里挑真实出现过、又和要找的内容相关的写法；没有原话时，写用户当时最可能用的说法，比如同义的口语、中英文的不同写法、代码里的名字。',
  `给最多 ${EXPANSION_MAX_GROUPS} 组关键词，每组一行，组内的词用空格隔开，每组最多 ${EXPANSION_MAX_TERMS} 个词；同一组里放预期会在同一段原话里一起出现的词。`,
  '只输出这几行关键词。',
].join('\n')

/** 请求正文里各部分的开头一行。哪部分没有内容就不出那部分。 */
export const EXPANSION_QUERY_LEAD = '这次检索用的查询词：'
export const EXPANSION_USER_MESSAGE_LEAD = '用户在当前这一轮说的话：'
export const EXPANSION_EXCERPTS_LEAD = '第一轮检索找到的原话：'
export const EXPANSION_MEMORIES_LEAD = '和查询相关的记忆（名称和标签）：'

/** 扩查没成（调用失败、超时、没给出能用的词、补搜时库用不了）：结果就是第一轮的，在原话的说明里写这一句。 */
export const EXPANSION_FAILED_NOTE = '这次没能按相关的词补搜，以下是按原查询找到的原话。'
/** 用户另选的扩查模型这次用不了、改用了当前对话的模型：在原话的说明里写这一句。 */
export const EXPANSION_MODEL_FALLBACK_NOTE = '设置里为补搜选的模型这次用不了，改用了当前对话的模型。'

/** 扩查要用的边界，配置每次现读。 */
export interface ExpansionDeps {
  /** 扩查开关（配置 search.queryExpansion）。 */
  isEnabled(): boolean
  /** 宿主会话：当前会话的模型、按选择建模型、列模型（校验选择还在不在）、读当前会话的日志（取这一轮的用户消息）。 */
  host: Pick<HostSession, 'llmOf' | 'llmForRoute' | 'modelCatalog' | 'readSessionLog'>
  /** 后台模型的选择表，读 EXPANSION_SELECTION_KEY 那一条。 */
  selections: Pick<ModelSelectionStore, 'getForCall'>
  /**
   * 计时：ms 毫秒后 resolve。signal 触发后调用方不再等它，它 reject 或永不 resolve 都可以。
   * 缺省用 node:timers/promises 的 setTimeout；测试注入可控的计时。
   */
  wait?(ms: number, signal: AbortSignal): Promise<void>
}

/**
 * 第一轮结果弱不弱：按融合后的候选轮判（只查原话时就是原话一路的候选）。
 * 一轮都没有，或没有一轮是全命中档（`all`）时为弱；只有二元组命中（`substring`）、部分命中（`partial`）都算弱。
 */
export function isWeakRound(turns: ReadonlyArray<Pick<DialogueTurnCandidate, 'tier'>>): boolean {
  return !turns.some(turn => turn.tier === 'all')
}

/**
 * 模型回的文字 → 几组关键词，每组是空格连起来的一串查询（和 memory_search 的 query 同写法）。
 * 一行一组，每行先去掉首尾空白，跳过代码围栏行（以 ``` 开头）；去掉行首一个列表记号：`-`、`*`、`•`、`1.`、`1)` 后面要有空白或到行尾才算，
 * `1、` 后面可以不带空白（`1.5`、`--timeout` 这类词不当记号剥）。组内按空白和 `,`、`，`、`、` 切词、丢空词，
 * 单个词先截到 EXPANSION_TERM_MAX_CHARS 个码点再去掉组内重复，每组只留前 EXPANSION_MAX_TERMS 个词；没有词的组丢掉；
 * 只留前 EXPANSION_MAX_GROUPS 组。不校验词是否在原话里出现过。
 */
export function parseExpansionGroups(text: string): string[] {
  const groups: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) continue
    const body = trimmed.replace(/^(?:[-*•]|\d+[.)])(?:\s+|$)|^\d+、/u, '')
    const terms = [...new Set(body.split(/[\s,，、]+/u).filter(Boolean).map(term => [...term].slice(0, EXPANSION_TERM_MAX_CHARS).join('')))]
    if (terms.length > 0) groups.push(terms.slice(0, EXPANSION_MAX_TERMS).join(' '))
    if (groups.length === EXPANSION_MAX_GROUPS) break
  }
  return groups
}

/**
 * 只查原话时语义桥用的记忆候选：按记忆检索同一套关键词规则取，只取前 MEMORY_BRIDGE_LIMIT 条。
 * 只读记忆、不读主题索引、不记召回；范围同记忆检索（scope 为 global 查全局，workspace 查本项目，其余查可见的），
 * scope 为 workspace 而当前会话没有工作目录时不读，返回空。出错照常抛，由调用方丢掉这一路。
 */
export async function memoryBridgeCandidates(
  q: { query: string; types?: readonly string[]; scope?: 'global' | 'workspace' | 'all-visible' },
  workspacePath: string | undefined,
  deps: MemoryCandidateDeps,
): Promise<readonly MemoryCandidate[]> {
  if (q.scope === 'workspace' && workspacePath === undefined) return []
  const scope = q.scope === 'global' ? { kind: 'global' as const }
    : q.scope === 'workspace' ? { kind: 'workspace' as const, workspacePath: workspacePath! }
      : { kind: 'visible' as const, workspacePath }
  return (await findMemoryCandidates({ ...q, scope }, deps)).candidates.slice(0, MEMORY_BRIDGE_LIMIT)
}
