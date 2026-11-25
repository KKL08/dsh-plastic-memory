import { createHash } from 'node:crypto'
import type { MemoryRecord } from '../record-schema.ts'
import type { InstructionFiles } from './instructions.ts'
import type { SemanticLlm } from './semantic-scan.ts'
import { copyKey, scanFingerprint, scopeKeyOf } from './changeset.ts'

/**
 * 增量体检的纯函数：判断上下文、批的键。不碰磁盘、不调模型。
 *
 * 体检照现在的方式把记忆分批交给模型（planSemanticBatches 不变）。成员和判断上下文都没变的批不再发，用上次存下的结论。
 * 一批由它的成员（每条记忆的副本身份和扫描指纹）和判断上下文认出来，和批内顺序无关。
 */

const sha1 = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex')

/** 判断上下文里指令文件的状态，四种互斥：没有、取不到、读到了（带摘要）、读到了但被截断（带摘要）。 */
export type InstructionState = 'none' | 'unavailable' | `read:${string}` | `truncated:${string}`

export function instructionState(files: InstructionFiles): InstructionState {
  if (files.kind === 'none') return 'none'
  if (files.kind === 'unavailable') return 'unavailable'
  return `${files.isTruncated ? 'truncated' : 'read'}:${sha1(files.texts)}`
}

/**
 * 判断上下文：提示词版本、提供方、模型、推理强度（拿不到取空串）、指令文件状态。任一项变了，按旧上下文查出的结论不再直接用。
 * 跨项目比较不看指令文件，instructions 给 null。
 */
export function checkContext(promptVersion: number, llm: Pick<SemanticLlm, 'provider' | 'model' | 'reasoningEffort'>, instructions: InstructionState | null): string {
  return JSON.stringify([promptVersion, llm.provider ?? '', llm.model ?? '', llm.reasoningEffort ?? '', ...(instructions === null ? [] : [instructions])])
}

/** 批的一个成员：副本身份（changeset.ts copyKey，作用域取预读实际选中的那份）和它的扫描指纹。 */
export type BatchMember = readonly [copy: string, fingerprint: string]

/** 一批的成员，按副本身份排序：批内顺序不影响批的键。 */
export function batchMembers(records: readonly MemoryRecord[]): BatchMember[] {
  return records
    .map((r): BatchMember => [memberCopyKey(r), scanFingerprint(r)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** 一条记忆的副本身份。 */
export function memberCopyKey(r: Pick<MemoryRecord, 'id' | 'scope' | 'workspacePath'>): string {
  return copyKey({ scopeKey: scopeKeyOf(r), memoryId: r.id })
}

/** 副本身份里的记忆 id；认不出（不是这里写的形状）为 undefined。 */
export function memberIdOf(copy: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(copy)
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string' ? parsed[1] : undefined
  } catch {
    return undefined
  }
}

/** 批的键：判断上下文加排好序的成员。 */
export function batchKey(ctx: string, members: readonly BatchMember[]): string {
  return sha1([ctx, [...members].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])
}
