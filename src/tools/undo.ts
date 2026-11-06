import type { MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { AdviceIgnoreStore } from '../governance/advice-ignores.ts'
import { editFingerprint, isConflicting, type SnapshotStore } from '../governance/snapshots.ts'
import { asUndoable, expectedFingerprints, isStillOwnWrite, undoRuleOf, undoStateOf, type UndoableEntry, type UndoRule } from '../governance/undo-rules.ts'
import { verdictLoser, type MemorySnapshot, type SnapshotRecord } from '../governance/schema.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { RecordNotFoundError } from '../errors.ts'
import { scopeAt, type Scope } from '../scope.ts'
import { crossWorkspaceNote, gateRecords, isCopyOf, isVisible, locateCopy, type CrossWorkspaceRejection, type GovernanceContext } from './workspace-gate.ts'

export interface UndoDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  snapshots: SnapshotStore
  /** 撤销「留在本项目」时删掉当时顺带写的放错层忽略。 */
  ignores: Pick<AdviceIgnoreStore, 'unignoreIfSame'>
  /** 每次现读：恢复收尾要判快照是不是途中刚过期被清扫，用开头的时刻判不出来。 */
  now?: () => number
}

/** stale：之后又被改过（六种撤销共用），什么都没动，或停在第三方的版本。真失败（读写出错）直接抛出，由调用方回 failed。 */
export type UndoErrorCode = 'not-found' | 'claimed' | 'cross-workspace' | 'stale' | 'target-taken'
/**
 * 内部子码，只给测试和日志用，不进界面契约。no-entry：条目不在、未结清或已换了裁决；undone：已撤销过；expired：改前快照已过保留窗口；
 * changed：目标之后被改过、删掉或搬走，什么都没动；redacted：目标之后含密钥被物理删除；kept-third-party：合并撤销写了一条之后停下，
 * 那一条已被第三方改过，没有写回，停在第三方的版本。
 */
export type UndoReason = 'no-entry' | 'undone' | 'expired' | 'changed' | 'redacted' | 'kept-third-party'

export type UndoError = { kind: 'error'; code: UndoErrorCode; reason?: UndoReason; rejected?: CrossWorkspaceRejection[]; message: string }
export type UndoResult = { kind: 'undone'; decisionId: string; restored: string[]; snapshotId?: string } | UndoError

/** 最近删除的普通恢复（没有裁决条目覆盖）多一种 failed：快照后被修改过而跳过。 */
export type RestoreDeletedResult =
  | { kind: 'restored'; restored: string[]; snapshotId?: string; decisionId?: string }
  | UndoError
  | { kind: 'error'; code: 'failed'; message: string }

const error = (code: UndoErrorCode, message: string, reason?: UndoReason): UndoError => ({ kind: 'error', code, ...(reason !== undefined ? { reason } : {}), message })
const notFound = (what: string, reason: UndoReason) => error('not-found', `不存在或已处理：${what}`, reason)
const changed = (id: string, reason: UndoReason = 'changed') =>
  error('stale', `记忆 ${id} 在这次操作之后又被改过、删除或搬走，撤销会冲掉之后的改动，${reason === 'kept-third-party' ? '已写回的一条停在之后的版本' : '未做任何改动'}`, reason)
const crossWorkspace = (rejected: CrossWorkspaceRejection[]): UndoError => ({ kind: 'error', code: 'cross-workspace', rejected, message: crossWorkspaceNote(rejected, []) })

const GLOBAL: Scope = { kind: 'global' }

/**
 * 撤销一条已结清的条目：认领 → 过跨项目门 → 预检 → 按种类的机制动手、锁内复核 → 条目去向（见 undoRuleOf）。
 * 机制三种：按改前快照恢复（直接改与合并、模型改写与替代、删一方的裁决、提升为全局）、搬回（移到项目）、放回标记（留在本项目）。
 * 之后被改过的一律回 stale；同一条同时只撤一次，撞上另一次操作回 claimed。
 */
export function executeUndo(args: { decisionId: string; allowCrossWorkspace?: boolean }, context: GovernanceContext, deps: UndoDeps): Promise<UndoResult> {
  return claimAndUndo(args, context, deps)
}

/** isExpected：认领后重读的条目还得是调用方看到的那条（最近删除的恢复：期间被撤销或重新裁决过的不再按旧裁决动手）。 */
async function claimAndUndo(
  args: { decisionId: string; allowCrossWorkspace?: boolean }, context: GovernanceContext, deps: UndoDeps, isExpected?: (entry: UndoableEntry) => boolean,
): Promise<UndoResult> {
  // 两个标签页或两个宿主进程同时撤同一条，或撤销撞上裁决、体检：只让一条执行，另一条什么都不动
  const claimed = await deps.decisions.withClaim(args.decisionId, async () => {
    const found = (await deps.decisions.listSettled()).find(d => d.id === args.decisionId)
    const entry = found === undefined ? undefined : asUndoable(found)
    if (entry === undefined || isExpected?.(entry) === false) return notFound(args.decisionId, 'no-entry')
    if (entry.settled.isUndone === true) return notFound(`${entry.id}（已撤销）`, 'undone')
    const rule = undoRuleOf(entry)
    const allow = args.allowCrossWorkspace
    if (rule.mechanism === 'relocate') return await relocate(entry, rule, allow, context, deps)
    if (rule.mechanism === 'reflag') return await reflag(entry, rule, allow, context, deps)
    return rule.expectedStatus !== undefined ? await restoreOwnWrites(entry, rule, allow, context, deps) : await restoreVerdict(entry, rule, allow, context, deps)
  })
  return claimed.isClaimed ? claimed.value : error('claimed', `待决项 ${args.decisionId} 正在被另一次操作处理，未做任何改动`)
}

/** 撤后条目的去向：回到待处理、移出账本、标已撤销留到保留窗口结束。 */
async function settleUndo(entry: UndoableEntry, rule: UndoRule, deps: UndoDeps, restored: string[]): Promise<UndoResult> {
  if (rule.fate === 'remove') await deps.decisions.remove(entry.id)
  else if (rule.fate === 'mark-undone') await deps.decisions.markUndone(entry.id)
  else await deps.decisions.unsettle(entry.id)
  const { snapshotId } = entry.settled
  return { kind: 'undone', decisionId: entry.id, restored, ...(snapshotId !== undefined ? { snapshotId } : {}) }
}

/** 改前快照：先清一遍过了保留窗口的，过期的就当不在。 */
async function snapshotOf(entry: UndoableEntry, deps: UndoDeps): Promise<MemorySnapshot | undefined> {
  const { snapshotId } = entry.settled
  if (snapshotId === undefined) return undefined
  await deps.snapshots.sweep(deps.now?.() ?? Date.now())
  return deps.snapshots.get(snapshotId)
}

/**
 * 按快照恢复前的跨项目门：快照里的记录与它此刻的现状任一方落在其他项目，就按那个项目判定（写回快照里的位置）。
 * exact 按记录自己的作用域读现状，hint 按它的 workspacePath 提示定位（与写回时的定位一致）。
 */
async function gateRestore(records: readonly SnapshotRecord[], target: 'exact' | 'hint', allow: boolean | undefined, context: GovernanceContext, store: MemoryStore) {
  const seen = await Promise.all(records.map(async (r) => {
    const current = await store.get(r.id, target === 'exact' ? scopeAt(r.workspacePath) : { workspacePath: r.workspacePath })
    return current !== undefined && !isVisible(current, context) ? current : r
  }))
  return gateRecords(seen, context, allow).rejected
}

/**
 * 按指纹判的种类（直接改与合并、模型改写与替代）：主条此刻仍是那次写下的，合并删掉的那条内容仍同快照（在最近删除里或已恢复都行），
 * 才按改前快照恢复。合并不留半截：先写容易被争用的那条（合并删掉的：最近删除里能被恢复、恢复后能被改），再写保留的；
 * 写入那一刻各按锁内现状再核对一次，后一条被跳过时把已写的那条写回预检时的样子——只在它仍是刚写回的那一版时写回，
 * 已被第三方改过就不写回，停在第三方的版本。结果只有三种：全成；全不动；停在第三方的版本。后两种都回 stale、条目留着。
 */
async function restoreOwnWrites(entry: UndoableEntry, rule: UndoRule, allow: boolean | undefined, context: GovernanceContext, deps: UndoDeps): Promise<UndoResult> {
  const snapshot = await snapshotOf(entry, deps)
  const records = snapshot?.data.filter(r => entry.memoryIds.includes(r.id)) ?? []
  const main = records.find(r => r.id === entry.memoryIds[0])
  if (snapshot === undefined || main === undefined) return notFound(`${entry.id} 改前的快照（可能已超过 14 天）`, 'expired')
  // 先过跨项目门：放行一部分就恢复一部分，合并会只回来一半
  const rejected = await gateRestore(records, 'exact', allow, context, deps.store)
  if (rejected.length > 0) return crossWorkspace(rejected)
  if (undoStateOf(entry, main, await locateCopy(deps.store, main.id, scopeAt(main.workspacePath))) !== 'undoable') return changed(main.id)
  // 还在最近删除里的也比内容：软删进去的若是快照之后的版本，恢复会拿快照里的旧内容盖掉它
  const expected = expectedFingerprints(entry, records)
  const others = records.filter(r => r.id !== main.id)
  const prechecked = new Map<string, MemoryRecord | undefined>()
  for (const rec of others) {
    const current = await locateCopy(deps.store, rec.id, scopeAt(rec.workspacePath))
    if (current !== undefined && editFingerprint(current) !== expected.get(rec.id)) return changed(rec.id)
    prechecked.set(rec.id, current)
  }
  const now = deps.now ?? Date.now
  // 写入那一刻锁内看到的现状：补偿退回它，而不是预检读到的那份（其间别处原样恢复、软删的不被冲掉）
  const seen = new Map<string, MemoryRecord | undefined>()
  const isOwn = (rec: SnapshotRecord) => (cur: MemoryRecord | undefined) => {
    seen.set(rec.id, cur)
    if (rec === main) return cur !== undefined && isStillOwnWrite(entry, cur)
    // 定位不到的只在预检时就不在才写：预检之后被搬走、物理删除的不在原处重建
    return cur === undefined ? prechecked.get(rec.id) === undefined : editFingerprint(cur) === expected.get(rec.id)
  }
  const written: SnapshotRecord[] = []
  try {
    for (const rec of [...others, main]) {
      const r = await deps.snapshots.restore(snapshot, [rec.id], deps.store, { target: 'exact', overwrite: isOwn(rec), now })
      if (r.restored.length === 0) {
        const isAnyKept = await withdraw(written, seen, deps.store)
        return changed(rec.id, r.redacted.length > 0 ? 'redacted' : isAnyKept ? 'kept-third-party' : 'changed')
      }
      written.push(rec)
    }
  } catch (err) {
    // 写盘出错同样不留半截：已写回的照样退回，再把错误抛出去
    await withdraw(written, seen, deps.store)
    throw err
  }
  return settleUndo(entry, rule, deps, entry.memoryIds.filter(id => written.some(r => r.id === id)))
}

/**
 * 把已写回的记录退回写入那一刻的样子（那时不在的删掉）。只退仍是刚写回那一版的：恢复写的就是快照里这条
 * （召回统计不算内容），状态与内容指纹都对得上才算；对不上是第三方的版本，留着。返回有没有留下的。
 */
async function withdraw(written: readonly SnapshotRecord[], seen: ReadonlyMap<string, MemoryRecord | undefined>, store: MemoryStore): Promise<boolean> {
  let isAnyKept = false
  for (const rec of written) {
    const fingerprint = editFingerprint(rec)
    const isJustWritten = (cur: MemoryRecord | undefined) => cur !== undefined && cur.status === rec.status && editFingerprint(cur) === fingerprint
    const at = scopeAt(rec.workspacePath)
    const before = seen.get(rec.id)
    const isBack = before === undefined
      ? await store.hardDelete(rec, { at }, cur => !isJustWritten(cur))
      : (await store.put(before, at, cur => !isJustWritten(cur))) !== undefined
    if (!isBack) isAnyKept = true
  }
  return isAnyKept
}

/**
 * 删一方的裁决恢复败方、提升为全局恢复原位，两边都留的只去掉结清。不比指纹，按快照恢复时的冲突判：现状与快照不同就跳过、回 stale。
 * 败方回到它自己的作用域；提升按原位提示写回，顺带清掉全局那一份。
 */
async function restoreVerdict(entry: UndoableEntry, rule: UndoRule, allow: boolean | undefined, context: GovernanceContext, deps: UndoDeps): Promise<UndoResult> {
  const { targets } = rule
  const isPromote = entry.settled.verdict === 'promoted'
  const snapshot = targets.length > 0 ? await snapshotOf(entry, deps) : undefined
  if (targets.length > 0 && entry.settled.snapshotId !== undefined && snapshot === undefined) {
    return notFound(`快照 ${entry.settled.snapshotId}（可能已超过 14 天保留窗口）`, 'expired')
  }
  const target = isPromote ? 'hint' : 'exact'
  const records = snapshot?.data.filter(r => targets.includes(r.id)) ?? []
  const rejected = await gateRestore(records, target, allow, context, deps.store)
  if (rejected.length > 0) return crossWorkspace(rejected)
  // 撤销提升只搬全局那一份，且它得仍在用、内容同快照：之后又搬走、删掉、改过的不动。按提示定位恢复时比的可能是
  // 原项目里同 id 的另一份，顺带清掉的却是全局这份，所以全局这份在这里先比
  if (isPromote) {
    for (const id of targets) {
      const promoted = await locateCopy(deps.store, id, GLOBAL)
      const before = records.find(r => r.id === id)
      if (promoted?.status !== 'active' || before === undefined || isConflicting(promoted, before)) return changed(id)
    }
  }
  let restored: string[] = []
  if (snapshot !== undefined) {
    const r = await deps.snapshots.restore(snapshot, targets, deps.store, { target, overwrite: false, now: deps.now ?? Date.now })
    if (r.skipped.length > 0) return changed(r.skipped[0]!, r.redacted.length > 0 ? 'redacted' : 'changed')
    restored = r.restored
  }
  return settleUndo(entry, rule, deps, restored)
}

/**
 * 撤销移到项目：项目里那份此刻还是移过去时的内容，才把它搬回全局。一次搬家，全局那份回来的同时项目里那份就不在了，
 * 不会只做成一半；之后被改过、删掉、搬走的回 stale，全局又有了这个 id 的回 target-taken，都什么都不动。
 */
async function relocate(entry: UndoableEntry, rule: UndoRule, allow: boolean | undefined, context: GovernanceContext, deps: UndoDeps): Promise<UndoResult> {
  const memoryId = entry.memoryIds[0] ?? ''
  const workspacePath = entry.workspaces?.[0]
  const current = workspacePath === undefined ? undefined : await locateCopy(deps.store, memoryId, { kind: 'workspace', workspacePath })
  const { rejected } = gateRecords(current === undefined ? [] : [current], context, allow)
  if (rejected.length > 0) return crossWorkspace(rejected)
  if (undoStateOf(entry, undefined, current) !== 'undoable') return changed(memoryId)
  if ((await locateCopy(deps.store, memoryId, GLOBAL)) !== undefined) {
    return error('target-taken', `全局已有记忆 ${memoryId}，搬回去会盖掉它，未做任何改动`)
  }
  let isMoved = false
  try {
    await deps.store.update(current!, (cur) => {
      // 锁内按磁盘上的现状再核对一次
      isMoved = isStillOwnWrite(entry, cur)
      if (!isMoved) return cur
      const { workspacePath: _workspacePath, ...rest } = cur
      return { ...rest, scope: 'global' }
    }, scopeAt(workspacePath))
  } catch (err) {
    if (!(err instanceof RecordNotFoundError)) throw err
  }
  if (!isMoved) return changed(memoryId)
  return settleUndo(entry, rule, deps, [memoryId])
}

/**
 * 撤销「留在本项目」：清掉候选标记时没拍快照，把标记放回去，否则条目回到待处理也找不到候选。只认留下的那一层：
 * 不带层定位会挑到别层同 id 的副本，写回时还会清掉其余副本。之后被删掉、搬走的回 stale。
 */
async function reflag(entry: UndoableEntry, rule: UndoRule, allow: boolean | undefined, context: GovernanceContext, deps: UndoDeps): Promise<UndoResult> {
  const memoryId = entry.memoryIds[0] ?? ''
  const workspacePath = entry.workspaces?.[0] ?? context.workspacePath
  const rec = workspacePath === undefined ? undefined : await locateCopy(deps.store, memoryId, { kind: 'workspace', workspacePath })
  const { rejected } = gateRecords(rec === undefined ? [] : [rec], context, allow)
  if (rejected.length > 0) return crossWorkspace(rejected)
  // 同 keep-local：不是内容编辑，updatedAt 不动
  if (rec?.status !== 'active' || !(await deps.store.updateIfLive(rec, r => ({ ...r, globalCandidate: true }), scopeAt(workspacePath)))) return changed(memoryId)
  // 留下时顺带写的放错层忽略：忽略表里还是那一条才删，用户之前自己忽略的、之后重新忽略的都不碰
  const ignored = entry.settled.misplacedIgnore
  if (ignored !== undefined) await deps.ignores.unignoreIfSame('misplaced', [memoryId], { ignoredAt: ignored.ignoredAt, fingerprints: [ignored.fingerprint] })
  return settleUndo(entry, rule, deps, [memoryId])
}

/**
 * 最近删除里的一条恢复。被裁决删掉的、裁决条目的快照覆盖着它：效果等于撤销那次裁决（转 executeUndo，冲突回到待处理、沿用原条目），
 * 认领后重读，期间被撤销或重新裁决过的不再按旧裁决动手。其余按最近一份含它的快照恢复；没有快照覆盖的
 * （不经插件删除的归档文件）恢复归档文件本身。带了作用域时裁决条目与快照都得覆盖那一份，同 id 别的副本的快照不拿来恢复它。
 */
export async function restoreDeleted(
  args: { memoryId: string; scope?: Scope; allowCrossWorkspace?: boolean }, context: GovernanceContext, deps: UndoDeps,
): Promise<RestoreDeletedResult> {
  const { memoryId, scope } = args
  const rec = scope === undefined ? await deps.store.get(memoryId, { workspacePath: context.workspacePath }) : await locateCopy(deps.store, memoryId, scope)
  if (rec?.status !== 'deleted') return notFound(memoryId, 'no-entry')
  const now = deps.now ?? Date.now
  await deps.snapshots.sweep(now())
  const snapshots = await deps.snapshots.list()
  const isCovered = (r: SnapshotRecord) => r.id === memoryId && (scope === undefined || isCopyOf(r, scope))
  const covers = (s: MemorySnapshot | undefined) => s?.data.some(r => isCovered(r) && r.redacted !== true) === true
  const entry = (await deps.decisions.listSettled())
    .filter(d => verdictLoser(d, d.settled!.verdict) === memoryId && covers(snapshots.find(s => s.id === d.settled!.snapshotId))).at(-1)
  if (entry !== undefined) {
    const at = entry.settled!.at
    const r = await claimAndUndo({ decisionId: entry.id, allowCrossWorkspace: args.allowCrossWorkspace }, context, deps,
      current => current.settled.at === at && verdictLoser(current, current.settled.verdict) === memoryId)
    if (r.kind === 'error') return r
    return { kind: 'restored', restored: r.restored, decisionId: r.decisionId, ...(r.snapshotId !== undefined ? { snapshotId: r.snapshotId } : {}) }
  }
  const snapshot = snapshots.find(covers)
  if (snapshot === undefined) {
    // 快照里只剩脱敏副本的是密钥硬删过的：归档里残留的副本也不复活
    if (snapshots.some(s => s.data.some(r => isCovered(r) && r.redacted === true))) {
      return notFound(`${memoryId} 含密钥已物理删除，快照里只剩脱敏副本，不可恢复`, 'redacted')
    }
    const { rejected } = gateRecords([rec], context, args.allowCrossWorkspace)
    if (rejected.length > 0) return crossWorkspace(rejected)
    if (!(await deps.store.restoreArchived(rec, { at: scope, now: now() }))) return notFound(memoryId, 'no-entry')
    return { kind: 'restored', restored: [memoryId] }
  }
  const target = scope !== undefined ? 'exact' : 'hint'
  const rejected = await gateRestore(snapshot.data.filter(r => r.id === memoryId), target, args.allowCrossWorkspace, context, deps.store)
  if (rejected.length > 0) return crossWorkspace(rejected)
  const r = await deps.snapshots.restore(snapshot, [memoryId], deps.store, { target, overwrite: false, now })
  if (r.skipped.length > 0) {
    const why = r.redacted.length > 0 ? '含密钥已物理删除，快照里只剩脱敏副本' : '快照后被修改过'
    return { kind: 'error', code: 'failed', message: `记忆 ${memoryId} ${why}，没有恢复` }
  }
  return { kind: 'restored', restored: r.restored, snapshotId: snapshot.id }
}
