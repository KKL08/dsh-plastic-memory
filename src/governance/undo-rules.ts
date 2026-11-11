import type { MemoryRecord } from '../record-schema.ts'
import { MODEL_CHANGE_KINDS } from '../contract-codes.ts'
import { RETENTION_MS } from '../retention.ts'
import { kindOf, verdictLoser, type BatchReceipt, type PendingDecision, type PendingKind } from './schema.ts'
import { editFingerprint } from './snapshots.ts'

// 撤销的判据只有这一份：视图显示能不能撤、撤销命令动手前核对、账本清理过期条目，都问这里。

type SettledDecision = PendingDecision & { settled: NonNullable<PendingDecision['settled']> }

/** 可撤销的条目：已结清的账本条目，种类已按 kindOf 补齐（旧条目缺省为冲突）。未决的条目谈不上撤销。 */
export type UndoableEntry = SettledDecision & { kind: PendingKind }

export function asUndoable(entry: PendingDecision): UndoableEntry | undefined {
  return entry.settled === undefined ? undefined : { ...entry, settled: entry.settled, kind: kindOf(entry) }
}

/** 模型用 memory_save 改写、替代已有记忆留的撤销记录。 */
export function isModelChange(entry: { kind?: PendingKind }): boolean {
  return (MODEL_CHANGE_KINDS as readonly PendingKind[]).includes(kindOf(entry))
}

/** 撤销的机制：按改前快照恢复、把记忆搬回原作用域、放回清掉的标记。 */
export type UndoMechanism = 'restore-snapshot' | 'relocate' | 'reflag'
/** 撤后条目的去向：回到待处理、移出账本、标已撤销留到保留窗口结束。 */
export type UndoFate = 'reopen' | 'remove' | 'mark-undone'

export interface UndoRule {
  /** 撤销要动的记忆。 */
  targets: string[]
  /** 按指纹判的种类：目标此刻应有的状态；缺省的种类不比指纹，按快照恢复时的冲突判。 */
  expectedStatus?: MemoryRecord['status']
  /** 按回执逐项判的种类（整理所选）：每个目标按自己那条回执比状态和指纹，不看 expectedStatus 和条目的 fingerprint。 */
  receipts?: readonly BatchReceipt[]
  mechanism: UndoMechanism
  fate: UndoFate
}

/**
 * 按种类的表。删一方的裁决恢复败方、提升为全局恢复原位，回到待处理；就地处理时才记的（isBornSettled）移出账本，回到没点过的样子。
 * 冲突按处理方案落盘的（plan-applied，结清信息里带回执）按回执逐项恢复，回到待处理。
 * 留在本项目没拍快照，放回候选标记。直接改与合并、整理所选的应用、移到项目撤后移出账本；模型改写与替代撤后标已撤销。
 */
export function undoRuleOf(entry: UndoableEntry): UndoRule {
  const { verdict, isBornSettled } = entry.settled
  switch (entry.kind) {
    case 'edit': {
      if (verdict !== 'batch-edited') return { targets: entry.memoryIds, expectedStatus: 'active', mechanism: 'restore-snapshot', fate: 'remove' }
      const receipts = entry.receipts ?? []
      return { targets: receipts.map(r => r.memoryId), mechanism: 'restore-snapshot', fate: 'remove', receipts }
    }
    case 'move': return { targets: entry.memoryIds, expectedStatus: 'active', mechanism: 'relocate', fate: 'remove' }
    case 'rewrite': return { targets: entry.memoryIds, expectedStatus: 'active', mechanism: 'restore-snapshot', fate: 'mark-undone' }
    case 'supersede': return { targets: entry.memoryIds, expectedStatus: 'superseded', mechanism: 'restore-snapshot', fate: 'mark-undone' }
    default: {
      // 冲突按处理方案落盘（plan-applied）：按回执逐项恢复，不只恢复败方
      const { receipts } = entry.settled
      if (receipts !== undefined) return { targets: receipts.map(r => r.memoryId), mechanism: 'restore-snapshot', fate: isBornSettled === true ? 'remove' : 'reopen', receipts }
      const loser = verdictLoser(entry, verdict)
      const targets = loser !== undefined ? [loser] : entry.kind === 'promote-candidate' ? entry.memoryIds : []
      return { targets, mechanism: verdict === 'keep-local' ? 'reflag' : 'restore-snapshot', fate: isBornSettled === true ? 'remove' : 'reopen' }
    }
  }
}

/**
 * 这条记忆此刻还是那次写下的：状态是种类期望的状态，内容指纹对得上（editFingerprint）。有回执的种类按它自己那条回执比，
 * 回执里没有它就不算。不按指纹判的种类一律不算。
 */
export function isStillOwnWrite(entry: UndoableEntry, current: MemoryRecord | undefined): boolean {
  const { expectedStatus, receipts } = undoRuleOf(entry)
  if (current === undefined) return false
  if (receipts !== undefined) {
    const receipt = receipts.find(r => r.memoryId === current.id)
    return receipt !== undefined && current.status === receipt.expectedStatus && editFingerprint(current) === receipt.fingerprint
  }
  return expectedStatus !== undefined && current.status === expectedStatus
    && entry.fingerprint !== undefined && editFingerprint(current) === entry.fingerprint
}

/** 每个目标期望的指纹：有回执的按回执；否则主条（memoryIds[0]）是那次写下的，其余（合并删掉的那条）是改前快照里的。 */
export function expectedFingerprints(entry: UndoableEntry, snapshotted: readonly MemoryRecord[]): Map<string, string> {
  const { receipts } = undoRuleOf(entry)
  if (receipts !== undefined) return new Map(receipts.map(r => [r.memoryId, r.fingerprint]))
  const expected = new Map<string, string>()
  for (const id of entry.memoryIds) {
    const before = snapshotted.find(r => r.id === id)
    const fingerprint = id === entry.memoryIds[0] ? entry.fingerprint : before && editFingerprint(before)
    if (fingerprint !== undefined) expected.set(id, fingerprint)
  }
  return expected
}

export type UndoState = 'undoable' | 'changed' | 'undone' | 'expired'

/**
 * 此刻能不能撤。before 是改前快照里目标那一份（快照已清为 undefined），current 是目标在它自己作用域里的现状
 * （精确那一份，别的作用域里同 id 的副本不算；哪都没有为 undefined）。已撤销的是 undone；靠快照恢复而快照已清的是 expired；
 * 按指纹判的种类此刻不是那次写下的就是 changed。删一方、提升为全局的冲突在恢复时按快照判，这里不比。
 */
export function undoStateOf(entry: UndoableEntry, before: MemoryRecord | undefined, current: MemoryRecord | undefined): UndoState {
  if (entry.settled.isUndone === true) return 'undone'
  const rule = undoRuleOf(entry)
  if (rule.mechanism === 'restore-snapshot' && rule.targets.length > 0 && before === undefined) return 'expired'
  if (rule.expectedStatus === undefined && rule.receipts === undefined) return 'undoable'
  return isStillOwnWrite(entry, current) ? 'undoable' : 'changed'
}

/** 一个撤销目标的两份：改前快照里的（快照已清或缺这一项为 undefined）、此刻在它自己作用域里的（哪都没有为 undefined）。 */
export interface TargetCopies { before: MemoryRecord | undefined; current: MemoryRecord | undefined }

/**
 * 整条此刻能不能撤：有回执的（整理所选）每个目标逐项问 undoStateOf，任一项快照缺了是 expired，任一项不是那次写下的是 changed；
 * 没有回执的只问主条（第一个目标），同 undoStateOf。copies 里没有的目标按两份都没有算。
 */
export function undoStateOfAll(entry: UndoableEntry, copies: ReadonlyMap<string, TargetCopies>): UndoState {
  const rule = undoRuleOf(entry)
  const examined = rule.receipts !== undefined ? rule.targets : rule.targets.slice(0, 1)
  if (examined.length === 0) return undoStateOf(entry, undefined, undefined)
  const states = examined.map(id => undoStateOf(entry, copies.get(id)?.before, copies.get(id)?.current))
  for (const state of ['undone', 'expired', 'changed'] as const) if (states.includes(state)) return state
  return 'undoable'
}

/** 留作撤销的已结清条目（删一方、提升为全局、直接改与直接合并、整理所选的应用、移到项目、模型改写与替代）：快照过了保留窗口就无从撤销。 */
export function isUndoable(entry: PendingDecision): boolean {
  const undoable = asUndoable(entry)
  if (undoable === undefined) return false
  const rule = undoRuleOf(undoable)
  return verdictLoser(undoable, undoable.settled.verdict) !== undefined || undoable.settled.verdict === 'promoted'
    || rule.expectedStatus !== undefined || rule.receipts !== undefined
}

/** 账本清理的截止线（与快照、最近删除同一个 RETENTION_MS）：留作撤销的条目结清超过保留窗口就清掉。 */
export function isUndoExpired(entry: PendingDecision, now: number): boolean {
  return isUndoable(entry) && entry.settled!.at < now - RETENTION_MS
}
