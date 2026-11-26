import { maintainStep, type DreamsStep } from './dreams-run.ts'
import { mergeFragmentsStep, type MergeStepDeps } from './dreams-merge.ts'
import { organizeIndexStep, tidyMemoriesStep, type TidyStepDeps } from './dreams-tidy.ts'
import { resolveFindingsStep, type ResolveFindingsDeps } from './dreams-tiers.ts'

/** 记忆梦境一次运行要用到的各步依赖（接线层组好传进来）。 */
export interface DreamsPlanDeps {
  tidy: TidyStepDeps
  merge: MergeStepDeps
  resolve: ResolveFindingsDeps
}

/**
 * 记忆梦境的运行计划，按顺序：维护（maintainStep）→ 整理主题索引（organizeIndexStep）→ 合并零碎记忆（mergeFragmentsStep）
 * → 处理矛盾（resolveFindingsStep）→ 逐条整理记忆（tidyMemoriesStep）。维护用 tidy.store。接线层（index.ts）只调这一个函数组计划。
 */
export function dreamsPlan({ tidy, merge, resolve }: DreamsPlanDeps): DreamsStep[] {
  return [maintainStep(tidy.store), organizeIndexStep(tidy), mergeFragmentsStep(merge), resolveFindingsStep(resolve), tidyMemoriesStep(tidy)]
}
