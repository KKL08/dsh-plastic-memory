import type { MemoryLogger } from '../store.ts'
import type { OpStep, OpStepHandler } from '../storage/table.ts'
import { ledgerLabel, scopeOfMemory } from '../scope.ts'
import { genId, type LinkIds, type PendingDecision } from './schema.ts'
import type { PendingDecisionsStore } from './decisions.ts'

/**
 * 记忆文件写成之后要补的账：正常写完和中断后补做走同一个处理器（见 MemoryTable.registerStep）。
 * 步骤里只有 id、时刻和出处，记忆的名字和指纹到做的时候从写下的那条取。
 */

/** 模型改写、替代：记一条已结清的条目（撤销入口）。条目 id 写入前就定好，补做重来不会多记一条。 */
export const MODEL_CHANGE_STEP = 'ledger-model-change'

/** 整理索引：一个索引操作提交之后，确认它在那次整理的条目上的回执（回执动手前已记下）。步骤里只有条目 id。 */
export const INDEX_RECEIPT_STEP = 'ledger-index-receipt'
/** 整理索引的撤销：一个操作撤掉之后，把它的回执从条目里拿掉。 */
export const INDEX_RECEIPT_UNDONE_STEP = 'ledger-index-receipt-undone'

interface IndexReceiptStep extends OpStep { kind: typeof INDEX_RECEIPT_STEP; entryId: string }
interface IndexReceiptUndoneStep extends OpStep { kind: typeof INDEX_RECEIPT_UNDONE_STEP; entryId: string; receiptOp: string }

export function indexReceiptStep(entryId: string): IndexReceiptStep {
  return { kind: INDEX_RECEIPT_STEP, entryId }
}

export function indexReceiptUndoneStep(entryId: string, receiptOp: string): IndexReceiptUndoneStep {
  return { kind: INDEX_RECEIPT_UNDONE_STEP, entryId, receiptOp }
}

/** 只挂关联、前提的保存：记一条已结清的回执（撤销入口），带这次新加的 id。条目 id 写入前就定好，补做重来不会多记一条。 */
export const LINK_CHANGE_STEP = 'ledger-link-change'

type Origin = NonNullable<PendingDecision['origin']>

interface LinkChangeStep extends OpStep {
  kind: typeof LINK_CHANGE_STEP
  entryId: string
  added: LinkIds
  at: number
  origin: Origin
}

export function linkChangeStep(input: { added: LinkIds; at: number; origin: Origin }): LinkChangeStep {
  return { kind: LINK_CHANGE_STEP, entryId: genId('pd'), ...input }
}

/**
 * 撤销只挂关联的那次保存：去掉链接的那次写入提交之后，把回执标成已撤销。和写文件记在同一个操作里，中途断掉下次进写入段补上，
 * 重试的撤销看到回执已结清就不再动文件（不然会把之后重新挂上的同一个 id 也去掉）。
 */
export const LINK_UNDONE_STEP = 'ledger-link-undone'

interface LinkUndoneStep extends OpStep { kind: typeof LINK_UNDONE_STEP; entryId: string }

export function linkUndoneStep(entryId: string): LinkUndoneStep {
  return { kind: LINK_UNDONE_STEP, entryId }
}

interface ModelChangeStep extends OpStep {
  kind: typeof MODEL_CHANGE_STEP
  change: 'rewrite' | 'supersede'
  entryId: string
  snapshotId: string
  at: number
  origin: Origin
}

export function modelChangeStep(input: { change: 'rewrite' | 'supersede'; snapshotId: string; at: number; origin: Origin }): ModelChangeStep {
  return { kind: MODEL_CHANGE_STEP, entryId: genId('pd'), ...input }
}

export function ledgerSteps(decisions: PendingDecisionsStore, log: MemoryLogger = console): Record<string, OpStepHandler> {
  return {
    [MODEL_CHANGE_STEP]: async (raw, { op, record, isIntact }) => {
      const step = raw as ModelChangeStep
      if (record === undefined) return
      // 撤销按条目上的指纹确认「之后没被别处改过」：文件已不是这次写下的原样，按它记指纹会让撤销盖掉别人的改动，所以不记撤销入口
      if (!isIntact) {
        log.warn(`[plastic-memory] 操作 ${op} 写成之后记忆 ${record.id} 又被改过，没有补记撤销入口；改前的内容还在撤销快照 ${step.snapshotId} 里`)
        return
      }
      const scope = scopeOfMemory(record)
      await decisions.addModelChange(
        record, { kind: step.change, workspace: scope === undefined ? '' : ledgerLabel(scope), origin: step.origin }, step.snapshotId, step.at, step.entryId,
      )
    },
    [LINK_CHANGE_STEP]: async (raw, { record }) => {
      const step = raw as LinkChangeStep
      // 文件已不在（之后被彻底删除）：没有可撤的。撤销只看它加的 id 还在不在，写成之后又被改过也照记
      if (record === undefined) return
      const scope = scopeOfMemory(record)
      await decisions.addLinkChange(record, { added: step.added, workspace: scope === undefined ? '' : ledgerLabel(scope), origin: step.origin }, step.at, step.entryId)
    },
    [LINK_UNDONE_STEP]: async (raw) => {
      await decisions.markUndone((raw as LinkUndoneStep).entryId)
    },
    [INDEX_RECEIPT_STEP]: async (raw, { op }) => {
      const step = raw as IndexReceiptStep
      if (!(await decisions.confirmIndexReceipt(step.entryId, op))) {
        log.warn(`[plastic-memory] 索引操作 ${op} 做成了，但它那次整理的记录已经不在，没有撤销入口`)
      }
    },
    [INDEX_RECEIPT_UNDONE_STEP]: async (raw) => {
      const step = raw as IndexReceiptUndoneStep
      await decisions.dropIndexReceipt(step.entryId, step.receiptOp)
    },
  }
}
