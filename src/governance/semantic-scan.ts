import type { MemoryRecord } from '../record-schema.ts'
import { SEVERITY_BY_TYPE, type Finding } from './schema.ts'
import { maskDiagnostic, maskSecretSurface, maskSecrets } from '../secrets.ts'
import { estimateTokens } from '../snapshot.ts'

/** 语义层的 LLM 抽象：纯逻辑只依赖这个接口，真机接线在 index.ts。 */
export interface SemanticLlm {
  /** 解析出的模型名（「让模型改」写在界面上）；宿主接线总会带上，测试桩可以不给。 */
  readonly model?: string
  /**
   * signal 触发时应尽快取消在途请求，并抛出 AbortError（宿主 exec.signal 契约）。
   * onUsage：宿主流里报了用量时，按这次调用的实际 token 数回调一次（宿主在出错收尾前报了用量的也计入）；没报就不回调。
   */
  complete(input: { system: string; user: string }, signal?: AbortSignal, onUsage?: (tokens: number) => void): Promise<string>
}

/** 宿主流 usage 块的形状（宿主 TokenUsage 的子集）：各项互不重叠，缓存读写不算进 inputTokens。 */
export interface ReportedUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 一次调用的实际用量：有 totalTokens 用它，否则输入、缓存读写、输出相加。数不合法时返回 undefined，不算。 */
export function reportedTokens(usage: ReportedUsage): number | undefined {
  const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
  if (!parts.every(isCount)) return undefined
  if (usage.totalTokens !== undefined) return isCount(usage.totalTokens) ? usage.totalTokens : undefined
  return parts.reduce((a, b) => a + b, 0)
}

/** 取消判定：signal 已 abort，或捕获到的错误本身就是 AbortError。取消不降级、直接向上抛。 */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === 'AbortError')
}

/** 一次调用里记忆列表的 token 预算（snapshot.estimateTokens 估算）。整库塞进一条消息会撑爆上下文窗口，超了就分批。 */
export const SEMANTIC_BATCH_TOKEN_BUDGET = 30_000

/** 基线全文长度上限——大基线不设限会连同记忆列表一起撑爆上下文，导致语义层整体 failed。 */
export const BASELINE_MAX_CHARS = 8000

/**
 * 基线是按事件顺序排列的指令消息（越靠后越新，同一文件的修订顶替旧文本后排在后面）。预算按整条消息分配、
 * 从最新往前收：每条消息自带来源与适用范围的抬头（"Instructions from: <path>"），按字符切会把规则和它的
 * 范围拆开、让 LLM 误用到别的目录。装不下的较早消息整条舍弃并说明；最新一条自身就超预算时只保留其开头。
 */
function renderBaselineMessages(messages: readonly string[]): string {
  const kept: string[] = []
  let used = 0
  for (const message of messages.toReversed()) {
    if (used + message.length > BASELINE_MAX_CHARS) break
    kept.unshift(message)
    used += message.length
  }
  if (kept.length === messages.length) return messages.join('\n\n')
  if (kept.length === 0) {
    const newest = messages[messages.length - 1]!
    const cut = newest.length - BASELINE_MAX_CHARS
    const earlier = messages.length > 1 ? `，更早的 ${messages.length - 1} 条未纳入垂直冲突检测` : ''
    return `（基线过长：最新一条指令消息已截断末尾 ${cut} 字符${earlier}）\n${newest.slice(0, BASELINE_MAX_CHARS)}`
  }
  const dropped = messages.slice(0, messages.length - kept.length)
  const droppedChars = dropped.reduce((n, m) => n + m.length, 0)
  return `（基线过长：较早的 ${dropped.length} 条指令消息共 ${droppedChars} 字符未纳入垂直冲突检测，较新的修订优先保留）\n${kept.join('\n\n')}`
}

const SEMANTIC_TYPES = new Set(['conflict', 'redundancy', 'misplaced', 'unclear'])

const SYSTEM_PROMPT = `你是记忆库治理审查员。对给出的记忆列表做四类语义问题检测：

- conflict 冲突：两条记忆互相矛盾（横向，memoryIds 填两条），或一条记忆与权威配置基线矛盾（垂直，memoryIds 填一条 + baselineRef 注明基线出处）。判定顺序：先看 scope 是否真的重叠 → 再看时间线索 → 垂直冲突对照基线。
- redundancy 冗余：行为判据——删掉其中一条，模型行为不变。记忆与基线重复也算（纵向冗余）。注意区分规则与 Why：解释"为什么"的记忆有独立价值，倾向保留不报。
- misplaced 错位：记忆放错了 scope（项目特定的放了 global，或全局偏好锁在项目桶）。
- unclear 模糊：新会话没有额外上下文时无法据此行动；或者只有一句结论，看不出是在什么情况下定的，因此判断不了它管到哪里。短本身不算问题；看得出管到哪里、也能照着做的短记忆不报。

只报有把握的问题，不确定就不报。只输出 JSON，不要任何其他文字，格式：
{"findings":[{"type":"conflict","memoryIds":["mem_x","mem_y"],"summary":"一句话描述","suggestedAction":"建议动作","baselineRef":"仅垂直冲突填，如 AGENTS.md：某规则"}]}
没有问题输出 {"findings":[]}`

export function buildSemanticPrompt(
  records: MemoryRecord[],
  baseline: readonly string[] | null,
): { system: string; user: string } {
  // 判断冲突用不到密钥原值，明确密钥不发给模型（与注入同口径）
  const baselineSection = baseline
    ? `## 权威配置基线（AGENTS.md/CLAUDE.md）\n${maskSecrets(renderBaselineMessages(baseline))}`
    : '## 权威配置基线\n（无权威配置基线，跳过垂直冲突检测）'
  return {
    system: SYSTEM_PROMPT,
    user: `${baselineSection}\n\n## 记忆列表（共 ${records.length} 条）\n${records.map(semanticMemoryLine).join('\n')}`,
  }
}

/** 记忆列表里的一条（明确密钥已遮）。分批按它估算 token，与发给模型的文字同一口径。 */
export function semanticMemoryLine(record: MemoryRecord): string {
  const r = maskSecretSurface(record)
  return `- id=${r.id} type=${r.type} scope=${r.scope}${r.workspacePath ? `(${r.workspacePath})` : ''}\n  content: ${r.content}\n  summary: ${r.summary}`
}

/**
 * 按 token 预算把记忆分批：没有记忆时不分批（不调用模型）；装得下就一批（原顺序）。装不下时按类型分组，
 * 同类型尽量同批——冲突、重复多发生在同类型之间；一组超预算再连续切开，单条超预算的自成一批。
 * 各段依次放进第一个还装得下的批，都装不下就开新批。每条恰好进一批。
 * 分批时组按类型名、组内按 createdAt 再 id 排：改一条记忆（更新时间变了）不会挪动别的记忆所在的批，
 * 成对问题不会因为批的边界漂移在两次体检之间时有时无。
 */
export function planSemanticBatches(records: MemoryRecord[], budget = SEMANTIC_BATCH_TOKEN_BUDGET): MemoryRecord[][] {
  if (records.length === 0) return []
  const costs = new Map(records.map(r => [r, estimateTokens(semanticMemoryLine(r))]))
  const costOf = (rs: readonly MemoryRecord[]) => rs.reduce((n, r) => n + costs.get(r)!, 0)
  if (costOf(records) <= budget) return [records]

  const stable = [...records].sort((a, b) =>
    (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const groups = new Map<string, MemoryRecord[]>()
  for (const r of stable) {
    const group = groups.get(r.type)
    if (group) group.push(r)
    else groups.set(r.type, [r])
  }
  const pieces: MemoryRecord[][] = []
  for (const group of groups.values()) {
    if (costOf(group) <= budget) {
      pieces.push(group)
      continue
    }
    let piece: MemoryRecord[] = []
    let used = 0
    for (const r of group) {
      if (piece.length > 0 && used + costs.get(r)! > budget) {
        pieces.push(piece)
        piece = []
        used = 0
      }
      piece.push(r)
      used += costs.get(r)!
    }
    pieces.push(piece)
  }

  const batches: Array<{ records: MemoryRecord[]; used: number }> = []
  for (const piece of pieces) {
    const cost = costOf(piece)
    const batch = batches.find(b => b.used + cost <= budget)
    if (batch) {
      batch.records.push(...piece)
      batch.used += cost
    } else {
      batches.push({ records: [...piece], used: cost })
    }
  }
  return batches.map(b => b.records)
}

/** 模型写的说明可能引用记忆里的密钥，会进待决账本、体检缓存与工具输出：两级都遮。 */
const maskText = (text: string) => maskSecrets(text, { severity: 'suspected' })

/** 解析 LLM 输出。整体解析失败返回 null（触发重试）；单条非法只跳过该条。 */
export function parseSemanticFindings(raw: string, knownIds: Set<string>): Finding[] | null {
  const stripped = raw.replace(/```(?:json)?/g, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return null
  }
  const findings = (parsed as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return null

  const out: Finding[] = []
  for (const item of findings) {
    if (item === null || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const type = f.type as string
    if (!SEMANTIC_TYPES.has(type)) continue
    // 去重后再数基数：模型可能把同一 id 写两遍，["mem_c","mem_c"] 当作横向冲突的两方会让
    // keep-left 删掉保留方（右侧 id 就是左侧 id）。
    const memoryIds = [...new Set((Array.isArray(f.memoryIds) ? f.memoryIds : [])
      .filter((id): id is string => typeof id === 'string' && knownIds.has(id)))]
    if (memoryIds.length === 0) continue
    // 空字符串 baselineRef 不算"有基线"：下游 dedupKey 用真值判断、pairKey 与 executeConfirm 用
    // !== undefined 判断，两者对空字符串的态度不一致，必须在这里收口成"要么是非空字符串要么不存在"。
    const baselineRef = typeof f.baselineRef === 'string' && f.baselineRef.length > 0 ? maskText(f.baselineRef) : undefined
    if (type === 'conflict') {
      // 冲突的基数必须在产出侧收口——消费方 memory_confirm 的横向分支只认
      // memoryIds[0]/[1]，多出或缺少都会导致"用户以为裁决了、实际什么都没发生"。
      const horizontal = memoryIds.length === 2 && baselineRef === undefined
      const vertical = memoryIds.length === 1 && baselineRef !== undefined
      if (!horizontal && !vertical) continue
    }
    out.push({
      type: type as Finding['type'],
      layer: 'semantic',
      severity: SEVERITY_BY_TYPE[type as keyof typeof SEVERITY_BY_TYPE],
      memoryIds,
      summary: typeof f.summary === 'string' ? maskText(f.summary) : '',
      suggestedAction: typeof f.suggestedAction === 'string' ? maskText(f.suggestedAction) : '',
      ...(baselineRef !== undefined ? { baselineRef } : {}),
    })
  }
  return out
}

/**
 * 语义层没做成的原因（最后一次尝试的）：模型调用抛错（带上错误的原话，宿主给了错误码时带上 hostCode），或输出解析不了。
 * 错误码不在这里吞掉：内容检查据它分出「模型用不了」（tools/scan.ts）。
 * 原话之后会进体检记录、视图和给模型的说明文字：AUTH 的原话可能回显部分凭据，对齐宿主不留（没有 message）；其余先遮掉疑似密钥。
 */
export type SemanticFailure =
  | { kind: 'model-error'; hostCode?: string; message?: string }
  | { kind: 'unparseable' }

/** 抛出的错误自带的错误码（宿主适配层挂在 code 上的字符串），没有为 undefined。 */
function errorCode(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function modelError(err: unknown): SemanticFailure {
  const hostCode = errorCode(err)
  if (hostCode === 'AUTH') return { kind: 'model-error', hostCode }
  return { kind: 'model-error', ...(hostCode !== undefined ? { hostCode } : {}), message: maskDiagnostic(err instanceof Error ? err.message : String(err)) }
}

/**
 * 语义层扫描：按 token 预算分批（planSemanticBatches），每批一次调用，解析失败带提示重试一次。
 * 单条就能判的问题每条都覆盖；成对的（冲突、重复）只在同一批里检出。任一批两次都失败，整层按失败返回
 * （failed:true、不交出别批的结果，也不再发后面的批，failure 是这一批最后一次尝试没做成的原因）。各批结果合并去重。
 * batches 是批数，不分批时为 1；没有记忆时为 0，不调用模型，按没有发现的成功扫描返回。
 */
export async function runSemanticScan(
  records: MemoryRecord[],
  baseline: readonly string[] | null,
  llm: SemanticLlm,
  signal?: AbortSignal,
  onUsage?: (tokens: number) => void,
): Promise<{ findings: Finding[]; failed: false; batches: number } | { findings: Finding[]; failed: true; batches: number; failure: SemanticFailure }> {
  const batches = planSemanticBatches(records)
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const batch of batches) {
    const found = await scanBatch(batch, baseline, llm, signal, onUsage)
    if (!Array.isArray(found)) return { findings: [], failed: true, batches: batches.length, failure: found }
    for (const f of found) {
      const key = `${f.type}|${[...f.memoryIds].sort().join('+')}|${f.baselineRef ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push(f)
    }
  }
  return { findings, failed: false, batches: batches.length }
}

/** 一批的调用：解析失败带提示重试一次，两次都不行返回重试那次没做成的原因。 */
async function scanBatch(
  records: MemoryRecord[],
  baseline: readonly string[] | null,
  llm: SemanticLlm,
  signal: AbortSignal | undefined,
  onUsage: ((tokens: number) => void) | undefined,
): Promise<Finding[] | SemanticFailure> {
  const knownIds = new Set(records.map(r => r.id))
  const prompt = buildSemanticPrompt(records, baseline)

  // LLM 调用本身可能抛（限流/超时/上下文超限/网络），必须与"输出无法解析"同等降级——
  // 否则 layers=full 时已经算好的规则层结果会被一起丢掉。
  let firstRaw: string | null = null
  try {
    firstRaw = await llm.complete(prompt, signal, onUsage)
  } catch (err) {
    // 用户取消不降级也不重试：立即向上抛，让工具结果标记为 isError（宿主 exec.signal 契约）。
    if (isAbort(err, signal)) throw err
    // 普通错误落到下面的重试
  }
  const first = firstRaw === null ? null : parseSemanticFindings(firstRaw, knownIds)
  if (first !== null) return first

  // 同上：重试调用本身也可能抛，与"重试输出仍无法解析"同等降级为失败。
  let retryRaw: string
  try {
    retryRaw = await llm.complete({ system: prompt.system, user: `${prompt.user}\n\n上次输出无法解析，请只输出 JSON。` }, signal, onUsage)
  } catch (err) {
    // 同首次：取消直接抛，不吞成失败
    if (isAbort(err, signal)) throw err
    // 两次都失败：原因带上错误码交给调用方
    return modelError(err)
  }
  return parseSemanticFindings(retryRaw, knownIds) ?? { kind: 'unparseable' }
}
