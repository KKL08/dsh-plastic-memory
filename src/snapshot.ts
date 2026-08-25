import type { MemoryRecord } from './record-schema.ts'
import type { MemoryStore } from './store.ts'
import type { TypeRegistry } from './type-registry.ts'
import { sourceNote, formatIndexLine } from './index-line.ts'
import { workspaceDirName } from './storage/paths.ts'

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
  /** 记忆文件根目录（运行时解析）。给出时在快照末尾附一行磁盘路径，让 grep 通道在自定义根下也可发现。 */
  memoryRoot?: string
}): { text: string; coreIds: string[] } {
  const { registry, now } = deps
  const all = deps.store.query({ scope: { kind: 'visible', workspacePath: deps.workspacePath } })
  if (all.length === 0) return { text: COLD_START_TEXT, coreIds: [] }

  const parts: string[] = ['# 长期记忆']
  let used = estimateTokens(parts[0])

  // core 区：完整正文，占预算一半以内
  const coreBudget = deps.budget * 0.5
  const coreRecords = all
    .filter(r => registry.get(r.type).recall === 'core')
    .sort((a, b) => b.confidence - a.confidence || b.recallCount - a.recallCount)
  const coreIncluded: MemoryRecord[] = []
  for (const r of coreRecords) {
    // ⑤ 归属前缀：模型不信来路不明的裸句，标出这是长期记忆及其类型，减少"全文在手仍重搜"
    const line = `- 【记忆·${registry.get(r.type).label}】${r.content}${sourceNote(r)}`
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
  // ⑧ 磁盘路径：让 dsh 原生 grep/Read 通道可发现记忆文件。**只透 global + 当前项目两处**——
  // 所有 workspace 记忆都在同一 memories 根下当兄弟目录，若透整根会让模型 grep 到别项目的
  // 私有记忆（跨项目泄漏）。跨项目透明可读的只应是 global；别项目记忆除非用户明确给路径才访问。
  if (deps.memoryRoot) {
    const lines = ['\n记忆文件在磁盘（可直接 grep/读取全文）：', `- 全局记忆：${deps.memoryRoot}/global/`]
    if (deps.workspacePath !== undefined) {
      lines.push(`- 本项目记忆：${deps.memoryRoot}/${workspaceDirName(deps.workspacePath)}/`)
    }
    lines.push('其他项目的记忆不在上列——除非用户明确给出该项目路径，否则不要去读别的 workspace 目录。')
    parts.push(lines.join('\n'))
  }

  return { text: parts.join('\n'), coreIds: coreIncluded.map(r => r.id) }
}
