import type { MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { AdviceIgnoreStore } from '../governance/advice-ignores.ts'
import { editFingerprint, isConflicting, type SnapshotStore } from '../governance/snapshots.ts'
import { asUndoable, expectedFingerprints, isStillOwnWrite, undoRuleOf, undoStateOf, undoStateOfAll, type TargetCopies, type UndoableEntry, type UndoRule } from '../governance/undo-rules.ts'
import { snapshotIdFor, verdictLoser, type MemorySnapshot, type SnapshotRecord } from '../governance/schema.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { RecordNotFoundError } from '../errors.ts'
import { scopeAt, scopeOfLedger, scopeOfMemory, type Scope } from '../scope.ts'
import { LINK_UNDONE_STEP, indexReceiptUndoneStep, ledgerSteps, linkUndoneStep } from '../governance/op-steps.ts'
import { newWriteOp } from '../storage/table.ts'
import { hasDropped, linksOutside, restoreLinks, withoutLinks, type DroppedLinks } from '../links.ts'
import { receiptsOfEntry, revertChange, settleOpenGroups, withdrawVersion } from './changeset.ts'
import { firstRevertBlock, type ChangeReceipt } from '../governance/changeset.ts'
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
 * 内部子码，只给测试和日志用，不进界面契约。no-entry：条目不在、未结清或已换了裁决；undone：已撤销过；
 * resettled：条目撤销后又重新结清过，已不是调用方看到的那次（改前快照对不上）；expired：改前快照已过保留窗口；
 * changed：目标之后被改过、删掉或搬走，什么都没动；redacted：目标之后含密钥被物理删除；kept-third-party：合并撤销写了一条之后停下，
 * 那一条已被第三方改过，没有写回，停在第三方的版本。
 */
export type UndoReason = 'no-entry' | 'undone' | 'resettled' | 'expired' | 'changed' | 'redacted' | 'kept-third-party'

export type UndoError = { kind: 'error'; code: UndoErrorCode; reason?: UndoReason; rejected?: CrossWorkspaceRejection[]; message: string }
/** skipped：整理索引的撤销里，之后又被改过、没撤的操作数；它们的回执留在条目上。 */
/** droppedLinks：撤销换作用域时，放回原作用域后仍越界、去掉的关联和前提（撤销提升、撤销移到项目时才有，没去掉的不列）。 */
export type UndoResult = { kind: 'undone'; decisionId: string; restored: string[]; snapshotId?: string; skipped?: number; droppedLinks?: Array<{ id: string } & DroppedLinks> } | UndoError

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
 * 机制三种：按改前快照恢复（直接改与合并、整理所选的应用、模型改写与替代、删一方的裁决、提升为全局）、搬回（移到项目）、放回标记（留在本项目）。
 * 之后被改过的一律回 stale；同一条同时只撤一次，撞上另一次操作回 claimed。
 */
export function executeUndo(args: UndoArgs, context: GovernanceContext, deps: UndoDeps): Promise<UndoResult> {
  return claimAndUndo(args, context, deps)
}

/** snapshotId：调用方看到的那次结清的改前快照，给了就在认领后核对，对不上（期间撤销后又重新裁决过）回 stale、什么都不动。 */
type UndoArgs = { decisionId: string; snapshotId?: string; allowCrossWorkspace?: boolean }

/** isExpected：认领后重读的条目还得是调用方看到的那条（最近删除的恢复：期间被撤销或重新裁决过的不再按旧裁决动手）。 */
async function claimAndUndo(
  args: UndoArgs, context: GovernanceContext, deps: UndoDeps, isExpected?: (entry: UndoableEntry) => boolean,
): Promise<UndoResult> {
  // 两个标签页或两个宿主进程同时撤同一条，或撤销撞上裁决、体检：只让一条执行，另一条什么都不动
  const claimed = await deps.decisions.withClaim(args.decisionId, async () => {
    const found = (await deps.decisions.listSettled()).find(d => d.id === args.decisionId)
    const entry = found === undefined ? undefined : asUndoable(found)
    if (entry === undefined || isExpected?.(entry) === false) return notFound(args.decisionId, 'no-entry')
    if (entry.settled.isUndone === true) return notFound(`${entry.id}（已撤销）`, 'undone')
    if (args.snapshotId !== undefined && entry.settled.snapshotId !== args.snapshotId) {
      return error('stale', `待决项 ${entry.id} 在你看到之后撤销过、又重新处理了，未做任何改动`, 'resettled')
    }
    const rule = undoRuleOf(entry)
    if (rule.mechanism === 'undo-index') return await undoIndexRun(entry, deps)
    const allow = args.allowCrossWorkspace
    if (rule.mechanism === 'unlink') return await unlink(entry, allow, context, deps)
    if (rule.mechanism === 'revert-changes') return await revertChanges(entry, rule, allow, context, deps)
    if (rule.mechanism === 'relocate') return await relocate(entry, rule, allow, context, deps)
    if (rule.mechanism === 'reflag') return await reflag(entry, rule, allow, context, deps)
    return rule.expectedStatus !== undefined || rule.receipts !== undefined
      ? await restoreOwnWrites(entry, rule, allow, context, deps)
      : await restoreVerdict(entry, rule, allow, context, deps)
  })
  return claimed.isClaimed ? claimed.value : error('claimed', `待决项 ${args.decisionId} 正在被另一次操作处理，未做任何改动`)
}

/**
 * 撤销一次整理索引：按回执从后往前，每个操作各撤一次。撤得了的拿掉回执；效果已经不在的（主题之后又被改过）跳过、回执留着。
 * 全部撤掉就移出账本；一个都撤不了回 stale；撤了一部分照样算撤销成功，带上跳过的个数。索引不属于哪条记忆，不过跨项目门。
 */
async function undoIndexRun(entry: UndoableEntry, deps: UndoDeps): Promise<UndoResult> {
  const label = entry.workspaces?.[0]
  const all = entry.indexRun?.receipts ?? []
  // 上一次已经全部撤完、只差把条目移出账本：这次补上
  if (label !== undefined && entry.indexRun !== undefined && all.length === 0) {
    await deps.decisions.remove(entry.id)
    return { kind: 'undone', decisionId: entry.id, restored: [] }
  }
  const receipts = all.filter(r => r.isConfirmed === true)
  if (label === undefined || receipts.length === 0) return notFound(entry.id, 'no-entry')
  const scope = scopeOfLedger(label)
  let skipped = 0
  for (const receipt of [...receipts].reverse()) {
    const r = await deps.store.undoIndexPlan(scope, receipt.plan, { steps: () => [indexReceiptUndoneStep(entry.id, receipt.op)] })
    if (r.kind === 'stale') skipped++
  }
  if (skipped === receipts.length) return error('stale', '这次整理动过的主题之后又被改过，撤销会冲掉之后的改动，未做任何改动', 'changed')
  // 还没确认的回执（操作提交了、等着补做确认）这次没撤：算在没撤的个数里，记录留着
  skipped += all.length - receipts.length
  if (skipped === 0) await deps.decisions.remove(entry.id)
  // 入口投影（MEMORY.md）跟着索引重新生成
  await deps.store.maintain(scope)
  return { kind: 'undone', decisionId: entry.id, restored: [], ...(skipped > 0 ? { skipped } : {}) }
}

/**
 * 按变更集应用的条目：按回执逆序逐个还原（只把那次改的字段改回去，期间别处改的档位、锁、关联留着）。先整批推演一遍，
 * 有一条撤不了就整批不动；动手时每条在自己的写入段里再核对一次，中途被别处抢先改了就停在那里，撤掉的回执已拿掉、剩下的留着可再撤。
 */
async function revertChanges(entry: UndoableEntry, rule: UndoRule, allow: boolean | undefined, context: GovernanceContext, deps: UndoDeps): Promise<UndoResult> {
  // 中断留下的半个组先撤掉：它的几步本来就不该留着，撤完再按剩下的回执算
  let receipts = entry.changes ?? []
  if ((entry.openGroups?.length ?? 0) > 0) {
    await settleOpenGroups(deps, { by: 'undo', own: entry.id })
    receipts = await receiptsOfEntry(deps.decisions, entry.id)
  }
  // 上一次已经全部撤完、只差条目的去向：这次补上
  if (receipts.length === 0) return settleUndo(entry, rule, deps, [])
  await deps.snapshots.sweep(deps.now?.() ?? Date.now())
  const keyOf = (r: ChangeReceipt) => JSON.stringify([r.scopeKey, r.memoryId])
  const currents = new Map<string, MemoryRecord | undefined>()
  const befores = new Map<string, MemoryRecord | undefined>()
  for (const receipt of receipts) {
    if (!currents.has(keyOf(receipt))) {
      currents.set(keyOf(receipt), await locateCopy(deps.store, receipt.memoryId, scopeOfLedger(receipt.scopeKey)))
    }
    const snapshot = receipt.snapshotId === undefined ? undefined : await deps.snapshots.get(receipt.snapshotId)
    befores.set(receipt.op, snapshot?.data.find(r => r.id === receipt.memoryId && r.redacted !== true))
  }
  const rejected = gateRecords([...currents.values()].filter(r => r !== undefined), context, allow).rejected
  if (rejected.length > 0) return crossWorkspace(rejected)
  const blocked = firstRevertBlock(receipts, r => currents.get(keyOf(r)), r => befores.get(r.op))
  if (blocked !== undefined) {
    return blocked.block === 'expired' ? notFound(`${entry.id} 改前的快照（可能已超过 14 天）`, 'expired') : changed(blocked.receipt.memoryId)
  }
  const restored: string[] = []
  for (const receipt of [...receipts].reverse()) {
    const r = await revertChange(entry.id, receipt, {}, deps)
    if (r.kind !== 'reverted') return changed(receipt.memoryId, restored.length > 0 ? 'kept-third-party' : 'changed')
    // 这一条已经还原、回执也拿掉了，只是收尾出了错：照实报出去，剩下的回执留着，修好后再撤
    if (r.error !== undefined) throw r.error
    if (!restored.includes(receipt.memoryId)) restored.push(receipt.memoryId)
  }
  return settleUndo(entry, rule, deps, restored)
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
 * 按指纹判的种类（直接改与合并、整理所选的应用、模型改写与替代）：主条此刻仍是那次写下的，合并删掉的那条内容仍同快照
 * （在最近删除里或已恢复都行），才按改前快照恢复；整理所选的每一项都按回执比（删掉的那条单独恢复过也算对不上），一项不符整批不动，
 * 快照缺任一项就撤不了。不留半截：先写容易被争用的（合并、整理里删掉的：最近删除里能被恢复、恢复后能被改），再写其余的；
 * 写入那一刻各按锁内现状再核对一次，后一条被跳过时把已写的那几条写回预检时的样子——只在它仍是刚写回的那一版时写回，
 * 已被第三方改过就不写回，停在第三方的版本。结果只有三种：全成；全不动；停在第三方的版本。后两种都回 stale、条目留着。
 */
async function restoreOwnWrites(entry: UndoableEntry, rule: UndoRule, allow: boolean | undefined, context: GovernanceContext, deps: UndoDeps): Promise<UndoResult> {
  const snapshot = await snapshotOf(entry, deps)
  const records = snapshot?.data.filter(r => rule.targets.includes(r.id)) ?? []
  const main = records.find(r => r.id === rule.targets[0])
  // 每个目标的两份：改前快照里的，和它此刻在快照里那个作用域的现状
  const copies = new Map<string, TargetCopies>()
  for (const id of rule.targets) {
    const before = records.find(r => r.id === id)
    copies.set(id, { before, current: before === undefined ? undefined : await locateCopy(deps.store, id, scopeAt(before.workspacePath)) })
  }
  const state = undoStateOfAll(entry, copies)
  if (snapshot === undefined || main === undefined || state === 'expired') return notFound(`${entry.id} 改前的快照（可能已超过 14 天）`, 'expired')
  // 先过跨项目门：放行一部分就恢复一部分，合并会只回来一半
  const rejected = await gateRestore(records, 'exact', allow, context, deps.store)
  if (rejected.length > 0) return crossWorkspace(rejected)
  if (state !== 'undoable') {
    const first = rule.targets.find(id => undoStateOf(entry, copies.get(id)?.before, copies.get(id)?.current) !== 'undoable')
    return changed(first ?? main.id)
  }
  // 还在最近删除里的也比内容：软删进去的若是快照之后的版本，恢复会拿快照里的旧内容盖掉它
  const expected = expectedFingerprints(entry, records)
  const isByReceipt = rule.receipts !== undefined
  const others = records.filter(r => r.id !== main.id)
  for (const rec of others) {
    const current = copies.get(rec.id)?.current
    if (current !== undefined && editFingerprint(current) !== expected.get(rec.id)) return changed(rec.id)
  }
  const now = deps.now ?? Date.now
  // 写入那一刻锁内看到的现状：补偿退回它，而不是预检读到的那份（其间别处原样恢复、软删的不被冲掉）
  const seen = new Map<string, MemoryRecord | undefined>()
  const isOwn = (rec: SnapshotRecord) => (cur: MemoryRecord | undefined) => {
    seen.set(rec.id, cur)
    if (rec === main || isByReceipt) return cur !== undefined && isStillOwnWrite(entry, cur)
    // 定位不到的只在预检时就不在才写：预检之后被搬走、物理删除的不在原处重建
    return cur === undefined ? copies.get(rec.id)?.current === undefined : editFingerprint(cur) === expected.get(rec.id)
  }
  // 整理所选：删掉的那几条先写（在最近删除里，最容易被单独恢复），再写改写的；其余按「合并删掉的在前、保留的在后」
  const isDeleted = (rec: SnapshotRecord) => rule.receipts?.find(r => r.memoryId === rec.id)?.expectedStatus === 'deleted'
  const order = isByReceipt ? [...records.filter(isDeleted), ...records.filter(r => !isDeleted(r))] : [...others, main]
  const written: SnapshotRecord[] = []
  let inFlight: SnapshotRecord | undefined
  let putVersionBack = async () => {}
  try {
    for (const rec of order) {
      inFlight = rec
      // 主条的历史版本和记忆文件在同一个写入段里动：别的写入插不进两步中间
      const r = await deps.store.writeSection(async () => {
        if (rec === main) putVersionBack = await withdrawVersion(deps.store, rec, snapshot.id)
        const restored = await deps.snapshots.restore(snapshot, [rec.id], deps.store, { target: 'exact', overwrite: isOwn(rec), now })
        // 没恢复成：版本在同一段里放回去，别的写入看不到缺了它的那一刻
        if (rec === main && restored.restored.length === 0) {
          await putVersionBack()
          putVersionBack = async () => {}
        }
        return restored
      })
      if (r.restored.length === 0) {
        const isAnyKept = await withdraw(written, seen, deps.store)
        return changed(rec.id, r.redacted.length > 0 ? 'redacted' : isAnyKept ? 'kept-third-party' : 'changed')
      }
      written.push(rec)
      inFlight = undefined
    }
  } catch (err) {
    // 写盘出错同样不留半截：已写回的照样退回，再把错误抛出去。出错的那一项可能已写回、之后才抛（维护目录、写统计），
    // 一并交给 withdraw：它只退仍是刚写回那一版的，没写成的原样不动
    // 放回版本自己出错不盖掉原来的错
    await putVersionBack().catch(() => {})
    await withdraw(inFlight === undefined ? written : [...written, inFlight], seen, deps.store)
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
  let failure: unknown
  for (const rec of written) {
    const fingerprint = editFingerprint(rec)
    const isJustWritten = (cur: MemoryRecord | undefined) => cur !== undefined && cur.status === rec.status && editFingerprint(cur) === fingerprint
    const at = scopeAt(rec.workspacePath)
    const before = seen.get(rec.id)
    // 一项退回出错不中断其余：都退完再把第一个错误抛出去
    try {
      const isBack = before === undefined
        ? await store.hardDelete(rec, { at }, cur => !isJustWritten(cur))
        : (await store.put(before, at, cur => !isJustWritten(cur))) !== undefined
      if (!isBack) isAnyKept = true
    } catch (err) {
      failure ??= err
    }
  }
  if (failure !== undefined) throw failure
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
  const records = snapshot?.data.filter(r => targets.includes(r.id)) ?? []
  // 过期与否按撤销规则 undoStateOf 判：快照里没有可恢复的那份就撤不了
  if (undoStateOf(entry, records[0], undefined) === 'expired') {
    return notFound(entry.settled.snapshotId === undefined
      ? '可恢复的快照（裁决时败方已不在用，没有拍快照）'
      : snapshot === undefined
        ? `快照 ${entry.settled.snapshotId}（可能已超过 14 天保留窗口）`
        : `快照 ${entry.settled.snapshotId} 里的这条记忆（已被彻底删除）`, 'expired')
  }
  const target = isPromote ? 'hint' : 'exact'
  const rejected = await gateRestore(records, target, allow, context, deps.store)
  if (rejected.length > 0) return crossWorkspace(rejected)
  // 撤销提升只搬全局那一份，且它得仍在用、内容同快照：之后又搬走、删掉、改过的不动。按提示定位恢复时比的可能是
  // 原项目里同 id 的另一份，顺带清掉的却是全局这份，所以全局这份在这里先比
  // 提升时越界去掉的关联和前提：全局那份按「快照去掉这些」比，快照恢复时它们随作用域一起回来
  const dropped = entry.settled.droppedLinks
  const asPromoted = (r: SnapshotRecord): SnapshotRecord => (isPromote && dropped !== undefined ? withoutLinks(r, dropped) : r)
  if (isPromote) {
    for (const id of targets) {
      const promoted = await locateCopy(deps.store, id, GLOBAL)
      const before = records.find(r => r.id === id)
      if (promoted?.status !== 'active' || before === undefined || isConflicting(promoted, asPromoted(before))) return changed(id)
    }
  }
  let restored: string[] = []
  const stillOutside: Array<{ id: string } & DroppedLinks> = []
  if (snapshot !== undefined) {
    // 撤销提升：上面的核对在锁外，写回那一刻再按锁内现状核一次，核对之后才被删掉、改过的不复活
    const overwrite = isPromote
      ? (cur: MemoryRecord | undefined) => cur?.status === 'active' && records.some(r => r.id === cur.id && !isConflicting(cur, asPromoted(r)))
      : false
    const r = await deps.store.writeSection(async () => {
      // 撤销提升：快照里的关联和前提随作用域回到原项目，按原项目重验一次。期间被指向的记忆搬去了别的项目，这条就够不着了，去掉并列出
      const back = isPromote ? { ...snapshot, data: await Promise.all(snapshot.data.map(async (rec) => {
        const home = targets.includes(rec.id) ? scopeOfMemory(rec) : undefined
        if (home === undefined) return rec
        const outside = await linksOutside(deps.store, rec, home)
        if (!hasDropped(outside)) return rec
        stillOutside.push({ id: rec.id, ...outside })
        return withoutLinks(rec, outside)
      })) } : snapshot
      return deps.snapshots.restore(back, targets, deps.store, { target, overwrite, now: deps.now ?? Date.now })
    })
    if (r.skipped.length > 0) return changed(r.skipped[0]!, r.redacted.length > 0 ? 'redacted' : 'changed')
    restored = r.restored
  }
  const result = await settleUndo(entry, rule, deps, restored)
  return result.kind === 'undone' && stillOutside.length > 0 ? { ...result, droppedLinks: stillOutside } : result
}

/**
 * 撤销一次只挂关联、前提的保存：按增量撤，它加的 id 现在还在的去掉，期间别处追加的、改的别的字段都留着，修改时间不动。
 * 记忆不在用了（期间被软删、取代）或换了作用域的不撤；它加的一个都不在了（已被别处去掉）回 stale。都什么都不动。
 * 去掉链接的写入带一步「回执标成已撤销」：写完断掉的，下次进写入段补上；进段后回执已结清（上一次其实撤成了）就不再动文件。
 */
async function unlink(entry: UndoableEntry, allow: boolean | undefined, context: GovernanceContext, deps: UndoDeps): Promise<UndoResult> {
  const memoryId = entry.memoryIds[0] ?? ''
  const label = entry.workspaces?.[0]
  const added = entry.links
  if (label === undefined || added === undefined) return notFound(entry.id, 'no-entry')
  const scope = scopeOfLedger(label)
  const current = await locateCopy(deps.store, memoryId, scope)
  const { rejected } = gateRecords(current === undefined ? [] : [current], context, allow)
  if (rejected.length > 0) return crossWorkspace(rejected)
  const stillThere = (r: MemoryRecord) => (r.related ?? []).some(id => added.related.includes(id)) || (r.premises ?? []).some(p => added.premises.includes(p.id))
  if (!deps.store.hasStep(LINK_UNDONE_STEP)) deps.store.registerSteps(ledgerSteps(deps.decisions))
  const outcome = await deps.store.writeSection(async (): Promise<'removed' | 'changed' | 'already-undone'> => {
    // 进写入段时补做过被打断的撤销：回执已经结清，说明上一次去掉链接那步其实做成了
    const fresh = (await deps.decisions.listSettled()).find(d => d.id === entry.id)
    if (fresh?.settled?.isUndone === true) return 'already-undone'
    const op = newWriteOp({ steps: [linkUndoneStep(entry.id)] })
    try {
      const written = await deps.store.update({ id: memoryId }, (cur) => {
        // 锁内按磁盘上的现状再判一次；不撤就抛出、不写（同 updateIfLive）
        if (cur.status !== 'active' || !stillThere(cur)) throw new RecordNotFoundError(cur.id)
        return withoutLinks(cur, added)
      }, scope, op)
      await deps.store.finishOp(op, written)
      return 'removed'
    } catch (err) {
      if (!(err instanceof RecordNotFoundError)) throw err
      return 'changed'
    }
  })
  if (outcome === 'already-undone') return notFound(`${entry.id}（已撤销）`, 'undone')
  if (outcome === 'changed') return changed(memoryId)
  // 回执已由写入提交后的那一步结清，这里不再结第二次
  const { snapshotId } = entry.settled
  return { kind: 'undone', decisionId: entry.id, restored: [memoryId], ...(snapshotId !== undefined ? { snapshotId } : {}) }
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
  let dropped: DroppedLinks = { related: [], premises: [] }
  // 移过去时去掉的关联和前提从改前快照放回去（快照过期了就放不回，照原样搬回）
  const droppedAtMove = entry.settled.droppedLinks
  const before = droppedAtMove === undefined ? undefined : (await snapshotOf(entry, deps))?.data.find(r => r.id === memoryId)
  const withBack = (r: MemoryRecord): MemoryRecord => (before !== undefined && droppedAtMove !== undefined ? restoreLinks(r, before, droppedAtMove) : r)
  try {
    // 搬回全局前在写入段里按全局重验关联和前提（含放回来的）：越界的（指向项目记忆的）去掉
    await deps.store.writeSection(async () => {
      dropped = await linksOutside(deps.store, withBack(current!), GLOBAL)
      await deps.store.update(current!, (cur) => {
        // 锁内按磁盘上的现状再核对一次
        isMoved = isStillOwnWrite(entry, cur)
        if (!isMoved) return cur
        const { workspacePath: _workspacePath, ...rest } = withoutLinks(withBack(cur), dropped)
        return { ...rest, scope: 'global' }
      }, scopeAt(workspacePath))
    })
  } catch (err) {
    if (!(err instanceof RecordNotFoundError)) throw err
  }
  if (!isMoved) return changed(memoryId)
  const result = await settleUndo(entry, rule, deps, [memoryId])
  return result.kind === 'undone' && hasDropped(dropped) ? { ...result, droppedLinks: [{ id: memoryId, ...dropped }] } : result
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
 * 融合时并入删掉的那条从最近删除恢复（用户 2026-11-11 定）：只恢复这一条，保留方的融合稿不退回；这次融合不能再整条撤销，条目清掉，
 * 两条仍然矛盾的下次体检重新报。认领条目后重读，期间被撤销、彻底删除过的不再动手；只写回此刻仍在最近删除里的那份。
 */
async function restoreMergedLoser(
  seen: { decisionId: string; at: number; memoryId: string }, snapshot: MemorySnapshot, allow: boolean | undefined, context: GovernanceContext, deps: UndoDeps,
): Promise<RestoreDeletedResult> {
  const { decisionId, at, memoryId } = seen
  const claimed = await deps.decisions.withClaim(decisionId, async (): Promise<RestoreDeletedResult> => {
    const current = (await deps.decisions.listSettled()).find(d => d.id === decisionId)
    if (current?.settled?.at !== at || current.settled.verdict !== 'plan-applied' || verdictLoser(current, 'plan-applied') !== memoryId) {
      return notFound(decisionId, 'no-entry')
    }
    const rejected = await gateRestore(snapshot.data.filter(r => r.id === memoryId), 'exact', allow, context, deps.store)
    if (rejected.length > 0) return crossWorkspace(rejected)
    const r = await deps.snapshots.restore(snapshot, [memoryId], deps.store, { target: 'exact', overwrite: cur => cur?.status === 'deleted', now: deps.now ?? Date.now })
    if (r.restored.length === 0) return changed(memoryId, r.redacted.length > 0 ? 'redacted' : 'changed')
    await deps.decisions.remove(decisionId)
    return { kind: 'restored', restored: r.restored, snapshotId: snapshot.id }
  })
  return claimed.isClaimed ? claimed.value : error('claimed', `待决项 ${decisionId} 正在被另一次操作处理，未做任何改动`)
}

/**
 * 最近删除里的一条恢复。被裁决删掉的、裁决条目的快照覆盖着它：效果等于撤销那次裁决（转 executeUndo，冲突回到待处理、沿用原条目），
 * 认领后重读，期间被撤销或重新裁决过的不再按旧裁决动手；融合时并入删掉的只恢复它自己（见 restoreMergedLoser）。其余按最近一份含它的快照恢复；没有快照覆盖的
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
    .filter(d => verdictLoser(d, d.settled!.verdict) === memoryId && covers(snapshots.find(s => s.id === snapshotIdFor(d, memoryId)))).at(-1)
  if (entry !== undefined) {
    const at = entry.settled!.at
    if (entry.settled!.verdict === 'plan-applied') {
      return restoreMergedLoser({ decisionId: entry.id, at, memoryId }, snapshots.find(s => s.id === snapshotIdFor(entry, memoryId))!, args.allowCrossWorkspace, context, deps)
    }
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

export { withdrawVersion }
