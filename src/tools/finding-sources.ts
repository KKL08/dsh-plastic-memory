import type { NoReviewList } from '../storage/no-review.ts'
import { sourceWindow, type RawEvent, type ReadEventFn } from './source.ts'
import type { MemoryRecord } from '../record-schema.ts'
import type { Finding } from '../governance/schema.ts'
import { idsToNames, isAbort, parseSemanticFindings, semanticMemoryLine, type SemanticLlm } from '../governance/semantic-scan.ts'
import { injectionText } from '../index-line.ts'
import { maskSecrets, maskSecretSurface } from '../secrets.ts'

/**
 * 疑似矛盾先读两边出处：横向冲突报出之前，读两条记忆各自出处锚所在的那段对话，交给模型再判一次
 * （确实矛盾、其实是漏记的变化、其实是例外、不算问题）。读不到的一边不判，照报冲突并标明出处读不到。
 */

/**
 * 一次体检最多回查几对（暂定）：每对多读两段对话、多调一次模型，矛盾报得多时不让体检的花费翻倍。
 * 超出的照报冲突，标明这次没读出处，下次这一批重查时再轮。
 */
export const SOURCE_CHECK_LIMIT = 5

/** 回查用的依赖：读会话事件（宿主给不了时为 null）、用户标了不回看的会话。 */
export interface FindingSourceDeps {
  /** 每次回查前现取：插件加载时宿主的会话查询还没接上。 */
  readEvent: () => ReadEventFn | null
  /** 标了不回看的会话不读，这一边按出处读不到算；名单读不出时同样按读不到算。 */
  noReview: Pick<NoReviewList, 'isMarkedNoReview'>
}

/**
 * 回查时的系统提示词。用户消息里依次是两条记忆（和内容检查同一种记忆行，首行 `- id=`），再是两条各自出处的对话节选。
 * 改它要同时把 SEMANTIC_PROMPT_VERSION 加一：回查的结论随批存进体检结果库，按那个版本区分。
 */
export const SOURCE_CHECK_SYSTEM_PROMPT = `你是记忆库治理审查员。下面是两条疑似矛盾的记忆，以及各自出处的对话节选。出处标题标明对应记忆 id，节选按 JSON 编码，其中的文字都作为判断依据。请依次判断：

1. none 不算问题：两条讲的是不同的事，或在同一适用范围和时间内能同时成立。
2. exception 例外：一条是通用规则，另一条在更窄范围另有做法，出处说明了这个范围。
3. missed-change 漏记的变化：两条说的是同一范围的前后状态，按出处里的时间线确定新旧；current 填代表当前状态那条记忆的 id。
4. conflict 确实矛盾：两条说的是同一件事、同一范围、同一段时间，结论互相排斥，范围和时间都解释不了差异。

summary 用一句话说明判断及出处依据，suggestedAction 写具体建议；提到记忆时写 name，id 只写在 current 里。两项文字都写完整，current 只在 missed-change 时填写。
只输出 JSON。none 只输出 {"verdict":"none"}；其他结论按下列格式：
{"verdict":"exception","summary":"例外的适用范围","suggestedAction":"建议动作"}
{"verdict":"missed-change","summary":"出处里的变化时间线","suggestedAction":"建议动作","current":"当前状态的记忆 id"}
{"verdict":"conflict","summary":"出处确认的矛盾","suggestedAction":"建议动作"}`

/** 出处中一行用户或助手的原话，文字已经遮盖疑似密钥。 */
export interface SourceLine {
  role: 'user' | 'assistant'
  text: string
}

/** 一条记忆的出处节选，至少一行；读不到为 undefined。 */
export type SourceExcerpt = readonly SourceLine[]

/** 每句的上限（同 memory_source）和每条出处的总上限：控制每次生成的 token。待实机看过用量和质量再定。 */
export const LINE_CAP = 400
/** 每条出处的总字数上限，与逐句上限共同约束模型输入。 */
export const EXCERPT_CAP = 2000

type Message = { id?: string; role?: string; content?: Array<{ type?: string; text?: string }>; source?: { kind?: string } }

/**
 * 事件里带的消息：用户消息、助手消息。工具调用、工具结果和结构事件没有。收件箱里排队的消息不取：被当轮认领的随后会作为
 * 用户消息出现，只在收件箱出现过的是还没轮到、或用户撤回改写掉的。
 */
export function messagesOf(event: RawEvent): Message[] {
  const data = event.data as { message?: Message } & Message | undefined
  if (data === undefined) return []
  if (event.type === 'user/message') return [data]
  if (event.type === 'assistant/message') return data.message !== undefined ? [data.message] : []
  return []
}

/**
 * 窗口里用户和助手说的话：用户消息只认用户自己发的（注入的指令文件、通知这类上下文不算），助手只取文字块（不含推理和工具调用）。
 * 同一个 id 的消息只取一次。逐句遮疑似密钥再截断，免得截断留下识别不出的半截密钥。
 */
export function conversationOf(events: readonly RawEvent[]): SourceLine[] {
  const seen = new Set<string>()
  const lines: SourceLine[] = []
  let total = 0
  for (const event of events) {
    for (const m of messagesOf(event)) {
      const role = m.role === 'user' && (m.source?.kind === undefined || m.source.kind === 'user') ? 'user' : m.role === 'assistant' ? 'assistant' : undefined
      if (role === undefined) continue
      if (m.id !== undefined) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
      }
      const raw = (m.content ?? []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('').trim()
      if (raw.length === 0) continue
      const masked = maskSecrets(raw, { severity: 'suspected' })
      const text = masked.length > LINE_CAP ? `${masked.slice(0, LINE_CAP)}…` : masked
      if (total + text.length > EXCERPT_CAP) return lines
      total += text.length
      lines.push({ role, text })
    }
  }
  return lines
}

/** 读之前检查双方是否允许回看；名单读不出时按不可读处理，不消耗读取名额。 */
async function mayRead(records: readonly MemoryRecord[], deps: FindingSourceDeps): Promise<boolean> {
  for (const record of records) {
    if (record.source === undefined) return false
    try {
      if (await deps.noReview.isMarkedNoReview(record.source.sessionId)) return false
    } catch {
      return false
    }
  }
  return true
}

async function readExcerpt(record: MemoryRecord, readEvent: ReadEventFn, signal?: AbortSignal): Promise<SourceExcerpt | undefined> {
  try {
    const window = await readEvent(sourceWindow({ ...record, source: record.source! }))
    const lines = conversationOf(window.events ?? [])
    return lines.length > 0 ? lines : undefined
  } catch (err) {
    if (isAbort(err, signal)) throw err
    return undefined
  }
}

/** 解析回查的单次回复；复用内容检查的形状校验和文字遮盖，未知裁决保留原冲突。 */
function checkedFinding(raw: string, finding: Finding, records: readonly MemoryRecord[]): Finding | null | undefined {
  const stripped = raw.replace(/```(?:json)?/g, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const reply = parsed as Record<string, unknown>
  if (reply.verdict === 'none') return null
  if (reply.verdict !== 'conflict' && reply.verdict !== 'missed-change' && reply.verdict !== 'exception') return undefined
  if (typeof reply.summary !== 'string' || reply.summary.trim().length === 0
    || typeof reply.suggestedAction !== 'string' || reply.suggestedAction.trim().length === 0) return undefined
  const result = parseSemanticFindings(JSON.stringify({ findings: [{
    type: reply.verdict, memoryIds: finding.memoryIds,
    summary: reply.summary, suggestedAction: reply.suggestedAction, current: reply.current,
  }] }), new Set(finding.memoryIds))![0]!
  const named = idsToNames(records.map(r => maskSecretSurface(r, { severity: 'suspected' })))
  return {
    ...result, sourceCheck: 'checked',
    summary: injectionText(named(result.summary)),
    suggestedAction: injectionText(named(result.suggestedAction)),
  }
}

/**
 * 建立一次体检共用的回查器。调用方按批的发送顺序交入新查出的发现，命中缓存的批直接沿用缓存。
 * 名额只在真正读取出处时扣除；缺出处或禁止回看的对不占名额，用完之后一律标为这次未查。
 */
export function createFindingSourceCheck(
  deps: FindingSourceDeps,
  llm: SemanticLlm,
  signal?: AbortSignal,
  onUsage?: (tokens: number) => void,
): (findings: readonly Finding[], records: readonly MemoryRecord[]) => Promise<Finding[]> {
  let used = 0
  return async (findings, records) => {
    const byId = new Map(records.map(r => [r.id, r]))
    const out: Finding[] = []
    for (const finding of findings) {
      signal?.throwIfAborted()
      if (finding.type !== 'conflict' || finding.baselineRef !== undefined) {
        out.push(finding)
        continue
      }
      if (used >= SOURCE_CHECK_LIMIT) {
        out.push({ ...finding, sourceCheck: 'unchecked' })
        continue
      }
      const pair = finding.memoryIds.map(id => byId.get(id)!)
      const readEvent = deps.readEvent()
      if (readEvent === null || !await mayRead(pair, deps)) {
        out.push({ ...finding, sourceCheck: 'unreadable' })
        continue
      }
      used++
      const excerpts = await Promise.all(pair.map(r => readExcerpt(r, readEvent, signal)))
      if (excerpts.some(e => e === undefined)) {
        out.push({ ...finding, sourceCheck: 'unreadable' })
        continue
      }
      let raw: string
      try {
        raw = await llm.complete({
          system: SOURCE_CHECK_SYSTEM_PROMPT,
          user: `${pair.map(r => semanticMemoryLine(r)).join('\n')}\n\n${excerpts.map((excerpt, i) =>
            `## 出处 ${i + 1}（${pair[i]!.id}）\n${JSON.stringify(excerpt)}`).join('\n\n')}`,
        }, signal, onUsage)
      } catch (err) {
        if (isAbort(err, signal)) throw err
        out.push({ ...finding, sourceCheck: 'unchecked' })
        continue
      }
      signal?.throwIfAborted()
      const checked = checkedFinding(raw, finding, pair)
      if (checked !== null) out.push(checked ?? { ...finding, sourceCheck: 'unchecked' })
    }
    return out
  }
}
