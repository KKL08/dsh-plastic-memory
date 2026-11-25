import type { MemoryStore } from '../store.ts'
import { mergePlan } from '../governance/changeset-plans.ts'
import { buildMergePrompt, mergeBasisFingerprint, mergeBatches, mergeGroupId, parseMergeOutput, planMerges } from '../governance/dreams-merge.ts'
import type { DreamsStore } from '../governance/dreams-records.ts'
import { DREAMS_APPLY_MAX_OPS, type DreamsStep } from './dreams-run.ts'
import { activeMembers, ask, unreadError } from './dreams-tidy.ts'

/**
 * 记忆梦境合并零碎记忆：上一次做完之后有变化的主题，把它的成员交给模型，模型指出哪几条重复或互补、给出合并稿。
 * 每一组走成组方案（mergePlan，发起方是记忆梦境）：第一步之前核对全部目标的写入许可和依据，锁定的、期间前台改过的整组跳过
 * （依据按 mergeBasisFingerprint：交给模型看的字段任一样变了都算改过）；
 * 做到一半有一步不成就把已做的撤回。合并稿正文超长、用户撤销过的同一个结论、跨范围的组在应用之前丢掉，列进结果，不落盘。
 * 中断留下的半个组由下次运行开头收尾（dreams-run.ts 第 4 步的 settleOpenGroups）。调模型都在锁外。
 * 合并成了的组，存活那条留给下次运行：这次运行后面的步骤不再改它（合并组还能单撤），下次运行它算变了、照常整理。
 * 名额不够整组跳过的，几条记成这次没处理到：下次运行合并照样重试，这次后面的逐条整理照常看它们。
 */

export interface MergeStepDeps {
  store: Pick<MemoryStore, 'readIndex' | 'readRaw'>
  /** 用户撤销过的合并结论。 */
  dreams: Pick<DreamsStore, 'undoneMerges'>
}

export const mergeFragmentsStep = (deps: MergeStepDeps): DreamsStep => ({
  name: 'merge-fragments',
  needsChanges: true,
  async run(ctx) {
    const files = await deps.store.readIndex(ctx.scope)
    const all = await activeMembers(deps.store, ctx)
    const changed = new Set([...all.keys()].filter(id => ctx.isChanged(id)))
    const batches = files === undefined || changed.size === 0 ? [] : mergeBatches(files, all, changed)
    if (files === undefined || batches.length === 0) return
    // 撤销记录读不全：不知道哪些结论用户撤销过，这一轮不合并（按没做完收，下次重来）
    const undone = await deps.dreams.undoneMerges(ctx.scope)
    if (undone === undefined) throw new Error('撤销过的合并记录读不全，这一轮不合并')
    const llm = await ctx.llm()
    let unread = 0
    for (const batch of batches) {
      if (ctx.shouldStop()) return
      // 名额用完了：没占名额的再问也只会被跳过，留给下次
      const closed = batch.filter(id => !ctx.canChange(id))
      ctx.markUnprocessed(closed)
      const open = batch.filter(id => !closed.includes(id))
      if (open.length < 2 || !open.some(id => changed.has(id))) continue
      // 问之前现读：依据、预期值和结论身份都按这一版，落盘前对不上就跳过
      const read = await activeMembers(deps.store, ctx)
      const shown = new Map(open.flatMap(id => { const r = read.get(id); return r === undefined ? [] : [[id, r] as const] }))
      if (shown.size < 2) continue
      const parsed = await ask(llm, buildMergePrompt(files, read, new Set(shown.keys())), parseMergeOutput, ctx)
      if (ctx.shouldStop()) return
      if (parsed === undefined) {
        unread++
        continue
      }
      const { drafts, dropped } = planMerges(parsed, shown, { undone, maxMembers: DREAMS_APPLY_MAX_OPS })
      for (const d of dropped) ctx.skip({ kind: 'merge', target: d.target, reason: d.reason })
      for (const draft of drafts) {
        if (ctx.shouldStop()) return
        const group = mergeGroupId(ctx.runId, draft.conclusion)
        const plan = mergePlan({ group, keeper: draft.keeper, merged: draft.merged, fused: draft.fused, fingerprint: mergeBasisFingerprint })
        const r = await ctx.apply(plan, { fingerprint: mergeBasisFingerprint })
        ctx.markUnprocessed(r.outcomes.flatMap(o => (o.kind === 'skipped' && o.reason === 'quota' ? [o.memoryId] : [])))
        if (r.groups?.find(g => g.group === group)?.state === 'applied') ctx.holdForNextRun([draft.keeper.id])
      }
    }
    if (unread > 0) throw unreadError(unread)
  },
})
