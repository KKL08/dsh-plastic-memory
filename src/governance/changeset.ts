import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { CHANGE_KINDS, anchorSourceMode, anchorsOf, readChangeKind, linkIdsSchema, type ChangeKind, type LinkIds, type MemoryRecord } from '../record-schema.ts'
import { GLOBAL_SCOPE_KEY } from '../scope.ts'
import { detectSecrets, secretValues } from '../secrets.ts'
import { roundValidity } from '../validity.ts'

/**
 * 变更集：一个方案是一组操作，每个操作带字段补丁、读到时的预期值和依据。这里只有契约和纯函数：
 * 锁内拿刚读到的记录核对一个操作做不做（checkOp）、同一批的进度怎么推进、回执够不够撤销（revertBlock）、撤销还原成什么（reverted）。
 * 落盘在执行器（src/tools/changeset.ts）。
 */

/** 这一版落地的操作。 */
export const CHANGE_OP_KINDS = ['edit', 'forget', 'keep', 'corroborate', 'set-validity', 'set-recall', 'link', 'create'] as const
/** 词汇里有、落地在后面版本的操作：读得出，应用时跳过。 */
/** 合并、并成版本、拆分由 changeset-plans.ts 展开成上面的操作，这三个词自己不落地。 */
export const RESERVED_OP_KINDS = ['version', 'merge', 'split', 'move-scope', 'mark-exception', 'set-topic'] as const
export type ChangeOpKind = (typeof CHANGE_OP_KINDS)[number]

/** 补丁能改的字段。内容字段的改动记进最近一次内容改动；注入档位是元数据，不记。 */
export const CONTENT_PATCH_FIELDS = ['name', 'summary', 'content', 'tags', 'factTime', 'validFrom', 'validTo'] as const
export const PATCH_FIELDS = [...CONTENT_PATCH_FIELDS, 'recall'] as const
export type PatchField = (typeof PATCH_FIELDS)[number]
/** 回执里能出现的字段：补丁的字段，加上界面里用户改稿时顺带写的升档标记。 */
export const RECEIPT_FIELDS = [...PATCH_FIELDS, 'delegation'] as const
export type ReceiptField = (typeof RECEIPT_FIELDS)[number]

/** 每种操作的补丁里允许出现的字段。 */
const FIELDS_BY_KIND: Record<ChangeOpKind, readonly PatchField[]> = {
  edit: ['name', 'summary', 'content', 'tags', 'factTime'],
  'set-validity': ['validFrom', 'validTo'],
  'set-recall': ['recall'],
  forget: [], keep: [], corroborate: [], link: [], create: [],
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

/** 新建的那条的内容；其余字段从 from 那条继承（见 createdFrom）。 */
export const createDraftSchema = z.object({ name: z.string().min(1), summary: z.string(), content: z.string(), tags: z.array(z.string()) }).strict()
export type CreateDraft = z.infer<typeof createDraftSchema>
const copyRefSchema = z.object({ memoryId: z.string(), scopeKey: z.string() })

const linkDeltaSchema = z.object({ add: linkIdsSchema.partial().optional(), remove: linkIdsSchema.partial().optional() })

export const changeOpSchema = z.object({
  /** 这个操作在方案里的 id：回执按它认。 */
  id: z.string(),
  kind: z.enum([...CHANGE_OP_KINDS, ...RESERVED_OP_KINDS]),
  memoryId: z.string(),
  /** 目标读到时的作用域键：同一个 id 在全局和项目里各有一份时，操作只认这一份。 */
  scopeKey: z.string(),
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
  /** 一起成立的一组：连续的、带同一个 group 的操作全做成才算成，一步不成就把组内已做的撤回。 */
  group: z.string().optional(),
  /** forget：这条并进了哪条（合并、并成版本），记在软删的那一版上；那条要在依据里。 */
  into: copyRefSchema.extend({ as: z.enum(['merge', 'version']) }).optional(),
  /** create：从哪条继承类型、出处这些；那条要在依据里。memoryId 是定好的新 id，scopeKey 是落在哪。 */
  from: copyRefSchema.optional(),
  /** create：新建的那条的内容。 */
  draft: createDraftSchema.optional(),
})
export type ChangeOp = z.infer<typeof changeOpSchema>

/** 值的摘要（按 JSON 序列化后取 sha1）。 */
export const sha1 = (value: unknown) => createHash('sha1').update(JSON.stringify(value) ?? 'null').digest('hex')
const lf = (text: string) => text.replace(/\r\n/g, '\n')

/** 开放取值里的对象按键名排序：只换了键的顺序不算改过。 */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v === null || typeof v !== 'object') return v
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])]))
}

/** 一个字段拿来比的值：没有记 null，正文的换行风格归一，有效期按文件里的分钟比。 */
export function fieldValue(record: MemoryRecord, field: ReceiptField): unknown {
  return normalized(field, record[field])
}

function normalized(field: ReceiptField, value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (field === 'content') return lf(value as string)
  if (field === 'validFrom' || field === 'validTo') return roundValidity(field, value as number)
  return field === 'recall' || field === 'delegation' ? sortKeys(value) : value
}

/** 一个字段的值的摘要：回执里记它，不记值。 */
export const fieldDigest = (record: MemoryRecord, field: ReceiptField) => sha1(fieldValue(record, field))

/**
 * 发给体检模型的记忆内容字段：体检的模型行（semantic-scan.ts semanticMemoryLine）按这份清单写，扫描指纹也包含这份清单里的每一项。
 * 行里的内容字段都在内容指纹里，行里另外的线索字段在记忆行指纹里。
 */
export const SCAN_CONTENT_FIELDS = ['type', 'name', 'content', 'summary', 'factTime', 'validFrom', 'validTo'] as const
export type ScanContentField = (typeof SCAN_CONTENT_FIELDS)[number]

/** 一个内容字段拿来比的值：没有记 null，正文的换行风格归一，有效期按文件里的分钟比。 */
export function scanFieldValue(r: MemoryRecord, field: ScanContentField): unknown {
  const value = r[field]
  if (value === undefined || value === null) return null
  if (field === 'content') return lf(value as string)
  if (field === 'validFrom' || field === 'validTo') return roundValidity(field, value as number)
  return value
}

/**
 * 内容指纹：只含发给体检模型的内容字段（SCAN_CONTENT_FIELDS）。已裁决冲突各成员的指纹用它：
 * 只换出处、改动性质、取代关系的补证不改变裁决依据。
 */
export function scanContentFingerprint(r: MemoryRecord): string {
  return sha1(Object.fromEntries(SCAN_CONTENT_FIELDS.map(field => [field, scanFieldValue(r, field)])))
}

/**
 * 记忆行指纹：体检模型那一行里出现的全部字段（SCAN_CONTENT_FIELDS，加记录时间、最新出处的来源方式、归一后的最近一次改动性质）。
 * 体检批的缓存键用它：行里的任一项变了，这一批重发给模型。已裁决冲突各成员的指纹不用它（见 scanContentFingerprint）。
 */
export function scanLineFingerprint(r: MemoryRecord): string {
  const latest = anchorsOf(r)[0]
  return sha1({
    ...Object.fromEntries(SCAN_CONTENT_FIELDS.map(field => [field, scanFieldValue(r, field)])),
    recordedAt: new Date(r.createdAt).toISOString().slice(0, 16) + 'Z',
    sourceMode: latest === undefined ? null : anchorSourceMode(latest),
    lastChange: readChangeKind(r.lastChange?.kind) ?? null,
  })
}

/**
 * 扫描指纹（变更集核对依据用）：交给模型判断的全部字段（SCAN_CONTENT_FIELDS：类型、名称、正文、摘要、事实时间、有效期），加上来源方式、最近一次改动的性质、取代关系。
 * 这些任一项变了，按旧内容做的判断就不算数。标签、注入档位、关联、锁、确认时间不在里面。
 */
export function scanFingerprint(r: MemoryRecord): string {
  const latest = anchorsOf(r)[0]
  return sha1({
    ...Object.fromEntries(SCAN_CONTENT_FIELDS.map(field => [field, scanFieldValue(r, field)])),
    sourceMode: latest === undefined ? null : anchorSourceMode(latest),
    changeKind: r.lastChange?.kind ?? null,
    supersedes: r.supersedes ?? [],
  })
}

/** 记忆的作用域键（同 scope.ts scopeKey）；项目记忆缺路径的定位不到，给空串，和谁都对不上。 */
export function scopeKeyOf(r: Pick<MemoryRecord, 'scope' | 'workspacePath'>): string {
  return r.scope === 'global' ? GLOBAL_SCOPE_KEY : r.workspacePath ?? ''
}

/** 一份副本的身份：同一个 id 在不同作用域里是不同的副本，依据、进度都按它认。 */
export function copyKey(at: { scopeKey: string; memoryId: string }): string {
  return JSON.stringify([at.scopeKey, at.memoryId])
}

/** 从副本身份解析回作用域键和 id；不是 copyKey 写的形状为 undefined。 */
export function parseCopyKey(copy: string): { scopeKey: string; memoryId: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(copy)
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string'
      ? { scopeKey: parsed[0], memoryId: parsed[1] }
      : undefined
  } catch {
    return undefined
  }
}

/** 这一条记忆此刻当依据用的版本。 */
export function basisOf(r: MemoryRecord): OpBasis {
  return { memoryId: r.id, fingerprint: scanFingerprint(r), scopeKey: scopeKeyOf(r) }
}

/**
 * 同一批的进度，按副本（copyKey）记：这批对它写过哪些字段和写下的值，写完后的扫描指纹。后面的操作对写过的字段拿刚写下的值当预期，
 * 依据指纹拿写完后的比；没写过的字段仍按读到时的值比，不整版换基线。
 */
export interface BatchProgress {
  written: Map<string, Map<PatchField, unknown>>
  fingerprints: Map<string, string>
  /** 这一批自己删掉的记忆：后面的操作拿它当依据时不再核对（它不在用是这一批做的）。 */
  forgotten: Set<string>
}

export function newProgress(): BatchProgress {
  return { written: new Map(), fingerprints: new Map(), forgotten: new Set() }
}

/** 一个操作写成之后推进进度：written 是提交的那一版。 */
export function advance(progress: BatchProgress, op: ChangeOp, written: MemoryRecord, fingerprint: (r: MemoryRecord) => string = scanFingerprint): void {
  const key = copyKey(op)
  if (written.status === 'deleted') {
    progress.forgotten.add(key)
    return
  }
  const fields = progress.written.get(key) ?? new Map<PatchField, unknown>()
  for (const field of patchedFields(op)) fields.set(field, fieldValue(written, field))
  progress.written.set(key, fields)
  progress.fingerprints.set(key, fingerprint(written))
}

export function patchedFields(op: ChangeOp): PatchField[] {
  return PATCH_FIELDS.filter(field => op.patch !== undefined && field in op.patch)
}

/**
 * 跳过的原因。unsupported：这一版不落地的操作，或补丁里有这种操作不该带的字段；gone：目标不在了、不在用；
 * moved：目标或依据换了作用域；basis-changed：依据的记忆内容变了、不在用了；field-changed：补丁里的字段已不是读到时的值；
 * foreign-secret：改写稿里带进了原记忆没有的疑似密钥，或有高危密钥；no-change：补丁和现状一样，没有可写的；
 * id-taken：要新建的 id 在那个作用域已经有了。
 */
export type SkipReason = 'unsupported' | 'gone' | 'moved' | 'basis-changed' | 'field-changed' | 'foreign-secret' | 'no-change' | 'id-taken'

export type OpCheck =
  /** 写：fields 是要改的字段和新值（值是 undefined 即清掉）。 */
  | { kind: 'write'; fields: Partial<Record<PatchField, unknown>> }
  /** 关联和前提按增量：这里只说核对过了，增量由执行器对锁内的最新值应用。 */
  | { kind: 'link' }
  | { kind: 'corroborate' }
  | { kind: 'forget' }
  /** 新建：from 是继承的那条（写入段里刚读到的）。 */
  | { kind: 'create'; from: MemoryRecord }
  /** 核对过了，不写（keep）。 */
  | { kind: 'none' }
  | { kind: 'skip'; reason: SkipReason; memoryId: string }

export interface CheckInput {
  /** 写入段里刚读到的目标；定位不到为 undefined。 */
  target: MemoryRecord | undefined
  /** 写入段里刚读到的依据记忆，按副本（copyKey）；定位不到的没有这一项。目标自己不用放。 */
  basis: ReadonlyMap<string, MemoryRecord>
  progress: BatchProgress
  /** 后台写入：改写稿里的疑似密钥只放行原记忆（目标和依据）里已有的。界面里用户亲手定的稿不查这一条。 */
  isSecretChecked: boolean
  /**
   * 依据按什么指纹比；缺省扫描指纹。调用方进写入段之前自己核对过版本、口径比扫描指纹严的（界面按卡片上那一版核对），
   * 给同一个口径：不然进段之前算过期的改动，落在进段前后的空档里就会被放过去。依据里的指纹、进度都得用它算。
   */
  fingerprint?: (r: MemoryRecord) => string
}

const surface = (r: Pick<MemoryRecord, 'content' | 'name' | 'summary' | 'tags'>) => `${r.content}\n${r.name}\n${r.summary}\n${r.tags.join(' ')}`

/**
 * 补丁里的密钥是不是带进来的：有高危密钥，或有疑似密钥的值不在原记忆里（模型编的、截短加长的、从别处带来的）。
 * 给了 target（要写的那条）就连写下去的整条一起查：补丁和没改的字段拼出来的也算带进来的。
 * 按完整的值比，不看标签和分隔符。原记忆里本来就有、用户保存时确认过的疑似值原样保留不算。
 */
export function hasForeignSecret(patch: FieldPatch, originals: readonly MemoryRecord[], target?: MemoryRecord): boolean {
  const parts = [patch.content, patch.name, patch.summary, patch.tags?.join(' ')].filter(part => part !== undefined)
  if (parts.length === 0) return false
  const text = parts.join('\n')
  if (detectSecrets(text).some(hit => hit.severity === 'critical')) return true
  const known = new Set(originals.flatMap(r => secretValues(surface(r), { severity: 'suspected' })))
  if (secretValues(text, { severity: 'suspected' }).some(value => !known.has(value))) return true
  if (target === undefined) return false
  // 补丁单看没有、和目标没改的字段拼在一起才成形的（把中间一个字段清空也会让两边的字段连上）：按写下去的整条再查一遍
  const merged = surface({
    content: patch.content ?? target.content, name: patch.name ?? target.name, summary: patch.summary ?? target.summary, tags: patch.tags ?? target.tags,
  })
  const had = new Set(secretValues(surface(target), { severity: 'critical' }))
  if (secretValues(merged, { severity: 'critical' }).some(value => !had.has(value))) return true
  return secretValues(merged, { severity: 'suspected' }).some(value => !known.has(value))
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
  if (kind === 'link' && (op.links === undefined || isLinkDeltaCrossed(op.links))) return skip('unsupported')
  // 改动的性质只有改内容、改有效期的操作能声明，补证走它自己的操作
  if (op.change !== undefined && (op.change === 'corroborate' || (kind !== 'edit' && kind !== 'set-validity'))) return skip('unsupported')
  const own = copyKey(op)
  const inBasis = (ref: { memoryId: string; scopeKey: string }) => op.basis.some(b => copyKey(b) === copyKey(ref))
  // 去向只有删除能带，指的是别的一条、且在依据里（它变了这次合并就不算数）
  if (op.into !== undefined && (kind !== 'forget' || copyKey(op.into) === own || !inBasis(op.into))) return skip('unsupported')
  const isCreate = kind === 'create'
  if (isCreate !== (op.from !== undefined) || isCreate !== (op.draft !== undefined)) return skip('unsupported')
  // 新建的那条落在它继承的那条所在的作用域（继承的字段里就有作用域）：两边不一致的不收
  if (isCreate && (op.links !== undefined || !inBasis(op.from!) || op.from!.scopeKey !== op.scopeKey || copyKey(op.from!) === own)) return skip('unsupported')

  const { target, progress } = input
  if (isCreate) {
    if (target !== undefined) return skip('id-taken')
  } else {
    if (target === undefined || target.status !== 'active') return skip('gone')
    // 目标自己必须在依据里：没有它，目标读到时的版本和作用域无从核对
    if (!inBasis(op)) return skip('unsupported')
  }
  for (const basis of op.basis) {
    const key = copyKey(basis)
    // 这一批自己删掉的依据不再核对；但要继承的那条、要并进去的那条必须还在用
    const isNeededLive = (op.from !== undefined && copyKey(op.from) === key) || (op.into !== undefined && copyKey(op.into) === key)
    if (progress.forgotten.has(key) && key !== own && !isNeededLive) continue
    const record = key === own ? target : input.basis.get(key)
    if (record === undefined || record.status !== 'active') return skip('basis-changed', basis.memoryId)
    if (scopeKeyOf(record) !== basis.scopeKey) return skip('moved', basis.memoryId)
    const expected = progress.fingerprints.get(key) ?? basis.fingerprint
    if ((input.fingerprint ?? scanFingerprint)(record) !== expected) return skip('basis-changed', basis.memoryId)
  }
  const written = progress.written.get(own)
  for (const field of fields) {
    const expected = written?.has(field) === true ? written.get(field) : normalized(field, op.expect?.[field])
    if (target === undefined || !isDeepStrictEqual(fieldValue(target, field), expected)) return skip('field-changed')
  }

  if (isCreate) {
    const from = input.basis.get(copyKey(op.from!))!
    // 疑似密钥只放行继承的那条里已有的，别的依据里的不算
    if (input.isSecretChecked && hasForeignSecret(op.draft!, [from])) return skip('foreign-secret')
    return { kind: 'create', from }
  }
  if (target === undefined) return skip('gone')
  if (kind === 'keep') return { kind: 'none' }
  if (kind === 'forget') return { kind: 'forget' }
  if (kind === 'corroborate') return { kind: 'corroborate' }
  if (kind === 'link') return { kind: 'link' }
  if (input.isSecretChecked && kind === 'edit' && hasForeignSecret(op.patch ?? {}, [target, ...input.basis.values()], target)) return skip('foreign-secret')
  const changed = fields.filter(field => !isDeepStrictEqual(fieldValue(target, field), normalized(field, op.patch![field])))
  if (changed.length === 0) return skip('no-change')
  // 只写确实要变的字段：回执和撤销都按它们算
  return { kind: 'write', fields: Object.fromEntries(changed.map(field => [field, op.patch![field] ?? undefined])) }
}

/** 同一个 id 既要加又要去：算不出这次到底加了还是去了，回执会记下没发生的事。 */
function isLinkDeltaCrossed(links: NonNullable<ChangeOp['links']>): boolean {
  const crossed = (add: readonly string[] | undefined, remove: readonly string[] | undefined) => (add ?? []).some(id => (remove ?? []).includes(id))
  return crossed(links.add?.related, links.remove?.related) || crossed(links.add?.premises, links.remove?.premises)
}

/** 新建的那条在回执里记摘要的字段：撤销时凭它们判断还是不是这次写下的样子。 */
export const CREATE_RECEIPT_FIELDS = ['name', 'summary', 'content', 'tags'] as const satisfies readonly ReceiptField[]

/**
 * 新建的那条（拆分）：内容是稿里的，类型、作用域、出处清单、置信度、事实时间、有效期、待确认身份、注入档位从 from 继承；
 * 锁、关联和前提、取代关系、最近一次内容改动、状态起点不继承。创建、修改、确认时间是这次的时刻。
 */
export function createdFrom(from: MemoryRecord, draft: CreateDraft, id: string, at: number): MemoryRecord {
  const inherited = Object.fromEntries((['workspacePath', 'sourceTrail', 'factTime', 'validFrom', 'validTo', 'delegation', 'recall', 'globalCandidate'] as const)
    .flatMap(key => (from[key] === undefined ? [] : [[key, from[key]]])))
  return {
    id, type: from.type, scope: from.scope, source: from.source, confidence: from.confidence,
    ...inherited, ...draft,
    createdAt: at, updatedAt: at, lastConfirmedAt: at, lastRecalledAt: null, recallCount: 0, status: 'active',
  } as MemoryRecord
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
  // 种类和字段名开放取值：更新的版本记的回执这一版照样读得进、写得回，只是撤不了（见 revertBlock 的 unsupported）
  kind: z.string(),
  fields: z.array(z.string()),
  after: z.record(z.string(), z.string()),
  status: z.enum(['active', 'deleted']),
  scopeKey: z.string(),
  snapshotId: z.string().optional(),
  links: z.object({ added: linkIdsSchema, removed: linkIdsSchema }).optional(),
  isContent: z.boolean(),
  trail: z.string(),
  confirmedAt: z.number(),
  /** 删除的回执：写下的删除时刻。撤销时对不上，说明期间被恢复过、又被别处删了一次。 */
  deletedAt: z.number().optional(),
  /** 属于哪一组（见 ChangeOp.group）；没做完的组按它找出已做的几步撤回。 */
  group: z.string().optional(),
})
export type ChangeReceipt = z.infer<typeof changeReceiptSchema>

/** 写成之后算回执：written 是提交的那一版。 */
export function receiptOf(
  input: { id: string; op: string; kind: ChangeOpKind; fields: readonly ReceiptField[]; snapshotId?: string; links?: { added: LinkIds; removed: LinkIds }; group?: string },
  written: MemoryRecord,
): ChangeReceipt {
  return {
    id: input.id, op: input.op, memoryId: written.id, kind: input.kind,
    fields: [...input.fields],
    after: Object.fromEntries(input.fields.map(field => [field, fieldDigest(written, field)])),
    status: written.status === 'deleted' ? 'deleted' : 'active',
    scopeKey: scopeKeyOf(written),
    ...(written.status === 'deleted' && written.deletedAt !== undefined ? { deletedAt: written.deletedAt } : {}),
    ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
    ...(input.links !== undefined ? { links: input.links } : {}),
    // 新建的回执记了内容字段的摘要，但它不是一次内容改动：撤销是把这条删掉，不按最近一次内容改动核对
    isContent: input.kind !== 'create' && input.fields.some(field => (CONTENT_PATCH_FIELDS as readonly string[]).includes(field)),
    trail: trailDigest(written),
    confirmedAt: written.lastConfirmedAt,
    ...(input.group !== undefined ? { group: input.group } : {}),
  }
}

/**
 * 撤不了的原因。gone：记忆不在了；status：状态已不是这次操作后的样子（期间被软删、被恢复、被取代）；moved：换了作用域；
 * field-changed：补丁里的字段已不是这次写下的值；overwritten：内容之后又被别的操作改过；corroborated：期间出处清单变了（被补证过）；
 * expired：改前的值已不在快照里；unsupported：更新的版本记的回执，种类或字段这一版不认识。
 */
export type RevertBlock = 'gone' | 'status' | 'moved' | 'field-changed' | 'overwritten' | 'corroborated' | 'expired' | 'unsupported'

/**
 * 这条回执此刻撤不撤得了：返回 undefined 是能撤。current 是写入段里刚读到的那一版，before 是改前快照里的。
 * 确认时间不参与；关联和前提按增量撤，期间别人加的不挡它。删除的回执只看状态。
 */
export function revertBlock(receipt: ChangeReceipt, current: MemoryRecord | undefined, before: MemoryRecord | undefined): RevertBlock | undefined {
  if (!(CHANGE_OP_KINDS as readonly string[]).includes(receipt.kind) || receipt.fields.some(field => !(RECEIPT_FIELDS as readonly string[]).includes(field))) return 'unsupported'
  if (current === undefined) return 'gone'
  if (current.status !== receipt.status) return 'status'
  if (scopeKeyOf(current) !== receipt.scopeKey) return 'moved'
  if (receipt.kind === 'forget') {
    if (receipt.deletedAt !== undefined && current.deletedAt !== receipt.deletedAt) return 'status'
    return receipt.snapshotId !== undefined && before === undefined ? 'expired' : undefined
  }
  if (receipt.fields.some(field => fieldDigest(current, field as ReceiptField) !== receipt.after[field])) return 'field-changed'
  if (receipt.kind === 'create') return undefined
  if (receipt.isContent && current.lastChange?.op !== receipt.op) return 'overwritten'
  const touchesTrail = receipt.isContent || receipt.kind === 'corroborate'
  if (touchesTrail && trailDigest(current) !== receipt.trail) return 'corroborated'
  // 拍过改前快照的回执都要它：改前的值、删之前的修改时间、去掉的前提当时的摘要都从那里取
  if (receipt.snapshotId !== undefined && before === undefined) return 'expired'
  return undefined
}

const without = (ids: readonly string[] | undefined, drop: readonly string[]) => (ids ?? []).filter(id => !drop.includes(id))

/**
 * 撤销还原成什么：刚读到的那一版，只把这次改的字段改回改前的值。改了内容的把最近一次内容改动、修改时间、状态起点、出处清单
 * 一起还原成快照里那份；确认时间还是这次写下的值才改回。关联和前提按增量：它加的还在就去掉，它去掉的还没回来就加回。
 * 期间别处改的注入档位、锁、关联原样留着。删除的撤销把状态放回在用、修改时间改回删之前的、去掉并入的去向。
 * 新建的撤销是把那条软删（删除时刻由执行器补）。
 */
export function reverted(receipt: ChangeReceipt, current: MemoryRecord, before: MemoryRecord | undefined): MemoryRecord {
  if (receipt.kind === 'create') return { ...current, status: 'deleted' }
  if (receipt.kind === 'forget') {
    const { deletedAt: _deletedAt, mergedInto: _mergedInto, ...rest } = current
    return { ...rest, status: 'active', updatedAt: before?.updatedAt ?? current.updatedAt }
  }
  const next: Record<string, unknown> = { ...current }
  const restore = (key: keyof MemoryRecord) => {
    if (before?.[key] === undefined) delete next[key]
    else next[key] = before[key]
  }
  for (const field of receipt.fields) restore(field as ReceiptField)
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

/**
 * 一组回执逆序整批撤之前先推演一遍：每条记忆从现状起，按回执从后往前逐个核对、还原，后一个撤完前一个才对得上。
 * 任何一条撤不了就返回它和原因，调用方据此整批不动；都撤得了返回 undefined。current、before 由调用方读好给进来。
 */
export function firstRevertBlock(
  receipts: readonly ChangeReceipt[],
  current: (receipt: ChangeReceipt) => MemoryRecord | undefined,
  before: (receipt: ChangeReceipt) => MemoryRecord | undefined,
): { receipt: ChangeReceipt; block: RevertBlock } | undefined {
  const state = new Map<string, MemoryRecord | undefined>()
  for (const receipt of [...receipts].reverse()) {
    const key = copyKey(receipt)
    const now = state.has(key) ? state.get(key) : current(receipt)
    const prior = before(receipt)
    const block = revertBlock(receipt, now, prior)
    if (block !== undefined || now === undefined) return { receipt, block: block ?? 'gone' }
    state.set(key, reverted(receipt, now, prior))
  }
  return undefined
}
