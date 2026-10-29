import type { MemoryRecord, SourceMode } from './record-schema.ts'
import type { CodedNote, RejectCode, WarningCode } from './contract-codes.ts'
import { CONFIDENCE_BY_SOURCE, memoryRecordSchema } from './record-schema.ts'
import type { MemoryStore } from './store.ts'
import type { TypeRegistry } from './type-registry.ts'
import type { PendingDecisionsStore } from './governance/decisions.ts'
import { editFingerprint, type SnapshotStore } from './governance/snapshots.ts'
import { detectSecrets, maskSecretSurface } from './secrets.ts'
import { RecordNotFoundError } from './errors.ts'
import { extractEntities, textSimilarity, DUPLICATE_SIMILARITY_THRESHOLD } from './text.ts'
import { toToolOutput } from './output.ts'
import { VALIDITY_DATE_FORMAT, VALIDITY_FORMAT, formatValidity, parseValidityInput } from './validity.ts'

export interface SaveCandidate {
  action: 'create' | 'update'
  id?: string
  name: string
  type: string
  scope: 'global' | 'workspace'
  content: string
  summary: string
  tags: string[]
  sourceMode: SourceMode
  confidence?: number
  supersedes?: string[]
  /** 本机时间 YYYY-MM-DD HH:mm，或 YYYY-MM-DD（补写入时刻的时分）；落库前换算成毫秒（validity.ts）。 */
  validFrom?: string
  validTo?: string
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
 * 走工具出口同一套深度剔除（output.ts），单一来源；记录已过 zod 校验、只余 undefined
 * 可选键，toToolOutput 不会抛错，返回值仍是合法 MemoryRecord（去掉可选键仍满足接口）。
 */
function pruneUndefined(record: MemoryRecord): MemoryRecord {
  return toToolOutput(record) as unknown as MemoryRecord
}

type ValidityKey = 'validFrom' | 'validTo'

/**
 * 有效期入参换算与校验。传了的照写（只有日期补写入时刻的时分）；只传 validTo（截止时间）时起点沿用 target 的，
 * 没有就记写入时刻（到分钟）；没传的 update 保留 target 值，create 不加。validTo 不晚于现在、不晚于 validFrom 都拒——
 * 后者按生效的两个值比，只在这次传了有效期时查。
 */
function resolveValidity(
  candidate: SaveCandidate,
  target: MemoryRecord | undefined,
  now: number,
): { validFrom?: number; validTo?: number } | { code: RejectCode; reason: string } {
  const given: Partial<Record<ValidityKey, number>> = {}
  for (const key of ['validFrom', 'validTo'] as const) {
    const value: unknown = candidate[key]
    if (value === undefined) continue
    const parsed = parseValidityInput(value, now)
    if (!parsed.ok) {
      const shown = `${key}=${JSON.stringify(value)}`
      return {
        code: parsed.code,
        reason: parsed.code === 'validity-format'
          ? `${shown} 格式不对。有效期写本机时间 "${VALIDITY_FORMAT}"（如 "2026-11-05 18:00"）；用户没说具体时刻就只写日期 "${VALIDITY_DATE_FORMAT}"，时分由插件补成现在。不带秒、不带时区、不写数字。改好后重发。`
          : `${shown} 的日期或时刻不存在，核对后重发。`,
      }
    }
    given[key] = parsed.ms
  }
  if (given.validTo !== undefined && given.validTo <= now) {
    return {
      code: 'validity-past',
      reason: `validTo=${formatValidity(given.validTo)} 不晚于现在（${formatValidity(now)}），存下就已过期。核对用户说的截止时间（年份、上午下午）后重发；截止在当天的，写出具体时刻 "${VALIDITY_FORMAT}"——只写日期会把时分补成现在。`,
    }
  }
  const validFrom = given.validFrom ?? target?.validFrom ?? (given.validTo !== undefined ? new Date(now).setSeconds(0, 0) : undefined)
  const validTo = given.validTo ?? target?.validTo
  const isGiven = given.validFrom !== undefined || given.validTo !== undefined
  if (isGiven && validFrom !== undefined && validTo !== undefined && validTo <= validFrom) {
    const kept = (key: ValidityKey) => given[key] === undefined ? '（原记忆的）' : ''
    return {
      code: 'validity-reversed',
      reason: `validTo=${formatValidity(validTo)}${kept('validTo')} 不晚于 validFrom=${formatValidity(validFrom)}${kept('validFrom')}，有效期为空。核对两个时间后重发。`,
    }
  }
  return { validFrom, validTo }
}

export async function runSavePipeline(
  candidate: SaveCandidate,
  deps: {
    store: MemoryStore
    registry: TypeRegistry
    workspacePath: string | undefined
    /** turnStartSeq：触发本次保存的当轮 turn/start 事件 seq（绑定层机械回找），缺省 0（整会话兜底）。 */
    session: { id: string; lastSeq: number; turnStartSeq?: number }
    /** 改写（update）、替代（supersedes）前拍快照用（快照先行，对齐 forget 的可恢复性）；缺省则跳过快照，
     *  仅测试场景可缺省，生产接线必须传。 */
    snapshots?: SnapshotStore
    /** 改写、替代后记一条已结清的撤销记录（对话卡、右侧栏据此显示与撤销）；要和 snapshots 一起给，缺省不记。 */
    decisions?: PendingDecisionsStore
    /** 这次 memory_save 的工具调用 id，记进撤销记录，对话卡按它认领。 */
    callId?: string
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
    target = candidate.id ? await store.get(candidate.id, { workspacePath: deps.workspacePath }) : undefined
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

  // 有效期：换算成毫秒并校验，不合格的拒存、告诉模型怎么改；两个都没传时取值与以往一致（update 保留原值）
  const validity = resolveValidity(candidate, target, now)
  if ('code' in validity) return { kind: 'rejected', ...validity }

  // 本次要标 superseded 的旧记忆：目标必须与本次写入记录同桶——跨桶替代会绕过用户确认闸、无快照、无复活路径，
  // 不同桶的目标跳过不置 superseded，仅给一条警告（见下方 6）。目标不存在维持静默跳过。
  // 本次写入记录的桶此时已定：update 继承目标，create 落当前项目（global 已降级为候选）。
  const bucket = candidate.action === 'update'
    ? { scope: target!.scope, workspacePath: target!.workspacePath }
    : { scope, workspacePath: scope === 'workspace' ? deps.workspacePath : undefined }
  const sameBucket = (old: MemoryRecord) => old.scope === bucket.scope
    && (bucket.scope !== 'workspace' || old.workspacePath === bucket.workspacePath)
  const supersedeIds = [...new Set(candidate.supersedes ?? [])]
  const replaced: MemoryRecord[] = []
  for (const oldId of supersedeIds) {
    const old = await store.get(oldId, { workspacePath: deps.workspacePath })
    if (old?.status === 'active' && old.id !== target?.id && sameBucket(old)) replaced.push(old)
  }

  // 手改保护：用户手改过的记忆不被模型悄悄覆盖或替代。和结构去重、疑似密钥同一个放行口（force），放在两者之前：
  // 那两处的回复都叫模型带 force 重发，排在后面会把手改保护一并跳过；用户同意改写后带 force 重发，疑似密钥照样落警告。
  // 原因会进模型上下文：当前内容按注入的口径遮明确密钥。跨项目目标在上面已拒，这里只会给出本次可见的内容。
  const handEdited = [...(candidate.action === 'update' && target!.handEdited ? [target!] : []), ...replaced.filter(r => r.handEdited)]
  if (handEdited.length > 0 && !candidate.force) {
    const current = handEdited.map((r) => {
      const masked = maskSecretSurface(r)
      return `记忆 ${r.id}（${masked.name}）用户手改过，当前内容是：\n${masked.content}`
    })
    return {
      kind: 'rejected',
      code: 'hand-edited',
      reason: `${current.join('\n\n')}\n未保存。先在对话里问用户要不要改写，用户同意后带 force: true 重发。`,
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
    const peers = await store.query({
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
  // 证据锚（这条记忆出自会话的哪段事件）：eventRange = [当轮 turn/start, save 时刻]，两个数都是机械事实。
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
      // 会让有时效的记忆变成永不过期（有效期的回退在 resolveValidity 里）
      validFrom: validity.validFrom,
      validTo: validity.validTo,
      updatedAt: now, lastConfirmedAt: now,
      supersedes: candidate.supersedes ?? target!.supersedes,
      globalCandidate: globalCandidate || target!.globalCandidate,
      // 内容由本次会话重写，出处随之对应：清除手编标记（pruneUndefined 剔键）
      handEdited: undefined,
    }
  } else {
    record = {
      id: `mem_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: candidate.name, type: candidate.type, scope,
      workspacePath: scope === 'workspace' ? deps.workspacePath : undefined,
      tags: candidate.tags, content: candidate.content, summary: candidate.summary,
      source, createdAt: now, updatedAt: now, lastConfirmedAt: now,
      lastRecalledAt: null, recallCount: 0,
      validFrom: validity.validFrom, validTo: validity.validTo,
      status: 'active', confidence, supersedes: candidate.supersedes,
      globalCandidate,
    }
  }
  const parsed = memoryRecordSchema.safeParse(record)
  if (!parsed.success) {
    return { kind: 'rejected', code: 'schema-invalid', reason: `字段校验失败：${parsed.error.issues.map(i => i.message).join('；')}` }
  }

  // 5. 写盘前 secret 检查：高危（明确厂商特征）直接拦截、不落盘；疑似拦下待确认，force 放行并保留警告。
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
  const suspected = secretHits.filter(h => h.severity === 'suspected')
  if (suspected.length > 0 && !candidate.force) {
    return {
      kind: 'rejected',
      code: 'secret-suspected',
      reason: `检测到疑似密钥（${suspected.map(h => h.name).join('、')}），未保存。是密钥就改写成不含密钥的指针再存；向用户确认不是密钥后，带 force: true 重发。`,
    }
  }

  // 改写、替代前拍快照（快照先行）：forget 有 14 天快照，update 覆盖旧内容、supersedes 让旧记忆失效却无恢复手段是
  // 不对称的。global、workspace 目标都拍，改写的目标与要替代的旧记忆同拍一份；对话卡与右侧栏的「撤销修改」按它恢复。
  const changed = [...(candidate.action === 'update' ? [target!] : []), ...replaced]
  const snapshot = changed.length > 0 && deps.snapshots
    ? await deps.snapshots.capture({
      operation: 'pre-update',
      description: candidate.action === 'update' ? `更新记忆 ${target!.id} 前` : `替代记忆 ${replaced.map(r => r.id).join('、')} 前`,
      records: changed,
    }, now)
    : undefined
  // 模型自报的警告只对 global 目标给（与以往一致）：项目记忆的快照只供界面撤销，不增加给模型的文字
  const updateSnapshotId = candidate.action === 'update' && target!.scope === 'global' ? snapshot?.id : undefined

  const clean = pruneUndefined(parsed.data)
  // 新 id 不定位（create 排他占名）；update 走 put：锁内定位旧文件，scope 没变就原地覆盖
  if (candidate.action === 'update') await store.put(clean)
  else await store.create(clean)

  // 6. supersedes 处理：同桶目标置 superseded，跨桶的跳过并给警告（见上方 replaced）。
  let crossBucketSupersede = false
  const superseded: MemoryRecord[] = []
  for (const oldId of supersedeIds) {
    const old = await store.get(oldId, { workspacePath: deps.workspacePath })
    if (!old || old.id === clean.id) continue
    if (!sameBucket(old)) {
      crossBucketSupersede = true
      continue
    }
    try {
      await store.update(old, r => ({ ...r, status: 'superseded', updatedAt: now }))
      if (replaced.some(r => r.id === old.id)) superseded.push(old)
    } catch (err) {
      if (!(err instanceof RecordNotFoundError)) throw err   // 读到之后被别处删掉：同目标不存在，静默跳过
    }
  }

  // 7. 撤销记录：改写、替代各记一条已结清的条目，指纹按落盘后的内容（撤销前据此确认之后没被别处改过）
  if (snapshot && deps.decisions) {
    const origin = { sessionId: session.id, callId: deps.callId ?? '' }
    const fingerprintOf = async (r: MemoryRecord) => {
      const written = await store.get(r.id, { workspacePath: r.workspacePath, isExactLayer: true })
      return written === undefined ? '' : editFingerprint(written)
    }
    const workspaceOf = (r: MemoryRecord) => (r.scope === 'global' ? 'global' : r.workspacePath ?? '')
    if (candidate.action === 'update') {
      await deps.decisions.addSettled({
        kind: 'rewrite', memoryIds: [clean.id], summary: clean.name, workspaces: [workspaceOf(clean)], fingerprint: await fingerprintOf(clean), origin,
      }, 'rewritten', now, snapshot.id)
    }
    for (const old of superseded) {
      await deps.decisions.addSettled({
        kind: 'supersede', memoryIds: [old.id], summary: old.name, workspaces: [workspaceOf(old)], fingerprint: await fingerprintOf(old),
        origin: { ...origin, by: clean.id },
      }, 'superseded', now, snapshot.id)
    }
  }

  const baseResult = candidate.action === 'update'
    ? { kind: 'updated' as const, record: clean }
    : { kind: 'saved' as const, record: clean }

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
