import type { MemoryLogger, MemoryStore } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { CheckupRecordStore } from '../governance/checkup-records.ts'
import { isAbort, type SemanticLlm } from '../governance/semantic-scan.ts'
import { buildOrganizePrompt, organizeBatches, organizeDirectory, organizeGroups, parseOrganizeOutput, type OrganizeMember } from '../governance/index-organize.ts'
import { INDEX_RECEIPT_STEP, indexReceiptStep, ledgerSteps } from '../governance/op-steps.ts'
import { genId } from '../governance/schema.ts'
import { JSON_RETRY_HINT } from '../json-reply.ts'
import { maskDiagnostic } from '../secrets.ts'
import { ledgerLabel, type Scope } from '../scope.ts'
import type { IndexFiles } from '../topic-index.ts'
import { holdCheckups, type IntervalTimer } from './checkup-run.ts'

export interface OrganizeDeps {
  store: MemoryStore
  decisions: PendingDecisionsStore
  /** 整理和体检共用一套认领：同一个范围同时只有一处在动。 */
  checkups: Pick<CheckupRecordStore, 'claim' | 'recordOrganized'>
  interval: IntervalTimer
  maxTopics: number
  now: () => number
  log: MemoryLogger
  onClaimChanged?: () => Promise<void> | void
}

export type OrganizeOutcome =
  | { kind: 'busy'; scope: Scope }
  /** 这个范围还没有主题索引（没有记忆）。 */
  | { kind: 'empty' }
  /** 模型没调成，一个操作都没做。 */
  | { kind: 'failed'; message: string }
  /**
   * 做完了：applied 是做成的操作数，skipped 是落盘时对不上、跳过的，dropped 是模型给的不合格式、丢掉的，unreadBatches 是输出读不出来的批数。
   * decisionId 是这次整理的记录（交给 undo 整批撤销），一个操作都没做成时没有。isPartial：中途停下了（模型出错、被取消、认领被接手）。
   */
  | { kind: 'done'; decisionId?: string; applied: number; skipped: number; dropped: number; unreadBatches: number; isPartial?: true }

/**
 * 整理一次一个范围的主题索引：认领范围 → 整份核对 → 先问模型怎么调主题目录（已有主题时）、再按批问成员怎么归 → 每个操作各进一次写入段落盘
 * → 再核对一遍、重新生成入口投影 → 记下整理时刻。调模型都在锁外；每个操作落盘前按当下的索引重新核对，对不上的跳过，不影响其余。
 * 每个做成的操作有一条回执，记在这次整理的账本条目上，整批可撤。
 */
export async function runOrganize(input: { scope: Scope; llm: SemanticLlm; signal?: AbortSignal }, deps: OrganizeDeps): Promise<OrganizeOutcome> {
  const { scope, llm } = input
  const controller = new AbortController()
  const signal = input.signal !== undefined ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
  const held = await holdCheckups(deps.checkups, [scope], {
    interval: deps.interval,
    onLost: () => { controller.abort(new DOMException('organize claim taken over', 'AbortError')) },
    ...(deps.onClaimChanged !== undefined ? { onChange: deps.onClaimChanged } : {}),
    log: deps.log,
  })
  if ('busy' in held) return { kind: 'busy', scope: held.busy }
  try {
    if (!deps.store.hasStep(INDEX_RECEIPT_STEP)) deps.store.registerSteps(ledgerSteps(deps.decisions, deps.log))
    await deps.store.maintain(scope)
    const load = async (): Promise<{ files: IndexFiles; members: Map<string, OrganizeMember> } | undefined> => {
      const files = await deps.store.readIndex(scope)
      if (files === undefined) return undefined
      const read = await deps.store.readRaw(scope)
      const members = new Map(read.records.filter(l => l.record.status === 'active').map(({ record: r }) => [r.id, { id: r.id, name: r.name, summary: r.summary, updatedAt: r.updatedAt }]))
      return { files, members }
    }
    const first = await load()
    if (first === undefined || first.members.size === 0) return { kind: 'empty' }

    const entryId = genId('pd')
    const tally = { applied: 0, skipped: 0, dropped: 0, unreadBatches: 0 }
    let hasEntry = false
    let failure: string | undefined
    let isStopped = false

    /** 问一批、把给的操作逐个落盘。返回 false 表示后面的批不用再问了。 */
    const round = async (only: ReadonlySet<string> | undefined): Promise<boolean> => {
      if (signal.aborted) return false
      const state = await load()
      if (state === undefined) return false
      const groups = only === undefined ? [] : organizeGroups(state.files, state.members, only)
      if (only !== undefined && groups.length === 0) return true
      const prompt = buildOrganizePrompt(organizeDirectory(state.files, state.members, deps.now()), groups, deps.maxTopics)
      let parsed: ReturnType<typeof parseOrganizeOutput>
      for (let attempt = 0; attempt < 2 && parsed === undefined; attempt++) {
        let raw: string
        try {
          raw = await llm.complete(attempt === 0 ? prompt : { ...prompt, user: prompt.user + JSON_RETRY_HINT }, signal)
        } catch (err) {
          if (!isAbort(err, signal)) failure = maskDiagnostic(err instanceof Error ? err.message : String(err))
          return false
        }
        parsed = parseOrganizeOutput(raw, new Set(state.members.keys()))
      }
      if (parsed === undefined) {
        tally.unreadBatches++
        return true
      }
      tally.dropped += parsed.dropped
      for (const op of parsed.ops) {
        if (signal.aborted) return false
        if (!hasEntry) {
          await deps.decisions.addIndexRun(entryId, { summary: '整理了一次主题索引', workspace: ledgerLabel(scope) }, deps.now())
          hasEntry = true
        }
        const r = await deps.store.applyIndexOp(scope, op, {
          maxTopics: deps.maxTopics,
          // 回执在写索引之前先记下（带撤销要用的改前数据），提交后的步骤只负责确认它
          prepare: async (id, plan) => {
            await deps.decisions.appendIndexReceipt(entryId, { op: id, plan })
            return [indexReceiptStep(entryId)]
          },
        })
        if (r.kind === 'applied') tally.applied++
        else tally.skipped++
      }
      return true
    }

    // 还没有主题时没有目录可调，直接看成员
    const hasTopics = organizeDirectory(first.files, first.members, deps.now()).length > 0
    if (!hasTopics || await round(undefined)) {
      const after = await load()
      for (const batch of after === undefined ? [] : organizeBatches(after.files, after.members)) {
        if (!(await round(new Set(batch)))) {
          isStopped = true
          break
        }
      }
    } else {
      isStopped = true
    }

    const entry = hasEntry ? await deps.store.writeSection(() => deps.decisions.finishIndexRun(entryId, op => deps.store.isOpPending(op))) : undefined
    if (tally.applied > 0) await deps.store.maintain(scope)
    if (failure !== undefined && tally.applied === 0) return { kind: 'failed', message: failure }
    if (!isStopped) await deps.checkups.recordOrganized(scope, deps.now())
    return { kind: 'done', ...(entry !== undefined ? { decisionId: entry.id } : {}), ...tally, ...(isStopped ? { isPartial: true as const } : {}) }
  } finally {
    await held.release()
  }
}
