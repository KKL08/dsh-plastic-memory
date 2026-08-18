import type { MemoryRecord } from './record-schema.ts'
import { CONFIDENCE_BY_SOURCE, memoryRecordSchema } from './record-schema.ts'
import type { MemoryStore } from './store.ts'
import type { TypeRegistry } from './type-registry.ts'

export interface SaveCandidate {
  action: 'create' | 'update'
  id?: string
  name: string
  type: string
  scope: 'global' | 'workspace'
  content: string
  summary: string
  tags: string[]
  sourceMode: MemoryRecord['source']['sourceMode']
  confidence?: number
  supersedes?: string[]
  validFrom?: number
  validTo?: number
  force?: boolean
}

export type PipelineResult =
  | { kind: 'saved'; record: MemoryRecord }
  | { kind: 'updated'; record: MemoryRecord }
  | { kind: 'duplicate-suspected'; existing: Array<{ id: string; summary: string }> }
  | { kind: 'rejected'; reason: string }

/** 从文本提取用于结构去重的关键实体。 */
export function extractEntities(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/`([^`]+)`/g)) out.add(m[1])
  for (const m of text.matchAll(/https?:\/\/[^\s，。」）)]+/g)) out.add(m[0])
  for (const m of text.matchAll(/(?<![\w/])((?:[\w.-]+\/)+[\w.-]+)/g)) out.add(m[1])
  for (const m of text.matchAll(/[「"']([^「」"']{2,24})[」"']/g)) out.add(m[1])
  for (const m of text.matchAll(/\b[A-Z]{2,8}\b/g)) out.add(m[0])
  return [...out]
}

/**
 * 剔除值为 undefined 的顶层键。MemoryRecord 的可选字段（workspacePath/validFrom/
 * validTo/supersedes 等）不填时为 undefined，zod .optional() 会把这些键连值保留，
 * 使记录无法无损 JSON 序列化。dsh 工具输出要求 lossless JSON——save 返回带 undefined
 * 键的记录会被框架以 "value is not lossless JSON" 拒绝。put 前也剔除，保证内存缓存干净。
 */
function pruneUndefined(record: MemoryRecord): MemoryRecord {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) out[k] = v
  }
  return out as MemoryRecord
}

export async function runSavePipeline(
  candidate: SaveCandidate,
  deps: {
    store: MemoryStore
    registry: TypeRegistry
    workspacePath: string | undefined
    session: { id: string; lastSeq: number }
  },
): Promise<PipelineResult> {
  const { store, registry, session } = deps
  const now = Date.now()

  // 1. 格式校验
  if (!registry.has(candidate.type)) {
    return { kind: 'rejected', reason: `未知类型 "${candidate.type}"，可用类型见工具说明` }
  }
  const scope = candidate.scope === 'workspace' && deps.workspacePath === undefined ? 'global' : candidate.scope
  if (candidate.action === 'update') {
    const target = candidate.id ? store.get(candidate.id) : undefined
    if (!target || target.status === 'deleted') {
      return { kind: 'rejected', reason: `更新目标不存在或已删除：${candidate.id ?? '(缺 id)'}` }
    }
  }

  // 2. confidence 决议：只能下调
  const cap = CONFIDENCE_BY_SOURCE[candidate.sourceMode]
  const confidence = Math.min(candidate.confidence ?? cap, cap)

  // 3. 结构去重（仅 create，force 跳过）
  if (candidate.action === 'create' && !candidate.force) {
    const entities = extractEntities(`${candidate.content}\n${candidate.summary}`)
    if (entities.length > 0) {
      const peers = store.query({
        types: [candidate.type],
        scope: scope === 'global' ? { kind: 'global' } : { kind: 'workspace', path: deps.workspacePath! },
        status: ['active'],
      })
      const hits = peers.filter(p =>
        extractEntities(`${p.content}\n${p.summary}`).some(e => entities.includes(e)))
      if (hits.length > 0) {
        return { kind: 'duplicate-suspected', existing: hits.map(h => ({ id: h.id, summary: h.summary })) }
      }
    }
  }

  // 4. 审批：P0 只有 auto，其余配置在插件入口已警告降级

  // 5. 持久化（写入前必须过 schema——KvTable.put 不校验，脏记录会让下次 domain open 整库拒载）
  const source = { sessionId: session.id, eventRange: [0, session.lastSeq] as [number, number], sourceMode: candidate.sourceMode }
  let record: MemoryRecord
  if (candidate.action === 'update') {
    const target = store.get(candidate.id!)!
    record = {
      ...target,
      name: candidate.name, type: candidate.type, scope, tags: candidate.tags,
      content: candidate.content, summary: candidate.summary,
      workspacePath: scope === 'workspace' ? deps.workspacePath : undefined,
      source, confidence,
      validFrom: candidate.validFrom, validTo: candidate.validTo,
      updatedAt: now, lastConfirmedAt: now,
      supersedes: candidate.supersedes ?? target.supersedes,
    }
  } else {
    record = {
      id: `mem_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: candidate.name, type: candidate.type, scope,
      workspacePath: scope === 'workspace' ? deps.workspacePath : undefined,
      tags: candidate.tags, content: candidate.content, summary: candidate.summary,
      source, createdAt: now, updatedAt: now, lastConfirmedAt: now,
      lastRecalledAt: null, recallCount: 0,
      validFrom: candidate.validFrom, validTo: candidate.validTo,
      status: 'active', confidence, supersedes: candidate.supersedes,
    }
  }
  const parsed = memoryRecordSchema.safeParse(record)
  if (!parsed.success) {
    return { kind: 'rejected', reason: `字段校验失败：${parsed.error.issues.map(i => i.message).join('；')}` }
  }
  const clean = pruneUndefined(parsed.data)
  await store.put(clean)

  // 6. supersedes 处理
  for (const oldId of candidate.supersedes ?? []) {
    const old = store.get(oldId)
    if (old && old.id !== clean.id) {
      await store.put({ ...old, status: 'superseded', updatedAt: now })
    }
  }

  return candidate.action === 'update' ? { kind: 'updated', record: clean } : { kind: 'saved', record: clean }
}
