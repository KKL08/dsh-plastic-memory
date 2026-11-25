import type { MemoryRecord } from '../record-schema.ts'
import { basisOf, scopeKeyOf, type ChangeOp, type CreateDraft, type FieldPatch } from './changeset.ts'

/**
 * 涉及几条记忆的方案展开成变更集的操作。调用方（体检建议、记忆梦境、界面）只交方案；按方案种类决定直接做还是交给用户的，
 * 看的是方案，不看展开后的步骤（合并里也有删除）。输入的记忆是调用方判断时读到的那一版：依据按它们算。
 */

const ref = (r: MemoryRecord) => ({ memoryId: r.id, scopeKey: scopeKeyOf(r) })
const sameCopy = (a: MemoryRecord, b: MemoryRecord) => a.id === b.id && scopeKeyOf(a) === scopeKeyOf(b)
type Fused = Pick<FieldPatch, 'name' | 'summary' | 'content' | 'tags'>

/** 合并：存活的那条改成融合稿，其余的软删并记下并进了它。一组，全做成才算。 */
export function mergePlan(input: { group: string; keeper: MemoryRecord; merged: readonly MemoryRecord[]; fused: Fused; reason?: string }): ChangeOp[] {
  const { group, keeper, merged, fused } = input
  if (merged.length === 0) throw new Error('合并至少要有一条被合并的记忆')
  if (merged.some(m => sameCopy(m, keeper)) || merged.some((m, i) => merged.findIndex(o => sameCopy(o, m)) !== i)) throw new Error('合并的各条不能重复')
  const all = [keeper, ...merged].map(basisOf)
  const expect = Object.fromEntries(Object.keys(fused).map(field => [field, keeper[field as keyof Fused]])) as Fused
  return [
    { id: `${group}-keep`, kind: 'edit', ...ref(keeper), patch: fused, expect, basis: all, group, ...(input.reason !== undefined ? { reason: input.reason } : {}) },
    ...merged.map((m, i): ChangeOp => ({
      id: `${group}-merge-${i + 1}`, kind: 'forget', ...ref(m), basis: [basisOf(m), basisOf(keeper)], into: { ...ref(keeper), as: 'merge' }, group,
    })),
  ]
}

/** 并成版本：旧状态那条软删，记下它成了当前页的一个历史版本。当前页不写。 */
export function versionPlan(input: { id: string; current: MemoryRecord; old: MemoryRecord; group?: string }): ChangeOp[] {
  const { current, old } = input
  if (sameCopy(current, old)) throw new Error('并成版本的两条不能是同一条')
  return [{
    id: input.id, kind: 'forget', ...ref(old), basis: [basisOf(old), basisOf(current)], into: { ...ref(current), as: 'version' },
    ...(input.group !== undefined ? { group: input.group } : {}),
  }]
}

/** 拆分：逐条新建（继承原件的类型、出处这些），原件软删。一组。newId 给每条新记忆定 id。 */
export function splitPlan(input: { group: string; original: MemoryRecord; drafts: readonly CreateDraft[]; newId: () => string }): ChangeOp[] {
  const { group, original, drafts } = input
  if (drafts.length < 2) throw new Error('拆分至少要拆成两条')
  const basis = [basisOf(original)]
  return [
    ...drafts.map((draft, i): ChangeOp => ({
      id: `${group}-new-${i + 1}`, kind: 'create', memoryId: input.newId(), scopeKey: scopeKeyOf(original), basis, from: ref(original), draft, group,
    })),
    { id: `${group}-original`, kind: 'forget', ...ref(original), basis, group },
  ]
}
