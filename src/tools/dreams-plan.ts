import { maintainStep, type DreamsStep } from './dreams-run.ts'
import { mergeFragmentsStep, type MergeStepDeps } from './dreams-merge.ts'
import { organizeIndexStep, tidyMemoriesStep, type TidyStepDeps } from './dreams-tidy.ts'
import { drillDownStep, type DrillDownStepDeps } from './dreams-drill.ts'
import { resolveFindingsStep, type ResolveFindingsDeps } from './dreams-tiers.ts'
import { checkupStep, type CheckupStepDeps } from './dreams-checkup.ts'

/** 记忆梦境一次运行要用到的各步依赖（接线层组好传进来）。 */
export interface DreamsPlanDeps {
  tidy: TidyStepDeps
  merge: MergeStepDeps
  checkup: CheckupStepDeps
  drill: DrillDownStepDeps
  resolve: ResolveFindingsDeps
}

/**
 * 记忆梦境的运行计划，按顺序：维护（maintainStep）→ 整理主题索引（organizeIndexStep）→ 合并零碎记忆（mergeFragmentsStep）
 * → 增量体检（checkupStep）→ 下钻补全（drillDownStep）→ 处理矛盾（resolveFindingsStep）→ 逐条整理记忆（tidyMemoriesStep）。
 * 体检挂进账本的新发现在同一次运行里由处理矛盾接着处理。维护用 tidy.store。接线层（index.ts）只调这一个函数组计划；
 * 定时、空闲、手动立即运行三个入口用的都是这一份计划。
 */
export function dreamsPlan({ tidy, merge, checkup, drill, resolve }: DreamsPlanDeps): DreamsStep[] {
  return [
    maintainStep(tidy.store), organizeIndexStep(tidy), mergeFragmentsStep(merge), checkupStep(checkup), drillDownStep(drill),
    resolveFindingsStep(resolve), tidyMemoriesStep(tidy),
  ]
}
