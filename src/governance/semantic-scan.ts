import type { MemoryRecord } from '../record-schema.ts'
import { SEVERITY_BY_TYPE, type Finding } from './schema.ts'

/** 语义层的 LLM 抽象：纯逻辑只依赖这个接口，真机接线在 index.ts。 */
export interface SemanticLlm {
  complete(input: { system: string; user: string }): Promise<string>
}

/** 单次语义扫描分析的记忆条数上限——超出会把整库内容塞进一条消息，撑爆上下文窗口。 */
export const SEMANTIC_SCAN_MAX_RECORDS = 200

const SEMANTIC_TYPES = new Set(['conflict', 'redundancy', 'misplaced', 'unclear'])

const SYSTEM_PROMPT = `你是记忆库治理审查员。对给出的记忆列表做四类语义问题检测：

- conflict 冲突：两条记忆互相矛盾（横向，memoryIds 填两条），或一条记忆与权威配置基线矛盾（垂直，memoryIds 填一条 + baselineRef 注明基线出处）。判定顺序：先看 scope 是否真的重叠 → 再看时间线索 → 垂直冲突对照基线。
- redundancy 冗余：行为判据——删掉其中一条，模型行为不变。记忆与基线重复也算（纵向冗余）。注意区分规则与 Why：解释"为什么"的记忆有独立价值，倾向保留不报。
- misplaced 错位：记忆放错了 scope（项目特定的放了 global，或全局偏好锁在项目桶）。
- unclear 模糊：新会话没有额外上下文时无法据此行动。

只报有把握的问题，不确定就不报。只输出 JSON，不要任何其他文字，格式：
{"findings":[{"type":"conflict","memoryIds":["mem_x","mem_y"],"summary":"一句话描述","suggestedAction":"建议动作","baselineRef":"仅垂直冲突填，如 AGENTS.md：某规则"}]}
没有问题输出 {"findings":[]}`

export function buildSemanticPrompt(
  records: MemoryRecord[],
  baseline: string | null,
): { system: string; user: string } {
  const baselineSection = baseline
    ? `## 权威配置基线（AGENTS.md/CLAUDE.md）\n${baseline}`
    : '## 权威配置基线\n（无权威配置基线，跳过垂直冲突检测）'
  const memoryLines = records.map(r =>
    `- id=${r.id} type=${r.type} scope=${r.scope}${r.workspacePath ? `(${r.workspacePath})` : ''}\n  content: ${r.content}\n  summary: ${r.summary}`)
  return {
    system: SYSTEM_PROMPT,
    user: `${baselineSection}\n\n## 记忆列表（共 ${records.length} 条）\n${memoryLines.join('\n')}`,
  }
}

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
    const memoryIds = (Array.isArray(f.memoryIds) ? f.memoryIds : [])
      .filter((id): id is string => typeof id === 'string' && knownIds.has(id))
    if (memoryIds.length === 0) continue
    // 空字符串 baselineRef 不算"有基线"：下游 dedupKey 用真值判断、executeConfirm 用
    // !== undefined 判断，两者对空字符串的态度不一致，必须在这里收口成"要么是非空字符串要么不存在"。
    const baselineRef = typeof f.baselineRef === 'string' && f.baselineRef.length > 0 ? f.baselineRef : undefined
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
      summary: typeof f.summary === 'string' ? f.summary : '',
      suggestedAction: typeof f.suggestedAction === 'string' ? f.suggestedAction : '',
      ...(baselineRef !== undefined ? { baselineRef } : {}),
    })
  }
  return out
}

/** 语义层扫描：一次调用批量分析；解析失败带提示重试一次，仍失败则 failed:true。 */
export async function runSemanticScan(
  records: MemoryRecord[],
  baseline: string | null,
  llm: SemanticLlm,
): Promise<{ findings: Finding[]; failed: boolean; truncated?: number }> {
  // 全量记忆一次性塞进一条消息没有上限，库大了会撑爆上下文窗口——只分析前
  // SEMANTIC_SCAN_MAX_RECORDS 条，未分析的数量报给调用方，让用户知道结果不全。
  const truncated = Math.max(0, records.length - SEMANTIC_SCAN_MAX_RECORDS)
  const analyzed = truncated > 0 ? records.slice(0, SEMANTIC_SCAN_MAX_RECORDS) : records
  const truncatedField = truncated > 0 ? { truncated } : {}

  const knownIds = new Set(analyzed.map(r => r.id))
  const prompt = buildSemanticPrompt(analyzed, baseline)

  // LLM 调用本身可能抛（限流/超时/上下文超限/网络），必须与"输出无法解析"同等降级——
  // 否则 layers=full 时已经算好的规则层结果会被一起丢掉。
  let firstRaw: string | null = null
  try {
    firstRaw = await llm.complete(prompt)
  } catch {
    // 落到下面的重试
  }
  const first = firstRaw === null ? null : parseSemanticFindings(firstRaw, knownIds)
  if (first !== null) return { findings: first, failed: false, ...truncatedField }

  // 同上：重试调用本身也可能抛，与"重试输出仍无法解析"同等降级为 failed。
  let retryRaw: string | null = null
  try {
    retryRaw = await llm.complete({ system: prompt.system, user: `${prompt.user}\n\n上次输出无法解析，请只输出 JSON。` })
  } catch {
    // 两次都失败，落到下面返回 failed:true
  }
  const retry = retryRaw === null ? null : parseSemanticFindings(retryRaw, knownIds)
  if (retry !== null) return { findings: retry, failed: false, ...truncatedField }
  return { findings: [], failed: true, ...truncatedField }
}
