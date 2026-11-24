import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { CHANGE_KINDS, anchorSourceMode, anchorsOf, linkIdsSchema, type ChangeKind, type LinkIds, type MemoryRecord } from '../record-schema.ts'
import { GLOBAL_SCOPE_KEY } from '../scope.ts'
import { detectSecrets, secretValues } from '../secrets.ts'
import { roundValidity } from '../validity.ts'

/**
 * 变更集：一个方案是一组操作，每个操作带字段补丁、读到时的预期值和依据。这里只有契约和纯函数：
 * 锁内拿刚读到的记录核对一个操作做不做（checkOp）、同一批的进度怎么推进、回执够不够撤销（revertBlock）、撤销还原成什么（reverted）。
 * 落盘在执行器（src/changeset.ts）。
 */

/** 这一版落地的操作。 */
export const CHANGE_OP_KINDS = ['edit', 'forget', 'keep', 'corroborate', 'set-validity', 'set-recall', 'link'] as const
/** 词汇里有、落地在后面版本的操作：读得出，应用时跳过。 */
export const RESERVED_OP_KINDS = ['version', 'merge', 'split', 'move-scope', 'mark-exception', 'set-topic'] as const
export type ChangeOpKind = (typeof CHANGE_OP_KINDS)[number]

/** 补丁能改的字段。内容字段的改动记进最近一次内容改动；注入档位是元数据，不记。 */
export const CONTENT_PATCH_FIELDS = ['name', 'summary', 'content', 'tags', 'factTime', 'validFrom', 'validTo'] as const
export const PATCH_FIELDS = [...CONTENT_PATCH_FIELDS, 'recall'] as const
export type PatchField = (typeof PATCH_FIELDS)[number]

/** 每种操作的补丁里允许出现的字段。 */
const FIELDS_BY_KIND: Record<ChangeOpKind, readonly PatchField[]> = {
  edit: ['name', 'summary', 'content', 'tags', 'factTime'],
  'set-validity': ['validFrom', 'validTo'],
  'set-recall': ['recall'],
  forget: [], keep: [], corroborate: [], link: [],
}

/** 补丁：只列要改的字段和新值；null 是清掉这个字段（名称、摘要、正文、标签清不掉）。 */
export const fieldPatchSchema = z.object({
  name: z.string().min(1),
  summary: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  factTime: z.string().nullable(),
  validFrom: z.number().nullable(),
  validTo: z.number().nullable(),
  recall: z.unknown(),
}).partial().strict()
export type FieldPatch = z.infer<typeof fieldPatchSchema>

/** 依据：判断时读过的一条记忆（目标自己也列在里面）当时的扫描指纹和作用域键。 */
export const opBasisSchema = z.object({ memoryId: z.string(), fingerprint: z.string(), scopeKey: z.string() })
export type OpBasis = z.infer<typeof opBasisSchema>

const linkDeltaSchema = z.object({ add: linkIdsSchema.partial().optional(), remove: linkIdsSchema.partial().optional() })

export const changeOpSchema = z.object({
  /** 这个操作在方案里的 id：回执按它认。 */
  id: z.string(),
  kind: z.enum([...CHANGE_OP_KINDS, ...RESERVED_OP_KINDS]),
  memoryId: z.string(),
  patch: fieldPatchSchema.optional(),
  /** 补丁里每个字段读到时的值；null 是读到时没有。 */
  expect: fieldPatchSchema.optional(),
  basis: z.array(opBasisSchema),
  /** 关联和前提按增量：加哪几个、去哪几个。 */
  links: linkDeltaSchema.optional(),
  /** 内容改动的性质（edit、set-validity）；缺省按细化。 */
  change: z.enum(CHANGE_KINDS).optional(),
  /** 状态变化的原因，随历史版本留着。 */
  reason: z.string().optional(),
})
export type ChangeOp = z.infer<typeof changeOpSchema>

const sha1 = (value: unknown) => createHash('sha1').update(JSON.stringify(value) ?? 'null').digest('hex')
const lf = (text: string) => text.replace(/\r\n/g, '\n')

/** 开放取值里的对象按键名排序：只换了键的顺序不算改过。 */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v === null || typeof v !== 'object') return v
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])]))
}

/** 一个字段拿来比的值：没有记 null，正文的换行风格归一，有效期按文件里的分钟比。 */
export function fieldValue(record: MemoryRecord, field: PatchField): unknown {
  const raw = record[field]
  if (raw === undefined) return null
  if (field === 'content') return lf(raw as string)
  if (field === 'validFrom' || field === 'validTo') return roundValidity(field, raw as number)
  return field === 'recall' ? sortKeys(raw) : raw
}

function normalized(field: PatchField, value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (field === 'content') return lf(value as string)
  if (field === 'validFrom' || field === 'validTo') return roundValidity(field, value as number)
  return field === 'recall' ? sortKeys(value) : value
}

/** 一个字段的值的摘要：回执里记它，不记值。 */
export const fieldDigest = (record: MemoryRecord, field: PatchField) => sha1(fieldValue(record, field))

/**
 * 扫描指纹：交给模型判断的全部字段（名称、摘要、正文、事实时间、有效期、来源方式、最近一次改动的性质、取代关系）。
 * 这些任一项变了，按旧内容做的判断就不算数。标签、注入档位、关联、锁、确认时间不在里面。
 */
export function scanFingerprint(r: MemoryRecord): string {
  const latest = anchorsOf(r)[0]
  return sha1({
    name: r.name, summary: r.summary, content: lf(r.content),
    factTime: r.factTime ?? null,
    validFrom: r.validFrom === undefined ? null : roundValidity('validFrom', r.validFrom),
    validTo: r.validTo === undefined ? null : roundValidity('validTo', r.validTo),
    sourceMode: latest === undefined ? null : anchorSourceMode(latest),
    changeKind: r.lastChange?.kind ?? null,
    supersedes: r.supersedes ?? [],
  })
}

/** 记忆的作用域键（同 scope.ts scopeKey）；项目记忆缺路径的定位不到，给空串，和谁都对不上。 */
export function scopeKeyOf(r: Pick<MemoryRecord, 'scope' | 'workspacePath'>): string {
  return r.scope === 'global' ? GLOBAL_SCOPE_KEY : r.workspacePath ?? ''
}

/** 这一条记忆此刻当依据用的版本。 */
export function basisOf(r: MemoryRecord): OpBasis {
  return { memoryId: r.id, fingerprint: scanFingerprint(r), scopeKey: scopeKeyOf(r) }
}

/**
 * 同一批的进度，按记忆记：这批对它写过哪些字段和写下的值，写完后的扫描指纹。后面的操作对写过的字段拿刚写下的值当预期，
 * 依据指纹拿写完后的比；没写过的字段仍按读到时的值比，不整版换基线。
 */
export interface BatchProgress {
  written: Map<string, Map<PatchField, unknown>>
  fingerprints: Map<string, string>
}

export function newProgress(): BatchProgress {
  return { written: new Map(), fingerprints: new Map() }
}

/** 一个操作写成之后推进进度：written 是提交的那一版。 */
export function advance(progress: BatchProgress, op: ChangeOp, written: MemoryRecord): void {
  const fields = progress.written.get(op.memoryId) ?? new Map<PatchField, unknown>()
  for (const field of patchedFields(op)) fields.set(field, fieldValue(written, field))
  progress.written.set(op.memoryId, fields)
  progress.fingerprints.set(op.memoryId, scanFingerprint(written))
}

export function patchedFields(op: ChangeOp): PatchField[] {
  return PATCH_FIELDS.filter(field => op.patch !== undefined && field in op.patch)
}

/**
 * 跳过的原因。unsupported：这一版不落地的操作，或补丁里有这种操作不该带的字段；gone：目标不在了、不在用；
 * moved：目标或依据换了作用域；basis-changed：依据的记忆内容变了、不在用了；field-changed：补丁里的字段已不是读到时的值；
 * foreign-secret：改写稿里带进了原记忆没有的疑似密钥，或有高危密钥；no-change：补丁和现状一样，没有可写的。
 */
export type SkipReason = 'unsupported' | 'gone' | 'moved' | 'basis-changed' | 'field-changed' | 'foreign-secret' | 'no-change'

export type OpCheck =
  /** 写：fields 是要改的字段和新值（值是 undefined 即清掉）。 */
  | { kind: 'write'; fields: Partial<Record<PatchField, unknown>> }
  /** 关联和前提按增量：这里只说核对过了，增量由执行器对锁内的最新值应用。 */
  | { kind: 'link' }
  | { kind: 'corroborate' }
  | { kind: 'forget' }
  /** 核对过了，不写（keep）。 */
  | { kind: 'none' }
  | { kind: 'skip'; reason: SkipReason; memoryId: string }

export interface CheckInput {
  /** 写入段里刚读到的目标；定位不到为 undefined。 */
  target: MemoryRecord | undefined
  /** 写入段里刚读到的依据记忆，按 id；定位不到的没有这一项。目标自己不用放。 */
  basis: ReadonlyMap<string, MemoryRecord>
  progress: BatchProgress
  /** 后台写入：改写稿里的疑似密钥只放行原记忆（目标和依据）里已有的。界面里用户亲手定的稿不查这一条。 */
  isSecretChecked: boolean
}

const surface = (r: Pick<MemoryRecord, 'content' | 'name' | 'summary' | 'tags'>) => `${r.content}\n${r.name}\n${r.summary}\n${r.tags.join(' ')}`

/**
 * 补丁里的密钥是不是带进来的：有高危密钥，或有疑似密钥的值不在原记忆里（模型编的、截短加长的、从别处带来的）。
 * 按完整的值比，不看标签和分隔符。原记忆里本来就有、用户保存时确认过的疑似值原样保留不算。
 */
export function hasForeignSecret(patch: FieldPatch, originals: readonly MemoryRecord[]): boolean {
  const text = [patch.content, patch.name, patch.summary, patch.tags?.join(' ')].filter(part => part !== undefined).join('\n')
  if (text === '') return false
  if (detectSecrets(text).some(hit => hit.severity === 'critical')) return true
  const known = new Set(originals.flatMap(r => secretValues(surface(r), { severity: 'suspected' })))
  return secretValues(text, { severity: 'suspected' }).some(value => !known.has(value))
}

/**
 * 锁内核对一个操作做不做。三件事都对得上才做：目标和依据都还在用、还在读到时的作用域；依据的扫描指纹没变
 * （这一批自己写过的拿写完后的指纹比）；补丁里的字段现在还是读到时的值（这一批自己写过的拿刚写下的值比）。
 * 提交标记、确认时间、注入档位这些不在依据里的不参与。
 */
export function checkOp(op: ChangeOp, input: CheckInput): OpCheck {
  const skip = (reason: SkipReason, memoryId = op.memoryId): OpCheck => ({ kind: 'skip', reason, memoryId })
  if (!(CHANGE_OP_KINDS as readonly string[]).includes(op.kind)) return skip('unsupported')
  const kind = op.kind as ChangeOpKind
  const fields = patchedFields(op)
  if (fields.some(field => !FIELDS_BY_KIND[kind].includes(field))) return skip('unsupported')
  if (kind === 'link' && op.links === undefined) return skip('unsupported')

  const { target, progress } = input
  if (target === undefined || target.status !== 'active') return skip('gone')
  const records = new Map(input.basis)
  records.set(target.id, target)
  for (const basis of op.basis) {
    const record = records.get(basis.memoryId)
    if (record === undefined || record.status !== 'active') return skip('basis-changed', basis.memoryId)
    if (scopeKeyOf(record) !== basis.scopeKey) return skip('moved', basis.memoryId)
    const expected = progress.fingerprints.get(basis.memoryId) ?? basis.fingerprint
    if (scanFingerprint(record) !== expected) return skip('basis-changed', basis.memoryId)
  }
  const written = progress.written.get(op.memoryId)
  for (const field of fields) {
    const expected = written?.has(field) === true ? written.get(field) : normalized(field, op.expect?.[field])
    if (!isDeepStrictEqual(fieldValue(target, field), expected)) return skip('field-changed')
  }

  if (kind === 'keep') return { kind: 'none' }
  if (kind === 'forget') return { kind: 'forget' }
  if (kind === 'corroborate') return { kind: 'corroborate' }
  if (kind === 'link') return { kind: 'link' }
  if (input.isSecretChecked && kind === 'edit' && hasForeignSecret(op.patch ?? {}, [...records.values()])) return skip('foreign-secret')
  const changed = fields.filter(field => !isDeepStrictEqual(fieldValue(target, field), normalized(field, op.patch![field])))
  if (changed.length === 0) return skip('no-change')
  // 只写确实要变的字段：回执和撤销都按它们算
  return { kind: 'write', fields: Object.fromEntries(changed.map(field => [field, op.patch![field] ?? undefined])) }
}

/** 这次内容改动的性质：操作声明的，缺省细化。 */
export function changeKindOf(op: ChangeOp): ChangeKind {
  return op.change ?? 'refine'
}

/** 出处清单的摘要：回执记它，撤销时对不上说明期间被补证过。 */
export function trailDigest(r: MemoryRecord): string {
  return sha1(anchorsOf(r).map(a => [a.sessionId, a.eventRange, a.at ?? null, a.change ?? null]))
}

/**
 * 一个操作的回执（账本条目的 changes，按做的先后）。不存字段值：写下的值记摘要，改前的值撤销时从改前快照取。
 * op 是这次写入的操作 id（提交标记、最近一次内容改动里记的那个）；fields 是实际改了的字段；status、scopeKey 是写完后的样子；
 * links 是这次实际加上、去掉的 id；trail 是写完后出处清单的摘要；confirmedAt 是写下的确认时间。
 */
export const changeReceiptSchema = z.object({
  id: z.string(),
  op: z.string(),
  memoryId: z.string(),
  kind: z.enum(CHANGE_OP_KINDS),
  fields: z.array(z.enum(PATCH_FIELDS)),
  after: z.record(z.string(), z.string()),
  status: z.enum(['active', 'deleted']),
  scopeKey: z.string(),
  snapshotId: z.string().optional(),
  links: z.object({ added: linkIdsSchema, removed: linkIdsSchema }).optional(),
  isContent: z.boolean(),
  trail: z.string(),
  confirmedAt: z.number(),
})
export type ChangeReceipt = z.infer<typeof changeReceiptSchema>

/** 写成之后算回执：written 是提交的那一版。 */
export function receiptOf(
  input: { id: string; op: string; kind: ChangeOpKind; fields: readonly PatchField[]; snapshotId?: string; links?: { added: LinkIds; removed: LinkIds } },
  written: MemoryRecord,
): ChangeReceipt {
  return {
    id: input.id, op: input.op, memoryId: written.id, kind: input.kind,
    fields: [...input.fields],
    after: Object.fromEntries(input.fields.map(field => [field, fieldDigest(written, field)])),
    status: written.status === 'deleted' ? 'deleted' : 'active',
    scopeKey: scopeKeyOf(written),
    ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
    ...(input.links !== undefined ? { links: input.links } : {}),
    isContent: input.fields.some(field => (CONTENT_PATCH_FIELDS as readonly string[]).includes(field)),
    trail: trailDigest(written),
    confirmedAt: written.lastConfirmedAt,
  }
}

/**
 * 撤不了的原因。gone：记忆不在了；status：状态已不是这次操作后的样子（期间被软删、被恢复、被取代）；moved：换了作用域；
 * field-changed：补丁里的字段已不是这次写下的值；overwritten：内容之后又被别的操作改过；corroborated：期间出处清单变了（被补证过）；
 * expired：改前的值已不在快照里。
 */
export type RevertBlock = 'gone' | 'status' | 'moved' | 'field-changed' | 'overwritten' | 'corroborated' | 'expired'

/**
 * 这条回执此刻撤不撤得了：返回 undefined 是能撤。current 是写入段里刚读到的那一版，before 是改前快照里的。
 * 确认时间不参与；关联和前提按增量撤，期间别人加的不挡它。删除的回执只看状态。
 */
export function revertBlock(receipt: ChangeReceipt, current: MemoryRecord | undefined, before: MemoryRecord | undefined): RevertBlock | undefined {
  if (current === undefined) return 'gone'
  if (current.status !== receipt.status) return 'status'
  if (scopeKeyOf(current) !== receipt.scopeKey) return 'moved'
  if (receipt.kind === 'forget') return undefined
  if (receipt.fields.some(field => fieldDigest(current, field) !== receipt.after[field])) return 'field-changed'
  if (receipt.isContent && current.lastChange?.op !== receipt.op) return 'overwritten'
  const touchesTrail = receipt.isContent || receipt.kind === 'corroborate'
  if (touchesTrail && trailDigest(current) !== receipt.trail) return 'corroborated'
  if ((receipt.fields.length > 0 || receipt.kind === 'corroborate') && before === undefined) return 'expired'
  return undefined
}

const without = (ids: readonly string[] | undefined, drop: readonly string[]) => (ids ?? []).filter(id => !drop.includes(id))

/**
 * 撤销还原成什么：刚读到的那一版，只把这次改的字段改回改前的值。改了内容的把最近一次内容改动、修改时间、状态起点、出处清单
 * 一起还原成快照里那份；确认时间还是这次写下的值才改回。关联和前提按增量：它加的还在就去掉，它去掉的还没回来就加回。
 * 期间别处改的注入档位、锁、关联原样留着。删除的撤销把状态放回在用、修改时间改回删之前的。
 */
export function reverted(receipt: ChangeReceipt, current: MemoryRecord, before: MemoryRecord | undefined): MemoryRecord {
  if (receipt.kind === 'forget') {
    const { deletedAt: _deletedAt, ...rest } = current
    return { ...rest, status: 'active', updatedAt: before?.updatedAt ?? current.updatedAt }
  }
  const next: Record<string, unknown> = { ...current }
  const restore = (key: keyof MemoryRecord) => {
    if (before?.[key] === undefined) delete next[key]
    else next[key] = before[key]
  }
  for (const field of receipt.fields) restore(field)
  const touchesTrail = receipt.isContent || receipt.kind === 'corroborate'
  if (receipt.isContent) for (const key of ['lastChange', 'updatedAt', 'stateSince'] as const) restore(key)
  if (touchesTrail) for (const key of ['source', 'sourceTrail'] as const) restore(key)
  if (receipt.kind === 'corroborate') restore('confidence')
  if (touchesTrail && before !== undefined && current.lastConfirmedAt === receipt.confirmedAt) next.lastConfirmedAt = before.lastConfirmedAt
  if (receipt.links !== undefined) {
    const { added, removed } = receipt.links
    const related = [...without(current.related, added.related), ...removed.related.filter(id => !(current.related ?? []).includes(id))]
    const backPremises = (before?.premises ?? []).filter(p => removed.premises.includes(p.id) && !(current.premises ?? []).some(c => c.id === p.id))
    const premises = [...(current.premises ?? []).filter(p => !added.premises.includes(p.id)), ...backPremises]
    if (related.length > 0) next.related = related
    else delete next.related
    if (premises.length > 0) next.premises = premises
    else delete next.premises
  }
  return next as MemoryRecord
}
