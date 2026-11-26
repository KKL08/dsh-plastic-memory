import { createHash } from 'node:crypto'
import { isExpired } from './record-freshness.ts'
import { applyEdits, type SaveEdit } from './edits.ts'
import type { ChangeKind, MemoryRecord, SourceMode } from './record-schema.ts'
import type { CodedNote, RejectCode, WarningCode } from './contract-codes.ts'
import { ALREADY_REVIEWED_REASON, CHANGE_KINDS, CONFIDENCE_BY_SOURCE, NOT_DELEGATED_REASON, isPendingDelegated, isFactTime, memoryRecordSchema } from './record-schema.ts'
import { applyChange, CHANGE_KIND_QUESTIONS, initialProvenance, type ChangeAnchor, type ChangeFields } from './change.ts'
import { commitChange, isSameRecord, type RelatedRecheckHook } from './commit-change.ts'
import { UNKNOWN_SESSION_ID } from './session-id.ts'
import { anchorRangeOf, type AnchorFacts } from './session-log.ts'
import type { MemoryStore, QueryScope } from './store.ts'
import { newWriteOp, type TopicIntent } from './storage/table.ts'
import { INDEX_RECEIPT_STEP, indexReceiptStep, LINK_CHANGE_STEP, MODEL_CHANGE_STEP, ledgerSteps, linkChangeStep, modelChangeStep } from './governance/op-steps.ts'
import { linkShapeProblem, mergeLinks, resolveLinks, type ResolvedLinks } from './links.ts'
import { ledgerLabel, scopeOfMemory, type Scope } from './scope.ts'
import type { TypeRegistry } from './type-registry.ts'
import type { PendingDecisionsStore } from './governance/decisions.ts'
import type { SnapshotStore } from './governance/snapshots.ts'
import { maskSecrets, detectSecrets, maskSecretSurface } from './secrets.ts'
import { RecordNotFoundError } from './errors.ts'
import { runCreateGate, type SimilarMemory } from './create-gate.ts'
import type { QueryTokenizerOptions } from './search/jieba-segmenter.ts'
import { lostFacts, refineRemoval, factsDroppedText, refineShrankText, turnThirdSaveText, contentLongText, TURN_CREATE_HINT_AT, isContentLong, type SaveHints } from './save-signals.ts'
import { toToolOutput } from './output.ts'
import { VALIDITY_DATE_FORMAT, VALIDITY_FORMAT, formatValidity, parseValidityInput, roundValidity } from './validity.ts'
import * as topicText from './save-signals.ts'
import { INDEX_ROW_STEP } from './storage/file-table.ts'
import { INDEX_MAX_TOPICS_DEFAULT, resolveTopic, nearestTopics, topicNameProblem, readIndex, entryTopics, keyOf, UNSORTED_TITLE, type IndexFiles } from './topic-index.ts'
import type { IndexPlan } from './topic-ops.ts'

export interface SaveCandidate {
  action: 'create' | 'update'
  id?: string
  name: string
  type: string
  scope: 'global' | 'workspace'
  content: string
  summary: string
  tags: string[]
  sourceMode: SourceMode
  confidence?: number
  supersedes?: string[]
  /** 本机时间 YYYY-MM-DD HH:mm，或 YYYY-MM-DD（补写入时刻的时分）；落库前换算成毫秒（validity.ts）。 */
  validFrom?: string
  validTo?: string
  /** 事实发生或成立的时间，按原精度保存；update 空字符串清除。 */
  factTime?: string
  /** 新建时跳过接近逐字重复的检查（模型确认是另一件事）。 */
  force?: boolean
  /** 放行疑似密钥（用户确认不是密钥）；高危密钥照拦。 */
  allowSecret?: boolean
  /** update 的目标是全局记忆时，模型确认这次改动对所有项目都成立：填引导里给的确认码（见 globalConfirmCode）；项目会话里不带或不对就回引导、不写入。 */
  confirmGlobal?: string
  /** update 必填：这次改动的性质，决定旧内容怎么处置（见 CHANGE_GUIDE）。create 不用。 */
  change?: ChangeKind
  /** 状态变化的原因，随历史版本留着。 */
  changeReason?: string
  /** 相关记忆的 id：追加在已有的后面，不删已有。只传它（和 premises）的 update 是只改元数据的操作，不用填 change。 */
  related?: string[]
  /** 决定依据的前提：被依据记忆的 id；插件记下 id 和那条记忆当时的内容摘要。追加规则同 related。 */
  premises?: string[]
  /** 这条记忆归哪个主题：现有主题名或它的曾用名（去首尾空白、不分大小写），没有就新建。新建和更新都能带；只传它的 update 是一次索引操作，不写记忆文件。 */
  topic?: string
  /** 新建主题时的一句说明；topic 指向现有主题、或没给 topic 时不生效。 */
  topicAbout?: string
}

export type { SaveEdit } from './edits.ts'

/** 整条写入才必填的字段：精确修改（edits）时都可省，省掉的沿用目标记忆的。 */
type WholeWriteKey = 'name' | 'type' | 'scope' | 'content' | 'summary' | 'tags'
/** 写入管线的入参（memory_save 的参数）：整条写入的必填项由 resolveInput 按 action 校验；tags 缺省按空数组。 */
export type SaveInput = Omit<SaveCandidate, WholeWriteKey> & Partial<Pick<SaveCandidate, WholeWriteKey>> & { edits?: SaveEdit[] }

/**
 * 子 agent 会话的委派上下文：深度、直接父会话取自宿主 header，根会话沿父链解析（解析不到缺省），
 * mode 现读宿主 subagent 投影、不落盘。只来自宿主，不来自工具参数；主会话没有这一块。
 */
export interface SaveDelegation {
  depth: number
  parentSessionId: string
  rootSessionId?: string
  mode: 'one-shot' | 'continuable'
}

export type PipelineResult =
  | { kind: 'saved'; record: MemoryRecord; warnings?: SaveWarning[]; similar?: SimilarMemory[] }
  | { kind: 'updated'; record: MemoryRecord; warnings?: SaveWarning[] }
  /** isFromSubagent：子 agent 撞上主档，改不了也不能 force，结果文案改为让它向委派方说明分歧。 */
  | { kind: 'duplicate-suspected'; existing: SimilarMemory; isFromSubagent?: true }
  | { kind: 'rejected'; code: RejectCode; reason: string; subcode?: SaveRejectSubcode }

/**
 * 同一个拒绝码下再分的内部子码：只给测试和日志区分分支，不是工具契约的稳定标识符（稳定码见 contract-codes.ts）。
 * changed-after-read：update 读到目标之后、写入之前，目标被别处改过或删掉了，这次没写。
 * target-superseded：update 的目标已被取代（回 target-missing），原因指出取代它的那条。
 * subagent-*：子 agent 写入约束的各条（都回 subagent-restricted），见 checkSubagentWrite。
 */
export type SaveRejectSubcode =
  | 'changed-after-read'
  | 'target-superseded'
  | 'subagent-source-mode'
  | 'subagent-type'
  | 'subagent-supersedes'
  | 'subagent-force'
  | 'subagent-allow-secret'
  | 'subagent-target-gone'
  | 'subagent-not-own'
  | 'subagent-quota'

/** 保存成功但要提醒模型/用户的事：code 稳定、text 可改。 */
export type SaveWarning = CodedNote<WarningCode>

/**
 * 深度剔除值为 undefined 的键。MemoryRecord 的可选字段（workspacePath/validFrom/
 * validTo/supersedes 等）不填时为 undefined，zod .optional() 会把这些键连值保留，
 * 使记录无法无损 JSON 序列化。dsh 工具输出要求 lossless JSON——save 返回带 undefined
 * 键的记录会被框架以 "value is not lossless JSON" 拒绝。put 前也剔除，保证内存缓存干净。
 * 走工具出口同一套深度剔除（output.ts），单一来源；记录已过 zod 校验、只余 undefined
 * 可选键，toToolOutput 不会抛错，返回值仍是合法 MemoryRecord（去掉可选键仍满足接口）。
 */
function pruneUndefined(record: MemoryRecord): MemoryRecord {
  return toToolOutput(record) as unknown as MemoryRecord
}

/**
 * 确认码位数。这道确认是让模型停一下、想清楚再改全局，不是安全边界。码现算不存，不同记忆、改写前后的码可能偶然相同：
 * 四位让抄串、用旧码这类拿错码的情况几乎碰不对。
 */
const CONFIRM_CODE_DIGITS = 4
const CONFIRM_CODE_MODULUS = 10 ** CONFIRM_CODE_DIGITS
const CONFIRM_CODE_INPUT = new RegExp(`^\\d{1,${CONFIRM_CODE_DIGITS}}$`)

/** 键排序后序列化：对象字段的先后取决于构造方式（新写入的记录和从文件读回的不同），指纹只看值。 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v)
}

/**
 * 项目会话改写全局记忆的确认码：按会话 id 和目标记录现算，不存。引导里给出，模型带着它重发才写。
 * 指纹覆盖改写和手改会动的字段；召回统计和 lastConfirmedAt 不算，召回、确认不让码失效。改写成功后 updatedAt 变了，
 * 同一条再改要新码；换了会话（包括压缩后开的新会话）码也跟着换。不同记忆的码撞上无所谓：每次只和这一条的码比。
 */
export function globalConfirmCode(sessionId: string, target: MemoryRecord): string {
  const r = target
  const fingerprint = [
    r.id, r.name, r.summary, r.content.replace(/\r\n/g, '\n'), r.tags, r.type, r.scope, r.workspacePath, r.status,
    r.validFrom === undefined ? undefined : roundValidity('validFrom', r.validFrom),
    r.validTo === undefined ? undefined : roundValidity('validTo', r.validTo),
    r.confidence, r.supersedes, r.source, r.createdAt, r.updatedAt, r.globalCandidate, r.delegation, r.deletedAt,
  ].map(v => v ?? null)
  const hex = createHash('sha256').update(canonicalJson([sessionId, fingerprint])).digest('hex').slice(0, 8)
  return String(Number.parseInt(hex, 16) % CONFIRM_CODE_MODULUS).padStart(CONFIRM_CODE_DIGITS, '0')
}

/** 模型填的确认码对不对：不足位数的按补零算（模型常把 "0007" 写成 "7"），其余写法都不认。 */
function isConfirmCodeMatch(given: string | undefined, code: string): boolean {
  const text = typeof given === 'string' ? given.trim() : ''
  return CONFIRM_CODE_INPUT.test(text) && text.padStart(CONFIRM_CODE_DIGITS, '0') === code
}

/** 引导文字里点名一条记忆用的名称：会进模型上下文，疑似密钥也遮；压成一行。 */
const guideName = (r: MemoryRecord) => maskSecretSurface(r, { severity: 'suspected' }).name.replace(/\s+/g, ' ').trim()

/**
 * 项目会话里改全局记忆、确认码缺省或不对时回给模型的引导（renderSaveResult 前面接「未保存：」）。点名这条记忆、带上它现在的码，
 * 同时改几条时模型分得清哪个码给哪条；码不对时先说明，模型照着新码重发一次就能写。
 */
export function globalUpdateGuide(target: MemoryRecord, code: string, given: string | undefined): string {
  const name = guideName(target)
  const stale = given === undefined ? '' : `确认码 ${JSON.stringify(given)} 不是这条记忆现在的码（码按会话和记忆的当前内容生成，改过或换了会话就会变）。`
  return `${stale}「${name}」（${target.id}）是全局记忆，改动会影响所有项目。只适用于本项目的内容，改用 action=create、scope=workspace 另存一条项目记忆，全局这条保持原样；`
    + `确认仍适用于所有项目，对这条记忆重发这次 update，并填写 confirmGlobal: "${code}"。`
}

type ValidityKey = 'validFrom' | 'validTo'

/**
 * 有效期入参换算与校验。传了的照写（只有日期补写入时刻的时分）；只传 validTo（截止时间）时起点沿用 target 的，
 * 没有就记写入时刻（到分钟）；没传的 update 保留 target 值，create 不加。validTo 不晚于现在、不晚于 validFrom 都拒——
 * 后者按生效的两个值比，只在这次传了有效期时查。
 */
function resolveValidity(
  candidate: SaveCandidate,
  target: MemoryRecord | undefined,
  now: number,
): { validFrom?: number; validTo?: number } | { code: RejectCode; reason: string } {
  const given: Partial<Record<ValidityKey, number>> = {}
  for (const key of ['validFrom', 'validTo'] as const) {
    const value: unknown = candidate[key]
    if (value === undefined) continue
    const parsed = parseValidityInput(value, now)
    if (!parsed.ok) {
      const shown = `${key}=${JSON.stringify(value)}`
      return {
        code: parsed.code,
        reason: parsed.code === 'validity-format'
          ? `${shown} 格式不对。有效期写本机时间 "${VALIDITY_FORMAT}"（如 "2026-11-05 18:00"）；用户没说具体时刻就只写日期 "${VALIDITY_DATE_FORMAT}"，时分由插件补成现在。不带秒、不带时区、不写数字。改好后重发。`
          : `${shown} 的日期或时刻不存在，核对后重发。`,
      }
    }
    given[key] = parsed.ms
  }
  if (given.validTo !== undefined && isExpired(given, now)) {
    return {
      code: 'validity-past',
      reason: `validTo=${formatValidity(given.validTo)} 不晚于现在（${formatValidity(now)}），存下就已过期。核对用户说的截止时间（年份、上午下午）后重发；截止在当天的，写出具体时刻 "${VALIDITY_FORMAT}"——只写日期会把时分补成现在。`,
    }
  }
  const validFrom = given.validFrom ?? target?.validFrom ?? (given.validTo !== undefined ? new Date(now).setSeconds(0, 0) : undefined)
  const validTo = given.validTo ?? target?.validTo
  const isGiven = given.validFrom !== undefined || given.validTo !== undefined
  if (isGiven && validFrom !== undefined && validTo !== undefined && validTo <= validFrom) {
    const kept = (key: ValidityKey) => given[key] === undefined ? '（原记忆的）' : ''
    return {
      code: 'validity-reversed',
      reason: `validTo=${formatValidity(validTo)}${kept('validTo')} 不晚于 validFrom=${formatValidity(validFrom)}${kept('validFrom')}，有效期为空。核对两个时间后重发。`,
    }
  }
  return { validFrom, validTo }
}

type PipelineDeps = Parameters<typeof runSavePipeline>[1]
type Rejection = { code: RejectCode; subcode?: SaveRejectSubcode; reason: string }

/**
 * update 目标能不能改，能改时原样交回：不存在、已删除回 target-missing；workspace 记忆只能在其所属项目里更新（deps.workspacePath 为 undefined
 * 的无 cwd 会话也落此拦截），global 目标不受限——例行维护全局记忆是设计意图（快照先行兜底）。
 * 已被取代的也回 target-missing：它不再带入，改了用不上、也撤不了，原因指出取代它的那条。只有这一支多读一次存储。
 * 子 agent 会话不走这一支：它改不了别人的记录，指路也照做不了，交给归属检查和写入段里的复核。
 */
async function checkUpdateTarget(id: string | undefined, target: MemoryRecord | undefined, deps: Pick<PipelineDeps, 'store' | 'workspacePath' | 'delegation'>): Promise<{ target: MemoryRecord } | Rejection> {
  const { workspacePath } = deps
  if (!target || target.status === 'deleted') {
    return { code: 'target-missing', reason: `更新目标不存在或已删除：${id ?? '(缺 id)'}` }
  }
  if (target.scope === 'workspace' && target.workspacePath !== workspacePath) {
    return { code: 'cross-workspace', reason: `不能跨项目修改其他 workspace 的记忆：目标属于 ${target.workspacePath ?? '(未知项目)'}，当前会话在 ${workspacePath ?? '(无工作目录)'}。请在该项目的会话里更新。` }
  }
  if (target.status === 'superseded' && deps.delegation === undefined) {
    return { code: 'target-missing', subcode: 'target-superseded', reason: await supersededGuide(target, deps.store) }
  }
  return { target }
}

/** 已被取代的目标最多列几条取代者。 */
const SUCCESSOR_LIMIT = 3

/**
 * 更新目标已被取代时回给模型的原因：列出同一作用域里取代它的在用记忆，让模型改去更新那条；找不到就请它先检索。
 */
async function supersededGuide(target: MemoryRecord, store: MemoryStore): Promise<string> {
  const scope: QueryScope = target.scope === 'workspace' ? { kind: 'workspace', workspacePath: target.workspacePath ?? '' } : { kind: 'global' }
  const successors = (await store.query({ scope, status: ['active'] }))
    .filter(r => r.supersedes?.includes(target.id))
    .slice(0, SUCCESSOR_LIMIT)
  const head = `记忆 ${target.id} 已被取代，不再使用。`
  if (successors.length === 0) return `${head}先用 memory_search 找到在用的那条，再对它重发这次 update。`
  const listed = successors
    .map(r => `「${guideName(r)}」（${r.id}）`)
    .join('、')
  return `${head}取代它的是${listed}；把 id 换成${successors.length > 1 ? '其中要改的那条' : '它'}，重发这次 update。`
}

const WHOLE_WRITE_REQUIRED = ['name', 'type', 'scope', 'content', 'summary'] as const
/** 精确修改没传时沿用目标的字段。 */
const INHERITED_KEYS = ['name', 'type', 'summary', 'tags'] as const
type InheritedKey = typeof INHERITED_KEYS[number] | 'content'

/**
 * 在目标正文上应用 edits（见 edits.ts），不成立时换成给模型的拒绝原因。
 * 原因会进模型上下文：附上的当前正文按注入的口径遮明确密钥（和模型平时读到的同一份，照着摘 oldString 才对得上）。
 */
function editTarget(target: MemoryRecord, edits: readonly SaveEdit[]): { content: string } | Rejection {
  const outcome = applyEdits(target.content, edits)
  if ('content' in outcome) return outcome
  const nth = outcome.index + 1
  if (outcome.failure === 'ambiguous') {
    return { code: 'edit-ambiguous', reason: `第 ${nth} 处修改的 oldString 在正文里出现 ${outcome.count} 次，未保存。多带一些前后文让它只命中一处；确实要全部替换就加 replaceAll: true。` }
  }
  const after = outcome.index > 0 ? '（从第 2 处起，匹配的是前面几处改完的正文）' : ''
  return {
    code: 'edit-not-found',
    reason: `第 ${nth} 处修改的 oldString 在正文里找不到${after}，未保存。oldString 要从当前正文原样摘取，标点、空格、换行都要一致。当前正文是：\n${maskSecretSurface(target).content}`,
  }
}

/**
 * 把入参补成完整的候选。整条写入：校验必填项，tags 缺省按空数组。精确修改：只能配 update、不能和 content 同传；
 * 读到目标后在它的正文上应用 edits，没传的字段沿用目标的（inherited 列出是哪几个），返回的 base 就是这份读数。
 * 写入时锁内读到的正文和 base 不一样，就拿 edits 在最新正文上重做一次，沿用的字段也取最新的。
 * update 带 factTime、没带 content 和 edits 时，正文沿用锁内最新版；同传的其他字段照常应用。
 */
async function resolveInput(input: SaveInput, deps: PipelineDeps): Promise<{ candidate: SaveCandidate; base?: MemoryRecord; ignored?: string[]; edits?: readonly SaveEdit[]; inherited?: readonly InheritedKey[] } | Rejection> {
  const { edits, ...rest } = input
  if (input.action === 'update' && input.change === 'corroborate') return resolveCorroboration(input, deps)
  const keepsContent = input.action === 'update' && input.factTime !== undefined && input.content === undefined && edits === undefined
  if (edits === undefined && !keepsContent) {
    const missing = WHOLE_WRITE_REQUIRED.filter(k => rest[k] === undefined)
    if (missing.length > 0) {
      const hint = input.action === 'update' && missing.includes('content') ? '。只改正文里的几处时传 edits，name、summary 等不传就保留原值' : ''
      return { code: 'schema-invalid', reason: `action=${input.action} 缺少 ${missing.join('、')}${hint}` }
    }
    return { candidate: { ...rest, tags: rest.tags ?? [] } as SaveCandidate }
  }
  const invalid = (reason: string): Rejection => ({ code: 'edit-invalid', reason: `${reason}未保存。` })
  if (input.action !== 'update') return invalid('edits 只用于 action=update，新建记忆传整条 content。')
  if (rest.content !== undefined) return invalid('edits 和 content 只能传一个：改几处传 edits，重写整条传 content。')
  if (edits?.length === 0) return invalid('edits 是空的，至少写一处修改。')
  for (const [i, edit] of (edits ?? []).entries()) {
    if (edit.oldString === '') return invalid(`第 ${i + 1} 处修改的 oldString 是空的：写出要替换的那段原文；要在某处加内容，把那处原文写进 oldString，newString 写原文加上新内容。`)
    if (edit.oldString === edit.newString) return invalid(`第 ${i + 1} 处修改的 oldString 和 newString 一样，没有改动。`)
  }
  const read = input.id === undefined ? undefined : await deps.store.get(input.id, { workspacePath: deps.workspacePath })
  // 子 agent 先看能不能改这条，再比对原文：改不了的不回找不到原文、不贴正文让它重试
  const notWritable = deps.delegation ? subagentTargetProblem(input.id ?? '(缺 id)', read, deps.session.id) : undefined
  if (notWritable !== undefined) return notWritable
  const checked = await checkUpdateTarget(input.id, read, deps)
  if ('code' in checked) return checked
  const { target } = checked
  const applied = edits === undefined ? { content: target.content } : editTarget(target, edits)
  if ('code' in applied) return applied
  const candidate: SaveCandidate = {
    ...rest,
    name: rest.name ?? target.name,
    type: rest.type ?? target.type,
    scope: rest.scope ?? target.scope,
    summary: rest.summary ?? target.summary,
    tags: rest.tags ?? target.tags,
    content: applied.content,
  }
  return { candidate, base: target, edits, inherited: [...INHERITED_KEYS.filter(k => rest[k] === undefined), ...(keepsContent ? ['content' as const] : [])] }
}

/** 补证时不生效的参数：正文和别的内容字段都留着原样。 */
const CORROBORATE_IGNORED = ['name', 'type', 'content', 'edits', 'summary', 'tags', 'supersedes', 'validFrom', 'validTo', 'factTime', 'related', 'premises'] as const

/**
 * 补证（同一件事又被提到，内容不用改）：只要 id、依据和把握。内容参数不校验、不生效，候选按目标现在的样子补齐，
 * 后面的检查都按目标自己的字段走；带了内容参数的在结果里说明。
 */
async function resolveCorroboration(input: SaveInput, deps: PipelineDeps): Promise<{ candidate: SaveCandidate; base: MemoryRecord; ignored: string[] } | Rejection> {
  const read = input.id === undefined ? undefined : await deps.store.get(input.id, { workspacePath: deps.workspacePath })
  const notWritable = deps.delegation ? subagentTargetProblem(input.id ?? '(缺 id)', read, deps.session.id) : undefined
  if (notWritable !== undefined) return notWritable
  const checked = await checkUpdateTarget(input.id, read, deps)
  if ('code' in checked) return checked
  const { target } = checked
  const candidate: SaveCandidate = {
    action: 'update', id: input.id, change: 'corroborate', sourceMode: input.sourceMode, confidence: input.confidence, confirmGlobal: input.confirmGlobal,
    name: target.name, type: target.type, scope: target.scope, content: target.content, summary: target.summary, tags: target.tags, topic: input.topic, topicAbout: input.topicAbout,
  }
  return { candidate, base: target, ignored: CORROBORATE_IGNORED.filter(k => input[k] !== undefined) }
}

/** 缺改动性质的引导里，当前正文最多带多少字符。 */
const CHANGE_GUIDE_CONTENT_LIMIT = 2000

/**
 * update 没声明改动性质时回给模型的引导（renderSaveResult 前面接「未保存：」）：带上这条记忆现在的内容和三个判断问题，
 * 模型照着判完带 change 重发。内容会进模型上下文：先对整条遮密钥（疑似的也遮）、再限长，截断后的密钥规则认不出来。
 */
export function changeKindGuide(target: MemoryRecord, given: unknown): string {
  const masked = maskSecretSurface(target, { severity: 'suspected' })
  const body = masked.content.length > CHANGE_GUIDE_CONTENT_LIMIT
    ? `${masked.content.slice(0, CHANGE_GUIDE_CONTENT_LIMIT)}\n（正文共 ${masked.content.length} 字符，以上是前 ${CHANGE_GUIDE_CONTENT_LIMIT} 个）`
    : masked.content
  const head = given === undefined
    ? '更新记忆要用 change 声明这次改动的性质'
    : `change=${JSON.stringify(given)} 不是可用的取值，可用：${CHANGE_KINDS.join('、')}`
  return `${head}。「${masked.name.replace(/\s+/g, ' ').trim()}」（${target.id}）现在的内容是：\n${body}\n`
    + `对照它依次判断：\n${CHANGE_KIND_QUESTIONS}\n`
    + '带上 change 重发这次 update。'
}

/** 子 agent 能用的依据：它收到的指令来自委派方，用户明说、用户行为、经用户确认的动作都无从谈起。 */
const SUBAGENT_SOURCE_MODES: readonly SourceMode[] = ['environment-observed', 'agent-inferred']
/** 子 agent 能写的类型（还要在当前场景里）：事实，和观察到的项目状态。 */
const SUBAGENT_TYPES = ['knowledge', 'project']
/** 每个子会话最多新建几条：配置项 subagent.maxSavesPerSession 的缺省值，工具说明照它写。 */
export const SUBAGENT_MAX_SAVES_DEFAULT = 10

/**
 * update 写入那一刻发现目标不在读到时的位置了（被删、归档、取代、提升、移走，或落盘前被不拿锁的手改换掉）：按目标此刻的样子回拒绝。原因会进模型上下文，当前内容按注入的口径遮明确密钥。
 * 子 agent 照旧回 subagent-restricted、带回主会话；主会话回 target-missing。
 */
function changedAfterRead(id: string, current: MemoryRecord | undefined, isFromSubagent: boolean): PipelineResult {
  if (isFromSubagent) {
    return { kind: 'rejected', code: 'subagent-restricted', subcode: 'changed-after-read', reason: `记忆 ${id} 在读取之后被改过（可能已被接受、删除或提升为全局），这次没写；要改的内容带回主会话。` }
  }
  const subcode = 'changed-after-read'
  if (current === undefined || current.status === 'deleted') {
    return { kind: 'rejected', code: 'target-missing', subcode, reason: `更新目标 ${id} 在这次保存期间被删除了，未保存。` }
  }
  const masked = maskSecretSurface(current)
  const shown = `记忆 ${id}（${masked.name}）在这次保存期间被改过，当前内容是：\n${masked.content}\n未保存。`
  return { kind: 'rejected', code: 'target-missing', subcode, reason: `${shown}按当前内容重新组织要改的部分，再用 action=update 重发。` }
}

/** 子 agent 改不了这条记录的原因；是本会话创建、还没升档、还在本项目的返回 undefined。已删除的由调用处先拦。 */
function notOwnPending(target: MemoryRecord, sessionId: string): string | undefined {
  if (target.delegation === undefined) return NOT_DELEGATED_REASON
  if (target.delegation.sessionId !== sessionId) return '是别的子会话存的'
  if (!isPendingDelegated(target)) return ALREADY_REVIEWED_REASON
  if (target.scope !== 'workspace') return '已经提升为全局'
  if (target.status === 'superseded') return '已经被取代了'
  return undefined
}

/** 子 agent 能不能改这条：不存在或已删除的也拒（不交给 target-missing：其间被恢复成主档就会放过去）；能改返回 undefined。 */
function subagentTargetProblem(id: string, target: MemoryRecord | undefined, sessionId: string): Rejection & { subcode: SaveRejectSubcode } | undefined {
  if (target === undefined || target.status === 'deleted') {
    return { code: 'subagent-restricted', subcode: 'subagent-target-gone', reason: `要改的记忆 ${id} 不存在或已删除，带回主会话。` }
  }
  const why = notOwnPending(target, sessionId)
  if (why !== undefined) {
    return { code: 'subagent-restricted', subcode: 'subagent-not-own', reason: `子 agent 只能改本会话存下、还没被接受的记忆；${id} ${why}。要改的内容带回主会话。` }
  }
  return undefined
}

/** 子 agent 写不了这个类型的原因；能写返回 undefined。 */
function subagentTypeProblem(type: string, registry: TypeRegistry): Rejection & { subcode: SaveRejectSubcode } | undefined {
  const writable = SUBAGENT_TYPES.filter(t => registry.has(t))
  if (writable.includes(type)) return undefined
  const shown = writable.length > 0 ? `当前场景里能写：${writable.join('、')}` : '当前场景里两类都没有'
  return {
    code: 'subagent-restricted',
    subcode: 'subagent-type',
    reason: `子 agent 只能写 knowledge、project 两类，且要在当前场景里（${shown}）；"${type}" 不行，这件事带回主会话。`,
  }
}

/**
 * 子 agent 写入约束：主会话不经过这里。一个判断块、一个拒绝码 subagent-restricted，原因按条写明怎么改或带回主会话。
 * 顺序固定：scope 降级（只警告）→ 依据 → 类型 → supersedes → force → allowSecret → update 归属 → create 配额，同时犯多条时报最前的。
 * 通过时返回降级后的候选与警告，后面的管线照常走。
 */
async function checkSubagentWrite(
  input: SaveCandidate,
  deps: PipelineDeps,
): Promise<{ candidate: SaveCandidate; warnings: SaveWarning[] } | { code: RejectCode; subcode: SaveRejectSubcode; reason: string }> {
  const warnings: SaveWarning[] = []
  let candidate = input
  // 子 agent 没有提升候选的通道：global 直接落当前项目，提不提全局由主会话决定
  if (candidate.scope === 'global') {
    candidate = { ...candidate, scope: 'workspace' }
    warnings.push({ code: 'subagent-scope-local', text: '子 agent 写的记忆只能放本项目，要提全局由主会话决定' })
  }
  if (!SUBAGENT_SOURCE_MODES.includes(candidate.sourceMode)) {
    return {
      code: 'subagent-restricted',
      subcode: 'subagent-source-mode',
      reason: `sourceMode=${candidate.sourceMode} 子 agent 用不了：子 agent 收到的指令来自委派方，不算用户明说；按观察（environment-observed）或推断（agent-inferred）重发。`,
    }
  }
  const typeProblem = subagentTypeProblem(candidate.type, deps.registry)
  if (typeProblem !== undefined) return typeProblem
  if ((candidate.supersedes ?? []).length > 0) {
    return { code: 'subagent-restricted', subcode: 'subagent-supersedes', reason: '子 agent 不能用 supersedes 替代旧记忆；去掉 supersedes 重发，要替代哪条带回主会话。' }
  }
  if (candidate.force) {
    return {
      code: 'subagent-restricted',
      subcode: 'subagent-force',
      reason: '子 agent 不能带 force：和已有记忆几乎一样时，在回复里向委派方说明（带上那条的 id），由它决定。去掉 force 重发。',
    }
  }
  if (candidate.allowSecret) {
    return { code: 'subagent-restricted', subcode: 'subagent-allow-secret', reason: '子 agent 不能带 allowSecret：疑似密钥一律不存，改写成不含密钥的指针再存。去掉 allowSecret 重发。' }
  }
  // update 只改本会话存下、还没升档的。写入时在写入段里按最新读数再判一次（见下方 commitChange 的 isBlocked），其间被接受、删除、提升的不覆盖
  if (candidate.action === 'update' && candidate.id !== undefined) {
    const problem = subagentTargetProblem(candidate.id, await deps.store.get(candidate.id, { workspacePath: deps.workspacePath }), deps.session.id)
    if (problem !== undefined) return problem
  }
  // 新建配额：现数本会话创建的记录（在用含已过期、已取代都算，删了就释放），不加锁、不另存计数。
  // 软限制：串行调用不超，同一子会话并行调用可能多存一两条。无工作目录的 create 交给后面的 no-workspace
  if (candidate.action === 'create' && deps.workspacePath !== undefined) {
    const max = deps.maxSubagentSaves ?? SUBAGENT_MAX_SAVES_DEFAULT
    const mine = await deps.store.query({ scope: { kind: 'workspace', workspacePath: deps.workspacePath }, status: ['active', 'superseded'] })
    const count = mine.filter(r => r.delegation?.sessionId === deps.session.id).length
    if (count >= max) {
      return { code: 'subagent-restricted', subcode: 'subagent-quota', reason: `本会话已存 ${count} 条，到了每个子会话 ${max} 条的上限；其余带回主会话。` }
    }
  }
  return { candidate, warnings }
}

/** 主题输入只在入口遮盖，换行保留给名字校验。 */
function topicIntent(input: SaveInput, deps: PipelineDeps): TopicIntent | undefined {
  return input.topic === undefined || deps.delegation !== undefined ? undefined : { kind: 'choose', name: input.topic, about: input.topicAbout, maxTopics: deps.maxTopics ?? INDEX_MAX_TOPICS_DEFAULT }
}

function topicNote(code: 'topic-about-ignored' | 'topic-about-alone' | 'topic-deferred-subagent' | 'topic-pending' | 'topic-unreadable' | 'topic-not-indexed' | 'topic-skipped'): SaveWarning[] {
  const texts = { 'topic-about-ignored': topicText.TOPIC_ABOUT_IGNORED_TEXT, 'topic-about-alone': topicText.TOPIC_ABOUT_ALONE_TEXT,
    'topic-deferred-subagent': topicText.TOPIC_DEFERRED_SUBAGENT_TEXT, 'topic-pending': topicText.TOPIC_PENDING_TEXT,
    'topic-unreadable': topicText.TOPIC_UNREADABLE_TEXT, 'topic-not-indexed': topicText.TOPIC_NOT_INDEXED_TEXT, 'topic-skipped': topicText.TOPIC_SKIPPED_TEXT }
  return [{ code, text: texts[code] }]
}

function topicWarnings(input: SaveInput, files: IndexFiles, maxTopics: number, kept: boolean): SaveWarning[] {
  const name = input.topic!
  const target = resolveTopic(files, name, maxTopics)
  const quote = (text: string) => `「${maskSecrets(text).replace(/\s+/g, ' ')}」`
  const nearest = nearestTopics(files, name)
  const hint = nearest.length === 0 ? '' : topicText.NEAREST_TOPICS_LEAD + nearest.map(quote).join('、') + '。' + topicText.NEAREST_TOPICS_HINT
  const place = kept ? topicText.TOPIC_PLACE_KEPT : topicText.TOPIC_PLACED_UNSORTED
  if (target.kind === 'new') return [{ code: 'topic-created', text: topicText.TOPIC_CREATED_LEAD + quote(name) + '。' + hint }]
  if (target.kind === 'full') return [{ code: 'topic-full', text: topicText.TOPIC_FULL_LEAD + quote(name) + '。' + place + hint }]
  if (target.kind === 'invalid') return [{ code: 'topic-invalid', text: topicText.TOPIC_INVALID_LEAD + '（' + topicText.TOPIC_NAME_PROBLEM_TEXT[topicNameProblem(name)!] + '）。' + place + hint }]
  const isListed = entryTopics(files.entry).some(t => t.fileName === target.fileName || (t.fileName === undefined && keyOf(t.name) === keyOf(target.name)))
  return input.topicAbout === undefined || !isListed ? [] : topicNote('topic-about-ignored')
}

async function saveTopicWarnings(input: SaveInput, deps: PipelineDeps, scope: Scope, id: string): Promise<SaveWarning[]> {
  if (input.topic === undefined) return input.topicAbout === undefined ? [] : topicNote('topic-about-alone')
  if (deps.delegation) return topicNote('topic-deferred-subagent')
  try {
    const files = await deps.store.readIndex(scope, true) ?? { entry: '# 记忆索引\n', pages: {} }
    const index = readIndex(files)
    return topicWarnings(input, files, deps.maxTopics ?? INDEX_MAX_TOPICS_DEFAULT, index.unsorted.includes(id) || index.topics.some(t => t.memberIds.includes(id)))
  } catch { return topicNote('topic-pending') }
}

/** 只改主题在同一写入段复核目标，再交给已有索引操作和回执机制提交。 */
async function runTopicOnly(input: SaveInput, deps: PipelineDeps, now: number): Promise<PipelineResult> {
  const { store } = deps
  const read = input.id === undefined ? undefined : await store.get(input.id, { workspacePath: deps.workspacePath })
  const notWritable = deps.delegation ? subagentTargetProblem(input.id ?? '(缺 id)', read, deps.session.id) : undefined
  if (notWritable !== undefined) return { kind: 'rejected', ...notWritable }
  const checked = await checkUpdateTarget(input.id, read, deps)
  if ('code' in checked) return { kind: 'rejected', ...checked }
  const { target } = checked
  if (deps.delegation) return { kind: 'updated', record: target, warnings: topicNote('topic-deferred-subagent') }
  if (target.scope === 'global' && deps.workspacePath !== undefined) {
    const code = globalConfirmCode(deps.session.id, target)
    if (!isConfirmCodeMatch(input.confirmGlobal, code)) return { kind: 'rejected', code: 'global-update-unconfirmed', reason: globalUpdateGuide(target, code, input.confirmGlobal) }
  }
  const scope = scopeOfMemory(target)!
  return store.writeSection(async () => {
    const current = await store.get(target.id, scope)
    if (current === undefined || current.status !== 'active') return changedAfterRead(target.id, current, false)
    const ignored = LINK_ONLY_IGNORED.filter(k => input[k] !== undefined)
    const result = (warnings: SaveWarning[]): PipelineResult => ({ kind: 'updated', record: current, warnings: [...warnings, ...(ignored.length ? [{ code: 'topic-only-params-ignored' as const, text: topicText.TOPIC_ONLY_IGNORED_LEAD + ignored.join('、') + '。' }] : [])] })
    let files: IndexFiles | undefined
    try { files = await store.readIndex(scope, true) } catch { return result(topicNote('topic-unreadable')) }
    if (files === undefined) return result(topicNote('topic-not-indexed'))
    const index = readIndex(files)
    if (!index.unsorted.includes(current.id) && !index.topics.some(t => t.memberIds.includes(current.id))) return result(topicNote('topic-not-indexed'))
    const maxTopics = deps.maxTopics ?? INDEX_MAX_TOPICS_DEFAULT
    const resolved = resolveTopic(files, input.topic!, maxTopics)
    const warnings = topicWarnings(input, files, maxTopics, true)
    if (resolved.kind === 'invalid' || resolved.kind === 'full') return result(warnings)
    const from = index.topics.find(t => t.memberIds.includes(current.id))
    if (from?.fileName === resolved.fileName) return result(warnings)
    const decisions = deps.decisions
    const entry = await decisions?.addSettled({
      kind: 'index-organize', memoryIds: [], summary: '调整记忆所属主题',
      workspaces: [ledgerLabel(scope)], indexRun: { receipts: [] },
    }, 'index-organized', now)
    if (decisions) {
      if (!store.hasStep(INDEX_RECEIPT_STEP)) store.registerSteps(ledgerSteps(decisions))
    }
    try {
      const outcome = await store.applyIndexOp(scope, { kind: 'assign', memoryIds: [current.id], from: maskSecrets(from?.name ?? UNSORTED_TITLE), to: input.topic!, ...(resolved.kind === 'new' ? { about: input.topicAbout } : {}) }, {
        maxTopics, ...(decisions ? { prepare: async (id: string, plan: IndexPlan) => {
          await decisions.appendIndexReceipt(entry!.id, { op: id, plan })
          return [indexReceiptStep(entry!.id)]
        } } : {}),
      })
      return result(outcome.kind === 'skipped' ? topicNote('topic-skipped') : warnings)
    } finally {
      if (decisions) await decisions.finishIndexRun(entry!.id, op => store.isOpPending(op))
    }
  })
}

/** 带了要挂的关联或前提。 */
function hasLinks(input: Pick<SaveInput, 'related' | 'premises'>): boolean {
  return (input.related?.length ?? 0) > 0 || (input.premises?.length ?? 0) > 0
}

/** 改内容的参数：update 带了其中任何一个就是一次内容改动；一个都没带、只带关联和前提的是只改元数据的操作。 */
const CONTENT_KEYS = ['name', 'type', 'content', 'edits', 'summary', 'tags', 'supersedes', 'validFrom', 'validTo', 'factTime'] as const

/**
 * 只挂关联、前提的 update：带了 related 或 premises（空列表也算），没带任何改内容的参数。补证照常走补证（关联在那里不生效，结果里说明）。
 */
function isLinkOnly(input: SaveInput): boolean {
  return input.action === 'update' && input.change !== 'corroborate' && (input.related !== undefined || input.premises !== undefined)
    && CONTENT_KEYS.every(k => input[k] === undefined)
}

/** 只挂关联、前提时不生效的参数：作用域不随更新变，把握和改动性质只跟内容改动走，force 只管新建。 */
const LINK_ONLY_IGNORED = ['scope', 'confidence', 'change', 'changeReason', 'force'] as const

/** 只挂关联时带了不生效的参数：结果里说明，写法同补证那条。 */
function linkOnlyWarnings(input: SaveInput): SaveWarning[] {
  const ignored = LINK_ONLY_IGNORED.filter(k => input[k] !== undefined)
  if (ignored.length === 0) return []
  return [{ code: 'link-only-params-ignored', text: `只挂关联、前提的 update 只追加 related、premises，${ignored.join('、')} 没有生效；要改内容或把握，带上要改的字段和 change 另发一次 update` }]
}

function linkRejection(problem: string): PipelineResult {
  return { kind: 'rejected', code: 'link-invalid', reason: `关联没有挂上：${problem}未保存。` }
}

/**
 * 只挂关联、前提的 update：只改元数据，不用填改动性质，不动修改时间、最近一次内容改动和出处，不拍快照。照常经写入段、带提交标记，
 * 新加的 id 记一条回执，撤销时只去掉这些。目标的检查同 update（存在、在本项目、没被取代、子 agent 只改自己待确认的、全局记忆要确认码）；
 * 落盘时在写入段里重读目标、核对要挂的 id，追加到最新的那一版上：两个会话同时追加，两次都在。
 */
async function runLinkOnly(input: SaveInput, deps: PipelineDeps, now: number): Promise<PipelineResult> {
  const { store, session } = deps
  const read = input.id === undefined ? undefined : await store.get(input.id, { workspacePath: deps.workspacePath })
  const notWritable = deps.delegation ? subagentTargetProblem(input.id ?? '(缺 id)', read, session.id) : undefined
  if (notWritable !== undefined) return { kind: 'rejected', ...notWritable }
  const checked = await checkUpdateTarget(input.id, read, deps)
  if ('code' in checked) return { kind: 'rejected', ...checked }
  const { target } = checked
  const ignored = linkOnlyWarnings(input)
  const withNotes = (result: PipelineResult): PipelineResult => (result.kind === 'updated' && ignored.length > 0 ? { ...result, warnings: [...(result.warnings ?? []), ...ignored] } : result)
  if (!hasLinks(input)) {
    return withNotes({ kind: 'updated', record: target, warnings: [{ code: 'links-empty', text: 'related、premises 都是空列表，没有要挂的 id，什么都没写；要挂就把那几条记忆的 id 填进去再发' }] })
  }
  if (target.scope === 'global' && deps.workspacePath !== undefined) {
    const code = globalConfirmCode(session.id, target)
    if (!isConfirmCodeMatch(input.confirmGlobal, code)) return { kind: 'rejected', code: 'global-update-unconfirmed', reason: globalUpdateGuide(target, code, input.confirmGlobal) }
  }
  const scope: Scope | undefined = scopeOfMemory(target)
  if (scope === undefined) return { kind: 'rejected', code: 'target-missing', reason: `更新目标不存在或已删除：${target.id}` }
  const by = deps.delegation ? 'subagent' : 'main'
  return store.writeSection(async (): Promise<PipelineResult> => {
    const current = await store.get(target.id, scope)
    const isSamePlace = current !== undefined && current.status === 'active' && current.scope === target.scope && current.workspacePath === target.workspacePath
    if (!isSamePlace || (deps.delegation !== undefined && notOwnPending(current, session.id) !== undefined)) {
      return changedAfterRead(target.id, current, deps.delegation !== undefined)
    }
    const links = await resolveLinks(store, { id: current.id, scope }, input)
    if ('problem' in links) return linkRejection(links.problem)
    const merged = mergeLinks(current, links)
    if ('problem' in merged) return linkRejection(merged.problem)
    // 都已经挂着：没有要写的，也没有可撤的
    if (merged.added.related.length === 0 && merged.added.premises.length === 0) return input.topic !== undefined ? runTopicOnly(input, deps, now) : withNotes({ kind: 'updated', record: current })
    const steps = []
    if (deps.decisions !== undefined) {
      if (!store.hasStep(LINK_CHANGE_STEP)) store.registerSteps(ledgerSteps(deps.decisions))
      steps.push(linkChangeStep({ added: merged.added, at: now, origin: { sessionId: session.id, callId: deps.callId ?? '' } }))
    }
    const warnings = await saveTopicWarnings(input, deps, scope, current.id)
    const op = newWriteOp({ initiator: by, steps, topic: topicIntent(input, deps) })
    // 写入段挡不住手改文件：落盘那一刻和刚读到的不是同一版就不写、不记回执（回执里的「新加」按刚读到的这版算），让模型重读
    const seen: { latest?: MemoryRecord } = {}
    const isChangedSinceRead = (latest: MemoryRecord | undefined) => {
      seen.latest = latest
      return latest === undefined || !isSameRecord(latest, current)
    }
    const written = await store.put({ ...current, ...merged.fields }, scope, isChangedSinceRead, op)
    if (written === undefined) return changedAfterRead(target.id, seen.latest, deps.delegation !== undefined)
    const notes = input.topic !== undefined && store.hasUnfinishedOwnStep(op.id, INDEX_ROW_STEP) ? topicNote('topic-pending') : warnings
    await store.finishOp(op, written)
    return withNotes({ kind: 'updated', record: written, warnings: notes })
  })
}

export async function runSavePipeline(
  input: SaveInput,
  deps: {
    /** 新建闸取候选时使用的分词器配置。 */
    tokenizer?: QueryTokenizerOptions
    /** 本会话的提示记账；不给时不出粒度和长度提示。 */
    hints?: SaveHints
    store: MemoryStore
    registry: TypeRegistry
    workspacePath: string | undefined
    /** turnStartSeq：触发本次保存的当轮 turn/start 事件 seq（绑定层机械回找），缺省 0（整会话兜底）。 */
    session: { id: string; lastSeq: number; turnStartSeq?: number }
    /** 改写（update）、替代（supersedes）前拍快照用（快照先行，对齐 forget 的可恢复性）。必填：漏接线时编译就报错，测试传内存实现。 */
    snapshots: SnapshotStore
    /** 改写、替代后记一条已结清的撤销记录（对话卡、右侧栏据此显示与撤销）；要和 snapshots 一起给，缺省不记。 */
    decisions?: PendingDecisionsStore
    /** 这次 memory_save 的工具调用 id，记进撤销记录，对话卡按它认领。 */
    callId?: string
    /** 子 agent 会话的委派上下文；新建的记录据此带 delegation（待确认）。 */
    delegation?: SaveDelegation
    /** 子会话新建配额（配置 subagent.maxSavesPerSession，调用时现读），缺省 SUBAGENT_MAX_SAVES_DEFAULT。 */
    maxSubagentSaves?: number
    /**
     * 本会话里哪些记忆已经回过缺改动性质的引导。只在内存里（接线层按会话建），不落盘；
     * 引导过一次后同一条再缺，按状态变化写下、结果里说明，模型不会卡在引导上。不给时每次都回引导。
     */
    guided?: { has(memoryId: string): boolean; add(memoryId: string): void }
    /** 状态变化的合并窗口，毫秒（配置 history.mergeWindowMinutes，调用时现读）；缺省见 commit-change.ts。 */
    mergeWindowMs?: number
    /** 主题数上限（配置 index.maxTopics，调用时现读）；缺省 INDEX_MAX_TOPICS_DEFAULT。 */
    maxTopics?: number
    /** 沿关联发复查信号的钩子，交给落盘原语（见 commit-change.ts）；不给就不发。 */
    relatedRecheck?: RelatedRecheckHook
    /** 写入时刻（createdAt、updatedAt、有效期、快照与撤销记录）的时钟，缺省取当前时间。 */
    now?: () => number
    /**
     * 从会话日志读出的当轮事实（绑定层读，范围按 anchorRangeOf）：记进锚，并决定能填哪些来源方式。
     * 不给时不记、不限（没有会话日志可读的调用方，如纯管线测试）；宿主给不出发起方要传 isUserInitiated: false。
     */
    turn?: AnchorFacts
  },
): Promise<PipelineResult> {
  const { store, registry, session } = deps
  const now = deps.now?.() ?? Date.now()
  // 关联和前提的每一项先按记忆 id 的形状校验，各条路径（新建、改内容、补证、只挂关联）都过这一道
  input = { ...input, ...(input.topic !== undefined ? { topic: maskSecrets(input.topic.trim()) } : {}), topicAbout: input.topicAbout?.trim() ? maskSecrets(input.topicAbout.trim()).replace(/\s+/g, ' ') : undefined }
  const badLinks = linkShapeProblem(input)
  if (badLinks !== undefined) return linkRejection(badLinks)
  if (input.action === 'update' && input.topic !== undefined && input.change !== 'corroborate' && CONTENT_KEYS.every(k => input[k] === undefined) && !hasLinks(input)) return runTopicOnly(input, deps, now)
  if (isLinkOnly(input)) return runLinkOnly(input, deps, now)

  // 0. 入参补成完整候选（精确修改在这里读目标、算出新正文），再过子 agent 写入约束（主会话没有 delegation，原样往下走）
  const resolved = await resolveInput(input, deps)
  if ('code' in resolved) return { kind: 'rejected', ...resolved }
  const subagent = deps.delegation ? await checkSubagentWrite(resolved.candidate, deps) : { candidate: resolved.candidate, warnings: [] }
  if ('code' in subagent) return { kind: 'rejected', ...subagent }
  const { candidate } = subagent
  // 不是用户本人开的轮（定时任务、别的 agent、插件投递）：用户明说、用户行为、经用户确认的动作都无从谈起，和子 agent 同一口径
  if (deps.turn !== undefined && !deps.turn.isUserInitiated && !SUBAGENT_SOURCE_MODES.includes(candidate.sourceMode)) {
    const opener = deps.turn.initiator === undefined ? '读不到是谁开的' : `由 ${deps.turn.initiator} 开启`
    return {
      kind: 'rejected',
      code: 'not-user-initiated',
      reason: `这一轮不是用户本人开的（${opener}），sourceMode 按观察（environment-observed）或推断（agent-inferred）填，再重发。`,
    }
  }

  // 1. 格式校验
  const typeGate = (type: string): Rejection | undefined => {
    if (!registry.has(type)) return { code: 'unknown-type', reason: `未知类型 "${type}"，可用类型见工具说明` }
    return deps.delegation ? subagentTypeProblem(type, registry) : undefined
  }
  if (!registry.has(candidate.type)) {
    return { kind: 'rejected', code: 'unknown-type', reason: `未知类型 "${candidate.type}"，可用类型见工具说明` }
  }
  // 模型无 global 直写通道：新建时填 global → 降级 workspace + globalCandidate 标记，
  // 真正提升到 global 只能走 memory_promote（用户确认）。
  let scope = candidate.scope
  let globalCandidate: true | undefined
  const scopeWarnings: SaveWarning[] = []
  let target: MemoryRecord | undefined
  let change: ChangeKind | undefined
  if (candidate.action === 'update') {
    // 精确修改用算新正文时的那份读数，不再读一次：之后正文被别处改过，写入时在最新正文上重做
    const checked = resolved.base !== undefined
      ? { target: resolved.base }
      : await checkUpdateTarget(candidate.id, candidate.id ? await store.get(candidate.id, { workspacePath: deps.workspacePath }) : undefined, deps)
    if ('code' in checked) return { kind: 'rejected', ...checked }
    target = checked.target
    // scope 不随 update 变更——否则例行内容更新会把用户确认提升过的 global 记忆
    // 静默拉回当前项目（提升闸被写入链绕过）。降级同样没有免确认通道。
    scope = target.scope
    // 全局记忆注入所有项目的会话：项目会话里改它，先要模型判断这次的内容对所有项目都成立（带引导里的确认码重发），
    // 只对当前项目成立的改存项目记忆。码按预读的这一版算：确认的是这次的内容对所有项目成立，预读之后别处改过这条不让它失效。没有工作目录的会话没有项目记忆可选，
    // 全局是唯一去处，不拦。码对了之后别的检查没过，照常回那条检查的原因
    if (target.scope === 'global' && deps.workspacePath !== undefined) {
      const code = globalConfirmCode(session.id, target)
      if (!isConfirmCodeMatch(candidate.confirmGlobal, code)) {
        return { kind: 'rejected', code: 'global-update-unconfirmed', reason: globalUpdateGuide(target, code, candidate.confirmGlobal) }
      }
    }
    // 改动性质：排在确认码之后，两道都过才往下走。没声明（或取值不认识）先回引导；本会话对这条引导过一次还缺，
    // 按状态变化写：改前的内容留成历史版本，四种里只有它不丢东西
    if (!(CHANGE_KINDS as readonly unknown[]).includes(candidate.change)) {
      if (deps.guided?.has(target.id) !== true) {
        deps.guided?.add(target.id)
        return { kind: 'rejected', code: 'change-kind-missing', reason: changeKindGuide(target, candidate.change) }
      }
      change = 'state-change'
      scopeWarnings.push({ code: 'change-kind-assumed', text: '没有声明改动性质（change），已按状态变化（state-change）保存：改前的内容留成了历史版本。旧内容当时就不对的话，下次用 change=correct' })
    } else {
      change = candidate.change!
    }
    if (resolved.ignored !== undefined && resolved.ignored.length > 0) {
      const isLinkIgnored = resolved.ignored.some(k => k === 'related' || k === 'premises')
      const linkHint = isLinkIgnored ? '；要挂关联、前提，对这条记忆再调一次 update，不带 change，只传 id 和 related、premises' : ''
      scopeWarnings.push({ code: 'corroborate-fields-ignored', text: `补证只刷新确认时间、记下出处，${resolved.ignored.join('、')} 没有生效；要改内容，按改动的性质用 refine、correct 或 state-change 重发${linkHint}` })
    }
    if (candidate.scope === 'global' && target.scope === 'workspace') {
      // 模型对 workspace 记录重申 global 意图：转成提升候选（已是候选则静默幂等）
      if (!target.globalCandidate) {
        scopeWarnings.push({ code: 'update-global-candidate', text: 'scope 不随更新变更；已将这条记忆标记为全局提升候选，治理时经用户确认后提升' })
      }
    } else if (candidate.scope !== target.scope) {
      scopeWarnings.push({ code: 'update-scope-kept', text: `scope 不随更新变更，记忆保持 ${target.scope}` })
    }
  } else {
    // workspacePath 缺失说明会话连 cwd 都没有（runtime 对有 cwd 的会话总能用目录兜底作用域）：
    // 没有 workspace 作用域，落 global 又会绕过用户确认闸，两头无路可落，新建一律拒存。
    if (deps.workspacePath === undefined) {
      return { kind: 'rejected', code: 'no-workspace', reason: '当前会话没有工作目录，记忆无处归属：没有 workspace 作用域，global 写入必须经用户确认的提升流程。请在有工作目录的会话里保存。' }
    }
    if (candidate.scope === 'global') {
      scope = 'workspace'
      globalCandidate = true
    }
  }

  if (candidate.factTime !== undefined && !(candidate.action === 'update' && candidate.factTime === '')
    && (typeof candidate.factTime !== 'string' || !isFactTime(candidate.factTime))) {
    return { kind: 'rejected', code: 'validity-format', reason: 'factTime 请填写存在的日期：接受 YYYY、YYYY-MM、YYYY-MM-DD、带时刻的 ISO 8601；按用户说的精度和时区填写。update 可用空字符串清除。' }
  }
  // 有效期换算成毫秒；update 没传的字段保留原值。
  const validity = resolveValidity(candidate, target, now)
  if ('code' in validity) return { kind: 'rejected', ...validity }
  const isCorroboration = change === 'corroborate'

  // 本次要标 superseded 的旧记忆：目标必须与本次写入记录同属一个作用域——跨作用域替代会绕过用户确认闸、无快照、无复活路径，
  // 作用域不同的目标跳过不置 superseded，仅给一条警告。目标不存在维持静默跳过；只替代在用的，已删除的留在最近删除、
  // 照常过期清走，已被取代的原样不动。本次写入记录的作用域此时已定：update 继承目标，create 落当前项目（global 已降级为候选）。
  const writeScope = candidate.action === 'update'
    ? { scope: target!.scope, workspacePath: target!.workspacePath }
    : { scope, workspacePath: scope === 'workspace' ? deps.workspacePath : undefined }
  const isSameScope = (old: MemoryRecord) => old.scope === writeScope.scope
    && (writeScope.scope !== 'workspace' || old.workspacePath === writeScope.workspacePath)
  let replaced: MemoryRecord[] = []
  let hasCrossScopeSupersede = false
  for (const oldId of new Set(candidate.supersedes ?? [])) {
    const old = await store.get(oldId, { workspacePath: deps.workspacePath })
    if (old === undefined || old.id === target?.id) continue
    if (!isSameScope(old)) hasCrossScopeSupersede = true
    else if (old.status === 'active') replaced.push(old)
  }

  // 2. confidence 决议：只能下调。补证没给把握就不动，给了也不超过这次依据的上限（落盘时和原值取高的）
  const cap = CONFIDENCE_BY_SOURCE[candidate.sourceMode]
  const confidence = Math.min(candidate.confidence ?? cap, cap)
  const corroboratedConfidence = candidate.confidence === undefined ? undefined : confidence

  // 检索可能加载词典，放在写入段外，避免拖住其他写入。
  let similar: SimilarMemory[] = []
  if (candidate.action === 'create') {
    let topicMemberIds: readonly string[] | undefined
    if (input.topic !== undefined && deps.delegation === undefined) {
      try {
        const files = await store.readIndex({ kind: 'workspace', workspacePath: deps.workspacePath! }, true)
        const target = files && resolveTopic(files, input.topic, deps.maxTopics ?? INDEX_MAX_TOPICS_DEFAULT)
        if (files && target?.kind === 'existing') topicMemberIds = readIndex(files).topics.find(t => t.fileName === target.fileName)?.memberIds
      } catch { /* 锁外候选读取失败不挡保存；锁内步骤会留下待补说明。 */ }
    }
    const gate = await runCreateGate({
      topicMemberIds,
      name: candidate.name, summary: candidate.summary, content: candidate.content,
      workspacePath: deps.workspacePath!, skipDuplicate: candidate.force === true,
      excludeIds: new Set(replaced.map(r => r.id)),
      ...(deps.delegation ? { subagentSessionId: session.id } : {}),
    }, { store, tokenizer: deps.tokenizer, now: () => now })
    if (gate.kind === 'duplicate') return { kind: 'duplicate-suspected', existing: gate.existing, ...(deps.delegation ? { isFromSubagent: true as const } : {}) }
    similar = gate.similar
  }

  // 4. 持久化（写入前必须过 schema——KvTable.put 不校验，脏记录会让下次 domain open 整库拒载）
  // 证据锚（这条记忆出自会话的哪段事件）：eventRange = [当轮 turn/start, save 时刻]，两个数都是机械事实。
  // 模型上下文里没有 seq 标注，任何模型填的区间都是编造——锚只能由绑定层填。
  const turn = deps.turn
  const anchor: ChangeAnchor = {
    sessionId: session.id, eventRange: anchorRangeOf(session), sourceMode: candidate.sourceMode,
    ...(turn?.initiator !== undefined ? { initiator: turn.initiator } : {}),
    ...(turn?.evidence !== undefined ? { evidence: turn.evidence } : {}),
    ...(turn?.startTime !== undefined ? { at: turn.startTime } : {}),
  }
  const by = deps.delegation ? 'subagent' : 'main'
  // update 要改的字段：怎么落到记录上由改动性质定（change.ts 的落盘行为表），补证只带把握。
  // 按 on 这一版拼：这次没传的都取它的值，所以落盘时拿锁内读到的最新版再拼一遍，预读之后别处改的不会被盖回去
  const inherited = new Set<InheritedKey>(resolved.inherited ?? [])
  const fieldsOn = (on: MemoryRecord, content: string, valid: { validFrom?: number; validTo?: number }): ChangeFields => isCorroboration ? { confidence: corroboratedConfidence } : {
    name: inherited.has('name') ? on.name : candidate.name,
    type: inherited.has('type') ? on.type : candidate.type,
    tags: inherited.has('tags') ? on.tags : candidate.tags,
    content: inherited.has('content') ? on.content : content,
    summary: inherited.has('summary') ? on.summary : candidate.summary,
    confidence,
    // 可选字段统一"不传即保留"：update 是内容编辑，不重传 validTo 就清掉时效窗口
    // 会让有时效的记忆变成永不过期（有效期的回退在 resolveValidity 里）
    validFrom: valid.validFrom,
    validTo: valid.validTo,
    factTime: candidate.factTime === undefined ? on.factTime : candidate.factTime === '' ? undefined : candidate.factTime,
    supersedes: candidate.supersedes ?? on.supersedes,
    globalCandidate: candidate.scope === 'global' && on.scope === 'workspace' ? true : on.globalCandidate,
    // 创建者四个字段永不改。子 agent 改写：内容仍是子级写的，reviewed 一律去掉（回到待确认）；
    // 主会话改写待确认记录即升档：reviewed 缺省时补 main，已有的（用户改过、早先接受过）不动
    delegation: deps.delegation
      ? on.delegation && { ...on.delegation, reviewed: undefined }
      : on.delegation && { ...on.delegation, reviewed: on.delegation.reviewed ?? { by: 'main', at: now } },
  }
  let record: MemoryRecord
  if (candidate.action === 'update') {
    // scope/workspacePath 从 target 原样继承（见上方 scope 决议），不吃当前会话上下文。
    // 先按预读的那一版拼一遍，过格式校验；真正落盘的那条在写入段里按最新版、带着操作 id 再拼
    record = applyChange(target!, { kind: change!, fields: fieldsOn(target!, candidate.content, validity), anchor, by, op: 'op_preview', at: now })
  } else {
    record = {
      id: `mem_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: candidate.name, type: candidate.type, scope,
      workspacePath: scope === 'workspace' ? deps.workspacePath : undefined,
      tags: candidate.tags, content: candidate.content, summary: candidate.summary,
      ...initialProvenance(anchor, by, now),
      createdAt: now, updatedAt: now, lastConfirmedAt: now,
      lastRecalledAt: null, recallCount: 0,
      validFrom: validity.validFrom, validTo: validity.validTo,
      factTime: candidate.factTime,
      status: 'active', confidence, supersedes: candidate.supersedes,
      globalCandidate,
      // 子 agent 新建：创建者信息由宿主上下文填，不带 reviewed 即待确认（mode 不落盘）
      delegation: deps.delegation && {
        sessionId: session.id, depth: deps.delegation.depth, parentSessionId: deps.delegation.parentSessionId,
        rootSessionId: deps.delegation.rootSessionId,
      },
    }
  }
  const parsed = memoryRecordSchema.safeParse(record)
  if (!parsed.success) {
    return { kind: 'rejected', code: 'schema-invalid', reason: `字段校验失败：${parsed.error.issues.map(i => i.message).join('；')}` }
  }

  // 5. 写盘前 secret 检查：高危（明确厂商特征）直接拦截、不落盘；疑似拦下待确认，allowSecret 放行并保留警告。
  // summary 进注入索引、name 进文件名、tags 进索引行——密钥藏在哪个字段都会外泄，四个面一起查；
  // supersedes 落进文件、体检的孤儿说明会把它引出来，变化原因随历史版本落盘，一并查。补证不写内容，不查。
  type SecretFaces = Pick<MemoryRecord, 'content' | 'name' | 'summary' | 'tags' | 'supersedes'>
  const secretGate = (faces: SecretFaces): { rejected: PipelineResult } | { suspected: ReturnType<typeof detectSecrets> } => {
    const secretHits = isCorroboration ? [] : detectSecrets(
      `${faces.content}\n${faces.name}\n${faces.summary}\n${faces.tags.join(' ')}\n${(faces.supersedes ?? []).join(' ')}\n${candidate.changeReason ?? ''}`)
    const critical = secretHits.filter(h => h.severity === 'critical')
    if (critical.length > 0) {
      return { rejected: {
        kind: 'rejected',
        code: 'secret-critical',
        reason: `检测到高危密钥（${critical.map(h => h.name).join('、')}），未保存。密钥不该进记忆（将来可能随同步离开本机）——如需记录，请改写成不含密钥的指针（如「AWS 凭证在 1Password 的 X 条目」）再存。`,
      } }
    }
    const found = secretHits.filter(h => h.severity === 'suspected')
    if (found.length > 0 && !candidate.allowSecret) {
      return { rejected: {
        kind: 'rejected',
        code: 'secret-suspected',
        reason: deps.delegation
          ? `检测到疑似密钥（${found.map(h => h.name).join('、')}），未保存。疑似密钥一律不存：改写成不含密钥的指针再存，不是密钥的带回主会话。`
          : `检测到疑似密钥（${found.map(h => h.name).join('、')}），未保存。是密钥就改写成不含密钥的指针再存；向用户确认不是密钥后，带 allowSecret: true 重发。`,
      } }
    }
    return { suspected: found }
  }
  const gate = secretGate(candidate)
  if ('rejected' in gate) return gate.rejected
  let suspected = gate.suspected

  // 从拍快照到记账本是一条记忆的一次改动，整段在一个写入段里：中途拿锁超时不会写了文件却没留撤销，
  // 同进程别的写入也插不进中间。段内只读写文件，不等模型
  return await store.writeSection(async () => {
    // 撤销记录是写成之后才补的账：随这次写入登记成提交后的步骤，写完就做；中途被打断，下一次进写入段时按日志补上
    const origin = { sessionId: session.id, callId: deps.callId ?? '' }
    const ledgerStep = (kind: 'rewrite' | 'supersede', snapshotId: string, writer?: string) => {
      if (deps.decisions === undefined) return []
      // 接线层启动时登记过（带它的日志）就不换；单独用流水线时在这里补上
      if (!store.hasStep(MODEL_CHANGE_STEP)) store.registerSteps(ledgerSteps(deps.decisions))
      return [modelChangeStep({ change: kind, snapshotId, at: now, origin: writer === undefined ? origin : { ...origin, by: writer } })]
    }
    // 要替代的旧记忆按写入段里读到的最新版算：改前快照拍的是这一版，预读之后别处给它加的锁、改的注入档位撤销时还在；
    // 其间不在用了、搬走了、被改写过（修改时间变了）的不替代
    const latest = await Promise.all(replaced.map(old => store.get(old.id, { workspacePath: old.workspacePath })))
    replaced = latest.filter((r, i): r is MemoryRecord => r !== undefined && r.status === 'active' && isSameScope(r) && r.updatedAt === replaced[i]!.updatedAt)
    let topicNotes = await saveTopicWarnings(input, deps, scopeOfMemory(target ?? parsed.data)!, target?.id ?? parsed.data.id)
    let clean: MemoryRecord
    // 改写、替代前的快照（快照先行）：改写的目标与要替代的旧记忆同拍一份，对话卡与右侧栏的「撤销修改」按它恢复
    let snapshotId: string | undefined
    // 要挂的关联和前提在写入段里核对：核对和落盘之间别的写入插不进来，期间被删掉、搬走的这里就看得到
    let links: ResolvedLinks | undefined
    if (hasLinks(candidate)) {
      const owner = candidate.action === 'create' ? { id: parsed.data.id, scope: scopeOfMemory(parsed.data)! } : { id: target!.id, scope: scopeOfMemory(target!)! }
      const checked = await resolveLinks(store, owner, candidate)
      if ('problem' in checked) return linkRejection(checked.problem)
      links = checked
    }
    if (candidate.action === 'create') {
      let created = parsed.data
      if (links !== undefined) {
        const merged = mergeLinks({}, links)
        if ('problem' in merged) return linkRejection(merged.problem)
        created = { ...created, ...merged.fields }
      }
      snapshotId = replaced.length === 0 ? undefined : (await deps.snapshots.capture({
        operation: 'pre-update', description: `替代记忆 ${replaced.map(r => r.id).join('、')} 前`, records: replaced,
      }, now)).id
      clean = pruneUndefined(created)
      // 新 id 不定位（create 排他占名）
      const op = newWriteOp({ topic: topicIntent(input, deps) })
      await store.create(clean, op)
      if (input.topic !== undefined && store.hasUnfinishedOwnStep(op.id, INDEX_ROW_STEP)) topicNotes = topicNote('topic-pending')
      await store.finishOp(op, clean)
    } else {
      // 落盘走不带前台门禁的原语：锁内重读、复核目标还在原处（期间被删除、归档、提升、移走的不写）、改前快照、
      // 按改动性质在最新版上拼记录、状态变化留历史版本都在里面。子 agent 的归属按锁内那一份再判：其间被接受、提升的一并拦下。
      // 预读之后内容被别处改过不拦：整条替换照常落盘，被盖掉的那一版在改前快照里；精确修改在最新正文上重做一次。
      // 有效期先后和密钥检测按合并后的记录在锁内重做，过不了就不写
      let isRebased = false
      const committed = await commitChange<PipelineResult>({
        target: target!, kind: change!, anchor, by, at: now, topic: topicIntent(input, deps),
        prepare: (current) => {
          let content = candidate.content
          if (resolved.edits !== undefined && current.content !== target!.content) {
            const applied = editTarget(current, resolved.edits)
            if ('code' in applied) return { stop: { kind: 'rejected', ...applied, subcode: 'changed-after-read', reason: `保存期间这条记忆被别处改过。${applied.reason}` } }
            content = applied.content
            isRebased = true
          }
          // 没传类型的精确修改沿用最新版的类型：别处把它改成这次写不了的类型，照类型那两道检查回拒绝
          if (inherited.has('type') && current.type !== target!.type) {
            const typeProblem = typeGate(current.type)
            if (typeProblem !== undefined) return { stop: { kind: 'rejected', ...typeProblem } }
          }
          const valid = resolveValidity(candidate, current, now)
          if ('code' in valid) return { stop: { kind: 'rejected', ...valid } }
          let fields = fieldsOn(current, content, valid)
          // 关联和前提追加到锁内最新的那一版上：期间别处挂上的都留着，追加后超上限就不写
          if (links !== undefined && !isCorroboration) {
            const linked = mergeLinks(current, links)
            if ('problem' in linked) return { stop: linkRejection(linked.problem) }
            fields = { ...fields, ...linked.fields }
          }
          const merged = secretGate({ ...current, ...fields })
          if ('rejected' in merged) return { stop: merged.rejected }
          suspected = merged.suspected
          return { fields }
        },
        reason: candidate.changeReason,
        // 合并窗口按会话开；认不出是哪个会话的不并
        ...(session.id !== UNKNOWN_SESSION_ID ? { sessionId: session.id } : {}),
        alsoSnapshot: replaced,
        // 补证不改内容，没有可撤的
        steps: id => isCorroboration ? [] : ledgerStep('rewrite', id),
        ...(deps.delegation !== undefined
          ? { isBlocked: (current: MemoryRecord) => current.status !== 'active' || notOwnPending(current, deps.session.id) !== undefined }
          : {}),
      }, { store, snapshots: deps.snapshots, mergeWindowMs: deps.mergeWindowMs, relatedRecheck: deps.relatedRecheck })
      if (committed.kind === 'changed') return changedAfterRead(target!.id, committed.current, deps.delegation !== undefined)
      if (committed.kind === 'stopped') return committed.stop
      if (committed.kind === 'invalid') return { kind: 'rejected', code: 'schema-invalid', reason: `字段校验失败：${committed.reason}` }
      if (committed.isTopicPending) topicNotes = topicNote('topic-pending')
      clean = committed.record
      snapshotId = committed.snapshotId
      if (!isCorroboration) {
        const before = maskSecretSurface(committed.before, { severity: 'suspected' }).content
        const after = maskSecretSurface(clean, { severity: 'suspected' }).content
        const lost = lostFacts(before, after)
        if (lost.length > 0) scopeWarnings.push({ code: 'facts-dropped', text: factsDroppedText(lost) })
        const removal = change === 'refine' ? refineRemoval(before, after) : undefined
        if (removal) scopeWarnings.push({ code: 'refine-shrank', text: refineShrankText(removal, snapshotId) })
      }
      if (isRebased) {
        scopeWarnings.push({ code: 'edit-rebased', text: `保存期间这条记忆被别处改过，这次的修改已经改在最新正文上。合并后的全文：\n${maskSecretSurface(clean).content}` })
      }
    }
    // 模型自报的警告只对 global 目标给（与以往一致）：项目记忆的快照只供界面撤销，不增加给模型的文字
    const updateSnapshotId = candidate.action === 'update' && target!.scope === 'global' ? snapshotId : undefined

    // 6. supersedes 处理：读到时在用的同作用域目标置 superseded（见上方 replaced）；锁内再看一次，其间被删除、被取代、
    // 被改过（和上面拍快照时读到的不是同一版）或搬到别的作用域的不动
    for (const old of replaced) {
      try {
        const op = snapshotId === undefined ? undefined : newWriteOp({ steps: ledgerStep('supersede', snapshotId, clean.id) })
        const written = await store.update(old, (r) => {
          // 抛出即不写（同 updateIfLive）
          if (r.status !== 'active' || !isSameRecord(r, old) || !isSameScope(r)) throw new RecordNotFoundError(r.id)
          return { ...r, status: 'superseded', updatedAt: now }
        }, undefined, op)
        if (op !== undefined) await store.finishOp(op, written)
      } catch (err) {
        if (!(err instanceof RecordNotFoundError)) throw err   // 读到之后被别处动过：静默跳过
      }
    }

    if (deps.hints) {
      if (candidate.action === 'create' && session.id !== UNKNOWN_SESSION_ID && session.turnStartSeq !== undefined
        && deps.hints.noteCreate(session.turnStartSeq) === TURN_CREATE_HINT_AT) {
        scopeWarnings.push({ code: 'turn-third-save', text: turnThirdSaveText() })
      }
      if (!isCorroboration && isContentLong(clean.content) && deps.hints.claimLengthHint(clean.id)) {
        scopeWarnings.push({ code: 'content-long', text: contentLongText(clean.content.length) })
      }
    }
    const baseResult = candidate.action === 'update'
      ? { kind: 'updated' as const, record: clean }
      : { kind: 'saved' as const, record: clean, ...(similar.length > 0 ? { similar } : {}) }

    const warnings: SaveWarning[] = [
      ...topicNotes,
      ...subagent.warnings,
      ...scopeWarnings,
      ...(hasCrossScopeSupersede
        ? [{ code: 'cross-bucket-supersede' as const, text: '不允许跨作用域替代：supersedes 目标和本次写入的记忆不在同一作用域，已跳过不置 superseded。global 记忆的矛盾走 memory_scan 的冲突裁决，跨层提升合并走 memory_promote' }]
        : []),
      ...(updateSnapshotId
        ? [{ code: 'auto-snapshot' as const, text: `已自动快照（${updateSnapshotId}），14 天内可用 memory_snapshot 恢复` }]
        : []),
      ...(suspected.length > 0
        ? [{ code: 'secret-suspected' as const, text: `疑似密钥（${suspected.map(h => h.name).join('、')}），建议改写后再存——记忆将来可能随同步离开本机` }]
        : []),
    ]
    if (warnings.length > 0) return { ...baseResult, warnings }

    return baseResult
  })
}
