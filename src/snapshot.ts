import type { MemoryRecord } from './record-schema.ts'
import type { MemoryStore } from './store.ts'
import type { TypeRegistry } from './type-registry.ts'
import { sourceNote, formatIndexLine } from './index-line.ts'

export const COLD_START_TEXT = `记忆库当前为空。如果时机合适，可以问一句用户是否愿意介绍自己的背景（角色、常用技术、工作习惯），愿意就用 memory_save 记下来；不愿意就在后续任务中自然积累，不要追问。`

/** 粗略 token 估算：中文字 ×1.5，其余按空白分词 ×1.3。预算是软约束，够用即可。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length
  const words = text.replace(/[一-鿿]/g, ' ').split(/\s+/).filter(Boolean).length
  return Math.ceil(cjk * 1.5 + words * 1.3)
}

export function assembleSnapshot(deps: {
  store: MemoryStore
  registry: TypeRegistry
  workspacePath: string | undefined
  budget: number
  now: number
}): string {
  const { registry, now } = deps
  const all = deps.store.query({ scope: { kind: 'visible', workspacePath: deps.workspacePath } })
  if (all.length === 0) return COLD_START_TEXT

  const parts: string[] = ['# 长期记忆']
  let used = estimateTokens(parts[0])

  // core 区：完整正文，占预算一半以内
  const coreBudget = deps.budget * 0.5
  const coreRecords = all
    .filter(r => registry.get(r.type).recall === 'core')
    .sort((a, b) => b.confidence - a.confidence || b.recallCount - a.recallCount)
  const coreIncluded: MemoryRecord[] = []
  for (const r of coreRecords) {
    const line = `- ${r.content}${sourceNote(r)}`
    const cost = estimateTokens(line)
    if (used + cost > coreBudget) break
    parts.push(line)
    used += cost
    coreIncluded.push(r)
  }

  // 索引区：全部记忆按类型分组（含 core 区已出现的），超预算按治理优先级 low → medium → high 整组丢弃
  const groups = new Map<string, MemoryRecord[]>()
  for (const r of all) {
    const list = groups.get(r.type) ?? []
    list.push(r)
    groups.set(r.type, list)
  }
  const priorityOrder = { high: 0, medium: 1, low: 2 } as const
  const sortedGroups = [...groups.entries()]
    .sort((a, b) => priorityOrder[registry.get(a[0]).governancePriority] - priorityOrder[registry.get(b[0]).governancePriority])

  const omitted: Array<{ type: string; count: number }> = []
  for (const [type, records] of sortedGroups) {
    const def = registry.get(type)
    const lines = [`\n## ${def.label}（${type}）`]
    for (const r of records) {
      lines.push(formatIndexLine(r, { passive: def.recall === 'passive' }))
    }
    const cost = estimateTokens(lines.join('\n'))
    if (used + cost > deps.budget) {
      omitted.push({ type, count: records.length })
      continue
    }
    parts.push(...lines)
    used += cost
  }
  for (const o of omitted) {
    parts.push(`\n另有 ${o.count} 条 ${o.type} 记忆未列出，可用 memory_search 查询。`)
  }
  parts.push('\n想看索引里某条记忆的全文，用 memory_search 按 id 或关键词查。')

  deps.store.markRecalled(coreIncluded.map(r => r.id))
  return parts.join('\n')
}
