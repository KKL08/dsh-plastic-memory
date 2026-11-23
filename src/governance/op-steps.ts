import type { MemoryLogger } from '../store.ts'
import type { OpStep, OpStepHandler } from '../storage/table.ts'
import { ledgerLabel, scopeOfMemory } from '../scope.ts'
import { genId, type PendingDecision } from './schema.ts'
import type { PendingDecisionsStore } from './decisions.ts'

/**
 * 记忆文件写成之后要补的账：正常写完和中断后补做走同一个处理器（见 MemoryTable.registerStep）。
 * 步骤里只有 id、时刻和出处，记忆的名字和指纹到做的时候从写下的那条取。
 */

/** 模型改写、替代：记一条已结清的条目（撤销入口）。条目 id 写入前就定好，补做重来不会多记一条。 */
export const MODEL_CHANGE_STEP = 'ledger-model-change'

type Origin = NonNullable<PendingDecision['origin']>

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
  }
}
