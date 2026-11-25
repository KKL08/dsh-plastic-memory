import type { MemoryRecord } from '../record-schema.ts'
import { injectionText } from '../index-line.ts'
import { extractEntities } from '../text.ts'
import { maskSecrets, maskSecretSurface } from '../secrets.ts'
import { isAbort, type SemanticLlm } from './semantic-scan.ts'

/**
 * 跨项目重复主题：多个 workspace 各自记了同一件事而 global 缺位——"该全局"的行为证据。
 * memoryIds：模型点名的、各项目里说这件事的那几条（只留提示词里列出、只在一个项目里出现的 id；分属至少两个项目才有这一项，
 * 有这一项的才挂进待决账本）。promote：建议升为全局的那一条（memoryIds 里的一条，没有或不在里面时没有这一项）。
 * 实体聚类保底给的没有这两项。
 */
export interface CrossWsDuplicate {
  topic: string
  workspaces: string[]
  suggestion: string
  memoryIds?: string[]
  promote?: string
}

/** 跨项目比较提示词的版本：改提示词或摘要行的写法时加一。缓存的结果按它区分。 */
export const CROSS_WS_PROMPT_VERSION = 2

/** 呈现限流：体检报告最多列这些，避免弱信号淹没主报告。 */
export const CROSS_WS_LIMIT = 3

/**
 * 规则层保底（无 LLM 时用）：跨 workspace 实体重叠聚类。实体抽取对中文散文召回有限、
 * 常见标识符会误报，所以措辞用"疑似"、限流呈现，只当线索不当结论。
 */
export function findEntityDuplicates(
  byWorkspace: ReadonlyMap<string, readonly MemoryRecord[]>,
  globalRecords: readonly MemoryRecord[],
): CrossWsDuplicate[] {
  const globalEntities = new Set(globalRecords.flatMap(r => extractEntities(`${r.content}\n${r.summary}`)))
  const entityWs = new Map<string, Set<string>>()
  for (const [ws, records] of byWorkspace) {
    for (const r of records) {
      for (const e of extractEntities(`${r.content}\n${r.summary}`)) {
        if (globalEntities.has(e)) continue
        const set = entityWs.get(e) ?? new Set<string>()
        set.add(ws)
        entityWs.set(e, set)
      }
    }
  }
  return [...entityWs.entries()]
    .filter(([, wsSet]) => wsSet.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, CROSS_WS_LIMIT)
    .map(([entity, wsSet]) => {
      // 实体取自原文，可能就是密钥：聚类照原文，进报告前和注入同口径遮掉高危
      const shown = maskSecrets(entity)
      return {
        topic: shown,
        workspaces: [...wsSet].sort(),
        suggestion: `疑似跨项目重复（实体「${shown}」出现在 ${wsSet.size} 个项目），若确属通用可提炼一条 global 记忆`,
      }
    })
}

const SYSTEM_PROMPT = `你是记忆库治理审查员。给出的是多个项目（workspace）各自的记忆摘要清单和全局（global）记忆清单。
找出"多个项目重复记录同一件事、而 global 缺位"的主题——这是该内容本应全局共享的行为证据。
判定标准：至少两个项目在讲同一个事实/偏好/流程；global 清单里没有对应条目；内容确实与具体项目无关。
只报有把握的主题。只输出 JSON，格式：
{"duplicates":[{"topic":"一句话概括主题","workspaces":["路径1","路径2"],"suggestion":"建议提炼成怎样的一条 global 记忆","memoryIds":["mem_a","mem_b"],"promote":"mem_a"}]}
workspaces 原样填标题里的项目路径；memoryIds 取各项目清单里的记忆 id，覆盖至少两个项目；promote 填 memoryIds 中建议升为全局的那条 id。
没有发现输出 {"duplicates":[]}`

/** 摘要行标出记忆 id，正文遮掉高危密钥并折成一行。 */
export const summaryLine = (r: MemoryRecord): string => `- [${r.id}] ${injectionText(maskSecretSurface(r).summary)}`

export function buildCrossWsPrompt(
  byWorkspace: ReadonlyMap<string, readonly MemoryRecord[]>,
  globalRecords: readonly MemoryRecord[],
): { system: string; user: string } {
  const sections: string[] = []
  for (const [ws, records] of byWorkspace) {
    sections.push(`## 项目 ${ws}（${records.length} 条）\n${records.map(summaryLine).join('\n')}`)
  }
  sections.push(`## global（${globalRecords.length} 条）\n${globalRecords.length > 0 ? globalRecords.map(summaryLine).join('\n') : '（空）'}`)
  return { system: SYSTEM_PROMPT, user: sections.join('\n\n') }
}

/**
 * 解析跨项目比较的输出。ids：提示词里列出、只在一个项目里出现的记忆 id 和它所在的项目（同一个 id 出现在几个项目里的不在表里）；
 * 不在表里的 id 丢掉。不给时 memoryIds、promote 一律不留。
 */
export function parseCrossWsResult(raw: string, knownWs: ReadonlySet<string>, ids?: ReadonlyMap<string, string>): CrossWsDuplicate[] | null {
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
  const duplicates = (parsed as { duplicates?: unknown }).duplicates
  if (!Array.isArray(duplicates)) return null
  const out: CrossWsDuplicate[] = []
  for (const item of duplicates) {
    if (item === null || typeof item !== 'object') continue
    const d = item as Record<string, unknown>
    const workspaces = (Array.isArray(d.workspaces) ? d.workspaces : [])
      .filter((w): w is string => typeof w === 'string' && knownWs.has(w))
    if (workspaces.length < 2 || typeof d.topic !== 'string' || d.topic.length === 0) continue
    const memoryIds = [...new Set((Array.isArray(d.memoryIds) ? d.memoryIds : [])
      .filter((id): id is string => typeof id === 'string' && ids?.has(id) === true))]
    const isCrossProject = new Set(memoryIds.map(id => ids!.get(id))).size >= 2
    // 模型的原话会进体检结果库、返回给界面：高危和疑似密钥都先遮掉（同内容检查的发现）
    out.push({
      topic: maskSecrets(d.topic, { severity: 'suspected' }),
      workspaces: workspaces.sort(),
      suggestion: typeof d.suggestion === 'string' ? maskSecrets(d.suggestion, { severity: 'suspected' }) : '',
      ...(isCrossProject ? { memoryIds, ...(typeof d.promote === 'string' && memoryIds.includes(d.promote) ? { promote: d.promote } : {}) } : {}),
    })
  }
  return out.slice(0, CROSS_WS_LIMIT)
}

/** 语义层主力：一次调用聚合分析。失败（调用抛出或输出无法解析）返回 failed，调用方降级到实体保底。 */
export async function runCrossWsScan(
  byWorkspace: ReadonlyMap<string, readonly MemoryRecord[]>,
  globalRecords: readonly MemoryRecord[],
  llm: SemanticLlm,
  signal?: AbortSignal,
  onUsage?: (tokens: number) => void,
): Promise<{ items: CrossWsDuplicate[]; failed: boolean }> {
  const prompt = buildCrossWsPrompt(byWorkspace, globalRecords)
  let raw: string | null = null
  try {
    raw = await llm.complete(prompt, signal, onUsage)
  } catch (err) {
    // 用户取消不降级到实体保底：立即向上抛（宿主 exec.signal 契约）。
    if (isAbort(err, signal)) throw err
    // 普通失败降级到调用方的实体保底
  }
  const owners = new Map<string, Set<string>>()
  for (const [ws, records] of byWorkspace) {
    for (const r of records) {
      const scopes = owners.get(r.id) ?? new Set<string>()
      scopes.add(ws)
      owners.set(r.id, scopes)
    }
  }
  const ids = new Map([...owners].filter(([, scopes]) => scopes.size === 1).map(([id, scopes]) => [id, [...scopes][0]!]))
  const items = raw === null ? null : parseCrossWsResult(raw, new Set(byWorkspace.keys()), ids)
  if (items === null) return { items: [], failed: true }
  return { items, failed: false }
}
