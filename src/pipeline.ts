import type { MemoryRecord } from './record-schema.ts'
import type { CodedNote, RejectCode, WarningCode } from './contract-codes.ts'
import { CONFIDENCE_BY_SOURCE, memoryRecordSchema } from './record-schema.ts'
import type { MemoryStore } from './store.ts'
import type { TypeRegistry } from './type-registry.ts'
import type { SnapshotStore } from './governance/snapshots.ts'
import { detectSecrets } from './secrets.ts'
import { extractEntities, textSimilarity, DUPLICATE_SIMILARITY_THRESHOLD } from './text.ts'
import { toToolOutput } from './tools/output.ts'

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
  | { kind: 'saved'; record: MemoryRecord; warnings?: SaveWarning[] }
  | { kind: 'updated'; record: MemoryRecord; warnings?: SaveWarning[] }
  | { kind: 'duplicate-suspected'; existing: Array<{ id: string; summary: string }> }
  | { kind: 'rejected'; code: RejectCode; reason: string }

/** 保存成功但要提醒模型/用户的事：code 稳定、text 可改。 */
export type SaveWarning = CodedNote<WarningCode>

/**
 * 深度剔除值为 undefined 的键。MemoryRecord 的可选字段（workspacePath/validFrom/
 * validTo/supersedes 等）不填时为 undefined，zod .optional() 会把这些键连值保留，
 * 使记录无法无损 JSON 序列化。dsh 工具输出要求 lossless JSON——save 返回带 undefined
 * 键的记录会被框架以 "value is not lossless JSON" 拒绝。put 前也剔除，保证内存缓存干净。
 * 走工具出口同一套深度剔除（tools/output.ts），单一来源；记录已过 zod 校验、只余 undefined
 * 可选键，toToolOutput 不会抛错，返回值仍是合法 MemoryRecord（去掉可选键仍满足接口）。
 */
function pruneUndefined(record: MemoryRecord): MemoryRecord {
  return toToolOutput(record) as unknown as MemoryRecord
}

export async function runSavePipeline(
  candidate: SaveCandidate,
  deps: {
    store: MemoryStore
    registry: TypeRegistry
    workspacePath: string | undefined
    /** turnStartSeq：触发本次保存的当轮 turn/start 事件 seq（绑定层机械回找），缺省 0（整会话兜底）。 */
    session: { id: string; lastSeq: number; turnStartSeq?: number }
    /** update global 目标前拍快照用（快照先行，对齐 forget 的可恢复性）；缺省则跳过快照，
     *  仅测试场景可缺省，生产接线必须传。 */
    snapshots?: SnapshotStore
  },
): Promise<PipelineResult> {
  const { store, registry, session } = deps
  const now = Date.now()

  // 1. 格式校验
  if (!registry.has(candidate.type)) {
    return { kind: 'rejected', code: 'unknown-type', reason: `未知类型 "${candidate.type}"，可用类型见工具说明` }
  }
  // 模型无 global 直写通道：新建时填 global → 降级 workspace + globalCandidate 标记，
  // 真正提升到 global 只能走 memory_promote（用户确认）。
  let scope = candidate.scope
  let globalCandidate: true | undefined
  const scopeWarnings: SaveWarning[] = []
  let target: MemoryRecord | undefined
  if (candidate.action === 'update') {
    target = candidate.id ? store.get(candidate.id) : undefined
    if (!target || target.status === 'deleted') {
      return { kind: 'rejected', code: 'target-missing', reason: `更新目标不存在或已删除：${candidate.id ?? '(缺 id)'}` }
    }
    // 跨 workspace 改写拦截：workspace 记忆只能在其所属项目里更新（deps.workspacePath 为 undefined
    // 的无 cwd 会话也落此拦截）。global 目标不受限——例行维护全局记忆是设计意图（快照先行兜底）。
    if (target.scope === 'workspace' && target.workspacePath !== deps.workspacePath) {
      return { kind: 'rejected', code: 'cross-workspace', reason: `不能跨项目修改其他 workspace 的记忆：目标属于 ${target.workspacePath ?? '(未知项目)'}，当前会话在 ${deps.workspacePath ?? '(无工作目录)'}。请在该项目的会话里更新。` }
    }
    // scope 不随 update 变更——否则例行内容更新会把用户确认提升过的 global 记忆
    // 静默拉回当前项目（提升闸被写入链绕过）。降级同样没有免确认通道。
    scope = target.scope
    if (candidate.scope === 'global' && target.scope === 'workspace') {
      // 模型对 workspace 记录重申 global 意图：转成提升候选（已是候选则静默幂等）
      if (!target.globalCandidate) {
        globalCandidate = true
        scopeWarnings.push({ code: 'update-global-candidate', text: 'scope 不随更新变更；已将这条记忆标记为全局提升候选，治理时经用户确认后提升' })
      }
    } else if (candidate.scope !== target.scope) {
      scopeWarnings.push({ code: 'update-scope-kept', text: `scope 不随更新变更，记忆保持 ${target.scope}` })
    }
  } else {
    // workspacePath 缺失说明会话连 cwd 都没有（runtime 对有 cwd 的会话总能给出目录兜底桶）：
    // workspace 桶不存在，落 global 又会绕过用户确认闸，两头无路可落，新建一律拒存。
    if (deps.workspacePath === undefined) {
      return { kind: 'rejected', code: 'no-workspace', reason: '当前会话没有工作目录，记忆无处归属：workspace 桶不存在，global 写入必须经用户确认的提升流程。请在有工作目录的会话里保存。' }
    }
    if (candidate.scope === 'global') {
      scope = 'workspace'
      globalCandidate = true
    }
  }

  // 2. confidence 决议：只能下调
  const cap = CONFIDENCE_BY_SOURCE[candidate.sourceMode]
  const confidence = Math.min(candidate.confidence ?? cap, cap)

  // 3. 结构去重（仅 create，force 跳过）：实体重叠与 bigram 相似度级联，非两轴恒开。
  // 实体是强信号；bigram 相似度只定位为实体盲区的兜底（纯中文散文提不出实体，实体轴对它失明）。
  // 两轴恒开会对有实体的记忆产生"同主题不同事实"的误判，故有实体时只走实体轴，实体为空才落 Dice 轴。
  if (candidate.action === 'create' && !candidate.force) {
    const text = `${candidate.content}\n${candidate.summary}`
    const entities = extractEntities(text)
    const peers = store.query({
      types: [candidate.type],
      scope: { kind: 'workspace', path: deps.workspacePath! }, // create 必有 workspace 桶（前置已拒无 cwd）
      status: ['active'],
    })
    const hits = peers.filter(p => {
      const peerText = `${p.content}\n${p.summary}`
      if (entities.length > 0) return extractEntities(peerText).some(e => entities.includes(e))
      return textSimilarity(text, peerText) >= DUPLICATE_SIMILARITY_THRESHOLD
    })
    if (hits.length > 0) {
      return { kind: 'duplicate-suspected', existing: hits.map(h => ({ id: h.id, summary: h.summary })) }
    }
  }

  // 4. 持久化（写入前必须过 schema——KvTable.put 不校验，脏记录会让下次 domain open 整库拒载）
  // 真锚（设计 evidence-anchor §3）：eventRange = [当轮 turn/start, save 时刻]，两个数都是机械事实。
  // 模型上下文里没有 seq 标注，任何模型填的区间都是编造——锚只能由绑定层填。
  const anchorStart = Math.min(session.turnStartSeq ?? 0, session.lastSeq)
  const source = { sessionId: session.id, eventRange: [anchorStart, session.lastSeq] as [number, number], sourceMode: candidate.sourceMode }
  let record: MemoryRecord
  if (candidate.action === 'update') {
    // scope/workspacePath 从 target 原样继承（见上方 scope 决议），不吃当前会话上下文
    record = {
      ...target!,
      name: candidate.name, type: candidate.type, tags: candidate.tags,
      content: candidate.content, summary: candidate.summary,
      source, confidence,
      // 可选字段统一"不传即保留"：update 是内容编辑，不重传 validTo 就清掉时效窗口
      // 会让有时效的记忆变成永不过期
      validFrom: candidate.validFrom ?? target!.validFrom,
      validTo: candidate.validTo ?? target!.validTo,
      updatedAt: now, lastConfirmedAt: now,
      supersedes: candidate.supersedes ?? target!.supersedes,
      globalCandidate: globalCandidate || target!.globalCandidate,
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
      globalCandidate,
    }
  }
  const parsed = memoryRecordSchema.safeParse(record)
  if (!parsed.success) {
    return { kind: 'rejected', code: 'schema-invalid', reason: `字段校验失败：${parsed.error.issues.map(i => i.message).join('；')}` }
  }

  // 5. 写盘前 secret 检查：高危（明确厂商特征）直接拦截、不落盘；疑似仅警告、照常落盘。
  // summary 进注入索引、name 进文件名、tags 进索引行——密钥藏在哪个字段都会外泄，四个面一起查。
  const secretHits = detectSecrets(`${candidate.content}\n${candidate.name}\n${candidate.summary}\n${candidate.tags.join(' ')}`)
  const critical = secretHits.filter(h => h.severity === 'critical')
  if (critical.length > 0) {
    return {
      kind: 'rejected',
      code: 'secret-critical',
      reason: `检测到高危密钥（${critical.map(h => h.name).join('、')}），未保存。密钥不该进记忆（将来可能随同步离开本机）——如需记录，请改写成不含密钥的指针（如「AWS 凭证在 1Password 的 X 条目」）再存。`,
    }
  }

  // 更新 global 记忆前拍快照（快照先行）：forget 有 14 天快照，update 覆盖旧内容却无恢复手段是
  // 不对称的。workspace 目标不拍——高频写入会撑爆快照表，且其内容多为项目内可重建的琐碎更新。
  let updateSnapshotId: string | undefined
  if (candidate.action === 'update' && target!.scope === 'global' && deps.snapshots) {
    const snap = await deps.snapshots.capture(
      { operation: 'pre-update', description: `更新全局记忆 ${target!.id} 前`, records: [target!] },
      now,
    )
    updateSnapshotId = snap.id
  }

  const clean = pruneUndefined(parsed.data)
  await store.put(clean)

  // 6. supersedes 处理：目标必须与本次写入记录同桶——跨桶替代会绕过用户确认闸、无快照、无复活路径。
  // 不同桶的目标跳过不置 superseded，仅给一条警告。目标不存在维持静默跳过。
  let crossBucketSupersede = false
  for (const oldId of candidate.supersedes ?? []) {
    const old = store.get(oldId)
    if (!old || old.id === clean.id) continue
    const sameBucket = old.scope === clean.scope
      && (clean.scope !== 'workspace' || old.workspacePath === clean.workspacePath)
    if (!sameBucket) {
      crossBucketSupersede = true
      continue
    }
    await store.put({ ...old, status: 'superseded', updatedAt: now })
  }

  const baseResult = candidate.action === 'update'
    ? { kind: 'updated' as const, record: clean }
    : { kind: 'saved' as const, record: clean }

  const suspected = secretHits.filter(h => h.severity === 'suspected')
  const warnings: SaveWarning[] = [
    ...scopeWarnings,
    ...(crossBucketSupersede
      ? [{ code: 'cross-bucket-supersede' as const, text: '跨桶替代不允许：supersedes 目标不在本次写入的记忆桶内，已跳过不置 superseded。global 记忆的矛盾走 memory_scan 的冲突裁决，跨层提升合并走 memory_promote' }]
      : []),
    ...(updateSnapshotId
      ? [{ code: 'auto-snapshot' as const, text: `已自动快照（${updateSnapshotId}），14 天内可用 memory_snapshot 恢复` }]
      : []),
    ...(suspected.length > 0
      ? [{ code: 'secret-suspected' as const, text: `疑似密钥（${suspected.map(h => h.name).join('、')}），建议改写后再存——记忆将来可能随同步离开本机` }]
      : []),
  ]
  if (warnings.length > 0) return { ...baseResult, warnings }

  return baseResult
}
