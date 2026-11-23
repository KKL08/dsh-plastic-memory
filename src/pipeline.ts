import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { applyEdits, type SaveEdit } from './edits.ts'
import type { MemoryRecord, SourceMode } from './record-schema.ts'
import type { CodedNote, RejectCode, WarningCode } from './contract-codes.ts'
import { ALREADY_REVIEWED_REASON, CONFIDENCE_BY_SOURCE, NOT_DELEGATED_REASON, isPendingDelegated, memoryRecordSchema } from './record-schema.ts'
import type { MemoryStore } from './store.ts'
import { newWriteOp } from './storage/table.ts'
import { MODEL_CHANGE_STEP, ledgerSteps, modelChangeStep } from './governance/op-steps.ts'
import type { TypeRegistry } from './type-registry.ts'
import type { PendingDecisionsStore } from './governance/decisions.ts'
import type { SnapshotStore } from './governance/snapshots.ts'
import { detectSecrets, maskSecretSurface } from './secrets.ts'
import { RecordNotFoundError } from './errors.ts'
import { extractEntities, textSimilarity, DUPLICATE_SIMILARITY_THRESHOLD } from './text.ts'
import { toToolOutput } from './output.ts'
import { VALIDITY_DATE_FORMAT, VALIDITY_FORMAT, formatValidity, parseValidityInput, roundValidity } from './validity.ts'

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
  force?: boolean
  /** update 的目标是全局记忆时，模型确认这次改动对所有项目都成立：填引导里给的确认码（见 globalConfirmCode）；项目会话里不带或不对就回引导、不写入。 */
  confirmGlobal?: string
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
  | { kind: 'saved'; record: MemoryRecord; warnings?: SaveWarning[] }
  | { kind: 'updated'; record: MemoryRecord; warnings?: SaveWarning[] }
  /** isFromSubagent：子 agent 撞上主档，改不了也不能 force，结果文案改为让它向委派方说明分歧。 */
  | { kind: 'duplicate-suspected'; existing: Array<{ id: string; summary: string }>; isFromSubagent?: true }
  | { kind: 'rejected'; code: RejectCode; reason: string; subcode?: SaveRejectSubcode }

/**
 * 同一个拒绝码下再分的内部子码：只给测试和日志区分分支，不是工具契约的稳定标识符（稳定码见 contract-codes.ts）。
 * changed-after-read：update 读到目标之后、写入之前，目标被别处改过或删掉了，这次没写。
 * subagent-*：子 agent 写入约束的各条（都回 subagent-restricted），见 checkSubagentWrite。
 */
export type SaveRejectSubcode =
  | 'changed-after-read'
  | 'subagent-source-mode'
  | 'subagent-type'
  | 'subagent-supersedes'
  | 'subagent-force'
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

/**
 * 项目会话里改全局记忆、确认码缺省或不对时回给模型的引导（renderSaveResult 前面接「未保存：」）。点名这条记忆、带上它现在的码，
 * 同时改几条时模型分得清哪个码给哪条；码不对时先说明，模型照着新码重发一次就能写。
 */
export function globalUpdateGuide(target: MemoryRecord, code: string, given: string | undefined): string {
  const name = maskSecretSurface(target, { severity: 'suspected' }).name.replace(/\s+/g, ' ').trim()
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
  if (given.validTo !== undefined && given.validTo <= now) {
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
 */
function checkUpdateTarget(id: string | undefined, target: MemoryRecord | undefined, workspacePath: string | undefined): { target: MemoryRecord } | Rejection {
  if (!target || target.status === 'deleted') {
    return { code: 'target-missing', reason: `更新目标不存在或已删除：${id ?? '(缺 id)'}` }
  }
  if (target.scope === 'workspace' && target.workspacePath !== workspacePath) {
    return { code: 'cross-workspace', reason: `不能跨项目修改其他 workspace 的记忆：目标属于 ${target.workspacePath ?? '(未知项目)'}，当前会话在 ${workspacePath ?? '(无工作目录)'}。请在该项目的会话里更新。` }
  }
  return { target }
}

const WHOLE_WRITE_REQUIRED = ['name', 'type', 'scope', 'content', 'summary'] as const

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
 * 读到目标后在它的正文上应用 edits，没传的字段沿用目标的，返回的 base 就是这份读数——后面写入时的读后被改复核以它为准，
 * 别处在这之后改过就不拿旧读数算出的正文去盖。
 */
async function resolveInput(input: SaveInput, deps: PipelineDeps): Promise<{ candidate: SaveCandidate; base?: MemoryRecord } | Rejection> {
  const { edits, ...rest } = input
  if (edits === undefined) {
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
  if (edits.length === 0) return invalid('edits 是空的，至少写一处修改。')
  for (const [i, edit] of edits.entries()) {
    if (edit.oldString === '') return invalid(`第 ${i + 1} 处修改的 oldString 是空的：写出要替换的那段原文；要在某处加内容，把那处原文写进 oldString，newString 写原文加上新内容。`)
    if (edit.oldString === edit.newString) return invalid(`第 ${i + 1} 处修改的 oldString 和 newString 一样，没有改动。`)
  }
  const read = input.id === undefined ? undefined : await deps.store.get(input.id, { workspacePath: deps.workspacePath })
  // 子 agent 先看能不能改这条，再比对原文：改不了的不回找不到原文、不贴正文让它重试
  const notWritable = deps.delegation ? subagentTargetProblem(input.id ?? '(缺 id)', read, deps.session.id) : undefined
  if (notWritable !== undefined) return notWritable
  const checked = checkUpdateTarget(input.id, read, deps.workspacePath)
  if ('code' in checked) return checked
  const { target } = checked
  const applied = editTarget(target, edits)
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
  return { candidate, base: target }
}

/** 子 agent 能用的依据：它收到的指令来自委派方，用户明说、用户行为、经用户确认的动作都无从谈起。 */
const SUBAGENT_SOURCE_MODES: readonly SourceMode[] = ['environment-observed', 'agent-inferred']
/** 子 agent 能写的类型（还要在当前场景里）：事实，和观察到的项目状态。 */
const SUBAGENT_TYPES = ['knowledge', 'project']
/** 每个子会话最多新建几条：配置项 subagent.maxSavesPerSession 的缺省值，工具说明照它写。 */
export const SUBAGENT_MAX_SAVES_DEFAULT = 10

/**
 * update 写入那一刻发现目标在读到之后被改过：按目标此刻的样子回拒绝。原因会进模型上下文，当前内容按注入的口径遮明确密钥。
 * 子 agent 照旧回 subagent-restricted、带回主会话；主会话（删掉、被别的会话或用户改过、提升、取代）回 target-missing。
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

/** 召回统计之外整条相等。update 锁内复核用：清候选标记、搬作用域这类改动不碰 updatedAt，也要算改过。 */
function isSameRecord(a: MemoryRecord, b: MemoryRecord): boolean {
  const { recallCount: _ra, lastRecalledAt: _la, ...restA } = a
  const { recallCount: _rb, lastRecalledAt: _lb, ...restB } = b
  return isDeepStrictEqual(restA, restB)
}

/**
 * 子 agent 写入约束：主会话不经过这里。一个判断块、一个拒绝码 subagent-restricted，原因按条写明怎么改或带回主会话。
 * 顺序固定：scope 降级（只警告）→ 依据 → 类型 → supersedes / force → update 归属 → create 配额，同时犯多条时报最前的。
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
  const writable = SUBAGENT_TYPES.filter(t => deps.registry.has(t))
  if (!writable.includes(candidate.type)) {
    const shown = writable.length > 0 ? `当前场景里能写：${writable.join('、')}` : '当前场景里两类都没有'
    return {
      code: 'subagent-restricted',
      subcode: 'subagent-type',
      reason: `子 agent 只能写 knowledge、project 两类，且要在当前场景里（${shown}）；"${candidate.type}" 不行，这件事带回主会话。`,
    }
  }
  if ((candidate.supersedes ?? []).length > 0) {
    return { code: 'subagent-restricted', subcode: 'subagent-supersedes', reason: '子 agent 不能用 supersedes 替代旧记忆；去掉 supersedes 重发，要替代哪条带回主会话。' }
  }
  // force 放行的两道检查（去重、疑似密钥）都要用户点头，子 agent 问不到用户
  if (candidate.force) {
    return {
      code: 'subagent-restricted',
      subcode: 'subagent-force',
      reason: '子 agent 不能带 force：去重、疑似密钥两道检查子 agent 都过不去。撞重复就另存或放弃，疑似密钥一律不存；去掉 force 重发。',
    }
  }
  // update 只改本会话存下、还没升档的。写入时在存储锁内按最新读数再判一次（见下方 put 的 skipIf），其间被接受、删除、提升的不覆盖
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

export async function runSavePipeline(
  input: SaveInput,
  deps: {
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
    /** 写入时刻（createdAt、updatedAt、有效期、快照与撤销记录）的时钟，缺省取当前时间。 */
    now?: () => number
  },
): Promise<PipelineResult> {
  const { store, registry, session } = deps
  const now = deps.now?.() ?? Date.now()

  // 0. 入参补成完整候选（精确修改在这里读目标、算出新正文），再过子 agent 写入约束（主会话没有 delegation，原样往下走）
  const resolved = await resolveInput(input, deps)
  if ('code' in resolved) return { kind: 'rejected', ...resolved }
  const subagent = deps.delegation ? await checkSubagentWrite(resolved.candidate, deps) : { candidate: resolved.candidate, warnings: [] }
  if ('code' in subagent) return { kind: 'rejected', ...subagent }
  const { candidate } = subagent

  // 1. 格式校验
  if (!registry.has(candidate.type)) {
    return { kind: 'rejected', code: 'unknown-type', reason: `未知类型 "${candidate.type}"，可用类型见工具说明` }
  }
  // 模型无 global 直写通道：新建时填 global → 降级 workspace + globalCandidate 标记，
  // 真正提升到 global 只能走 memory_promote（用户确认）。
  let scope = candidate.scope
  let globalCandidate: true | undefined
  const scopeWarnings: SaveWarning[] = []
  let target: MemoryRecord | undefined
  if (candidate.action === 'update') {
    // 精确修改用算新正文时的那份读数，不再读一次：之后的改动都要在写入时的复核里拦下
    const checked = resolved.base !== undefined
      ? { target: resolved.base }
      : checkUpdateTarget(candidate.id, candidate.id ? await store.get(candidate.id, { workspacePath: deps.workspacePath }) : undefined, deps.workspacePath)
    if ('code' in checked) return { kind: 'rejected', ...checked }
    target = checked.target
    // scope 不随 update 变更——否则例行内容更新会把用户确认提升过的 global 记忆
    // 静默拉回当前项目（提升闸被写入链绕过）。降级同样没有免确认通道。
    scope = target.scope
    // 全局记忆注入所有项目的会话：项目会话里改它，先要模型判断这次的内容对所有项目都成立（带引导里的确认码重发），
    // 只对当前项目成立的改存项目记忆。码按改写前的这份目标算，和锁内复核比的是同一份。没有工作目录的会话没有项目记忆可选，
    // 全局是唯一去处，不拦。码对了之后别的检查没过，照常回那条检查的原因
    if (target.scope === 'global' && deps.workspacePath !== undefined) {
      const code = globalConfirmCode(session.id, target)
      if (!isConfirmCodeMatch(candidate.confirmGlobal, code)) {
        return { kind: 'rejected', code: 'global-update-unconfirmed', reason: globalUpdateGuide(target, code, candidate.confirmGlobal) }
      }
    }
    if (candidate.scope === 'global' && target.scope === 'workspace') {
      // 模型对 workspace 记录重申 global 意图：转成提升候选（已是候选则静默幂等）
      if (!target.globalCandidate) {
        globalCandidate = true
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

  // 有效期：换算成毫秒并校验，不合格的拒存、告诉模型怎么改；两个都没传时取值与以往一致（update 保留原值）
  const validity = resolveValidity(candidate, target, now)
  if ('code' in validity) return { kind: 'rejected', ...validity }

  // 本次要标 superseded 的旧记忆：目标必须与本次写入记录同属一个作用域——跨作用域替代会绕过用户确认闸、无快照、无复活路径，
  // 作用域不同的目标跳过不置 superseded，仅给一条警告。目标不存在维持静默跳过；只替代在用的，已删除的留在最近删除、
  // 照常过期清走，已被取代的原样不动。本次写入记录的作用域此时已定：update 继承目标，create 落当前项目（global 已降级为候选）。
  const writeScope = candidate.action === 'update'
    ? { scope: target!.scope, workspacePath: target!.workspacePath }
    : { scope, workspacePath: scope === 'workspace' ? deps.workspacePath : undefined }
  const isSameScope = (old: MemoryRecord) => old.scope === writeScope.scope
    && (writeScope.scope !== 'workspace' || old.workspacePath === writeScope.workspacePath)
  const replaced: MemoryRecord[] = []
  let hasCrossScopeSupersede = false
  for (const oldId of new Set(candidate.supersedes ?? [])) {
    const old = await store.get(oldId, { workspacePath: deps.workspacePath })
    if (old === undefined || old.id === target?.id) continue
    if (!isSameScope(old)) hasCrossScopeSupersede = true
    else if (old.status === 'active') replaced.push(old)
  }

  // 2. confidence 决议：只能下调
  const cap = CONFIDENCE_BY_SOURCE[candidate.sourceMode]
  const confidence = Math.min(candidate.confidence ?? cap, cap)

  // 3. 结构去重（仅 create，force 跳过）：实体重叠与 bigram 相似度级联，非两轴恒开。
  // 实体是强信号；bigram 相似度只定位为实体盲区的兜底（纯中文散文提不出实体，实体轴对它失明）。
  // 两轴恒开会对有实体的记忆产生"同主题不同事实"的误判，故有实体时只走实体轴，实体为空才落 Dice 轴。
  if (candidate.action === 'create' && !candidate.force) {
    const text = `${candidate.content}\n${candidate.summary}`
    const entities = extractEntities(text)
    const peers = await store.query({
      types: [candidate.type],
      scope: { kind: 'workspace', workspacePath: deps.workspacePath! }, // create 必有 workspace 作用域（前置已拒无 cwd）
      status: ['active'],
    })
    // 子 agent 只和主档比：待确认记录之间的分歧留给主会话接受时裁决，两条并存。这次要替代的旧记忆随即失效，不算重复
    const replacedIds = new Set(replaced.map(r => r.id))
    const hits = peers.filter(p => !replacedIds.has(p.id) && !(deps.delegation && isPendingDelegated(p))).filter(p => {
      const peerText = `${p.content}\n${p.summary}`
      if (entities.length > 0) return extractEntities(peerText).some(e => entities.includes(e))
      return textSimilarity(text, peerText) >= DUPLICATE_SIMILARITY_THRESHOLD
    })
    if (hits.length > 0) {
      const existing = hits.map(h => ({ id: h.id, summary: maskSecretSurface(h).summary }))
      return deps.delegation ? { kind: 'duplicate-suspected', existing, isFromSubagent: true } : { kind: 'duplicate-suspected', existing }
    }
  }

  // 4. 持久化（写入前必须过 schema——KvTable.put 不校验，脏记录会让下次 domain open 整库拒载）
  // 证据锚（这条记忆出自会话的哪段事件）：eventRange = [当轮 turn/start, save 时刻]，两个数都是机械事实。
  // 模型上下文里没有 seq 标注，任何模型填的区间都是编造——锚只能由绑定层填。
  const anchorStart = Math.min(session.turnStartSeq ?? 0, session.lastSeq)
  const source = { sessionId: session.id, eventRange: [anchorStart, session.lastSeq] as [number, number], sourceMode: candidate.sourceMode }
  let record: MemoryRecord
  if (candidate.action === 'update') {
    // scope/workspacePath 从 target 原样继承（见上方 scope 决议），不吃当前会话上下文
    record = {
      ...target!,
      name: candidate.name, type: candidate.type, tags: candidate.tags,
      content: candidate.content, summary: candidate.summary,
      source, confidence,
      // 可选字段统一"不传即保留"：update 是内容编辑，不重传 validTo 就清掉时效窗口
      // 会让有时效的记忆变成永不过期（有效期的回退在 resolveValidity 里）
      validFrom: validity.validFrom,
      validTo: validity.validTo,
      updatedAt: now, lastConfirmedAt: now,
      supersedes: candidate.supersedes ?? target!.supersedes,
      globalCandidate: globalCandidate || target!.globalCandidate,
      // 创建者四个字段永不改。子 agent 改写：内容仍是子级写的，reviewed 一律去掉（回到待确认）；
      // 主会话改写待确认记录即升档：reviewed 缺省时补 main，已有的（用户改过、早先接受过）不动
      delegation: deps.delegation
        ? target!.delegation && { ...target!.delegation, reviewed: undefined }
        : target!.delegation && { ...target!.delegation, reviewed: target!.delegation.reviewed ?? { by: 'main', at: now } },
    }
  } else {
    record = {
      id: `mem_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: candidate.name, type: candidate.type, scope,
      workspacePath: scope === 'workspace' ? deps.workspacePath : undefined,
      tags: candidate.tags, content: candidate.content, summary: candidate.summary,
      source, createdAt: now, updatedAt: now, lastConfirmedAt: now,
      lastRecalledAt: null, recallCount: 0,
      validFrom: validity.validFrom, validTo: validity.validTo,
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

  // 5. 写盘前 secret 检查：高危（明确厂商特征）直接拦截、不落盘；疑似拦下待确认，force 放行并保留警告。
  // summary 进注入索引、name 进文件名、tags 进索引行——密钥藏在哪个字段都会外泄，四个面一起查；
  // supersedes 落进文件、体检的孤儿说明会把它引出来，一并查。
  const secretHits = detectSecrets(`${candidate.content}\n${candidate.name}\n${candidate.summary}\n${candidate.tags.join(' ')}\n${(candidate.supersedes ?? []).join(' ')}`)
  const critical = secretHits.filter(h => h.severity === 'critical')
  if (critical.length > 0) {
    return {
      kind: 'rejected',
      code: 'secret-critical',
      reason: `检测到高危密钥（${critical.map(h => h.name).join('、')}），未保存。密钥不该进记忆（将来可能随同步离开本机）——如需记录，请改写成不含密钥的指针（如「AWS 凭证在 1Password 的 X 条目」）再存。`,
    }
  }
  const suspected = secretHits.filter(h => h.severity === 'suspected')
  if (suspected.length > 0 && !candidate.force) {
    return {
      kind: 'rejected',
      code: 'secret-suspected',
      reason: deps.delegation
        ? `检测到疑似密钥（${suspected.map(h => h.name).join('、')}），未保存。疑似密钥一律不存：改写成不含密钥的指针再存，不是密钥的带回主会话。`
        : `检测到疑似密钥（${suspected.map(h => h.name).join('、')}），未保存。是密钥就改写成不含密钥的指针再存；向用户确认不是密钥后，带 force: true 重发。`,
    }
  }

  // 从拍快照到记账本是一条记忆的一次改动，整段在一个写入段里：中途拿锁超时不会写了文件却没留撤销，
  // 同进程别的写入也插不进中间。段内只读写文件，不等模型
  return await store.writeSection(async () => {
    // 改写、替代前拍快照（快照先行）：forget 有 14 天快照，update 覆盖旧内容、supersedes 让旧记忆失效却无恢复手段是
    // 不对称的。global、workspace 目标都拍，改写的目标与要替代的旧记忆同拍一份；对话卡与右侧栏的「撤销修改」按它恢复。
    const changed = [...(candidate.action === 'update' ? [target!] : []), ...replaced]
    const snapshot = changed.length > 0
      ? await deps.snapshots.capture({
        operation: 'pre-update',
        description: candidate.action === 'update' ? `更新记忆 ${target!.id} 前` : `替代记忆 ${replaced.map(r => r.id).join('、')} 前`,
        records: changed,
      }, now)
      : undefined
    // 模型自报的警告只对 global 目标给（与以往一致）：项目记忆的快照只供界面撤销，不增加给模型的文字
    const updateSnapshotId = candidate.action === 'update' && target!.scope === 'global' ? snapshot?.id : undefined

    const clean = pruneUndefined(parsed.data)
    // 新 id 不定位（create 排他占名）；update 走 put：锁内定位旧文件，scope 没变就原地覆盖。
    // 锁内复核：读到目标之后它又被改过（召回统计之外有字段不同，按位置看已归档，或已不在可见集合里）就不写——界面直接改、
    // 别的会话改写、删除、归档、提升、清候选标记夹在读和写之间时，整条替换会把它们盖掉。只删了本层、定位落到别层同 id 副本的，
    // 作用域不同同样拦下。子 agent 改写的归属已按读到的目标判过，其间被接受、提升的在这里一并拦下
    // 撤销记录是写成之后才补的账：随这次写入登记成提交后的步骤，写完就做；中途被打断，下一次进写入段时按日志补上
    const origin = { sessionId: session.id, callId: deps.callId ?? '' }
    const ledgerOp = (change: 'rewrite' | 'supersede', by?: string) => {
      if (snapshot === undefined || deps.decisions === undefined) return undefined
      // 接线层启动时登记过（带它的日志）就不换；单独用流水线时在这里补上
      if (!store.hasStep(MODEL_CHANGE_STEP)) store.registerSteps(ledgerSteps(deps.decisions))
      return newWriteOp({ steps: [modelChangeStep({ change, snapshotId: snapshot.id, at: now, origin: by === undefined ? origin : { ...origin, by } })] })
    }
    if (candidate.action === 'create') await store.create(clean)
    else {
      const seen: { current?: MemoryRecord } = {}
      const isChangedSinceRead = (current: MemoryRecord | undefined) => {
        seen.current = current
        if (current === undefined || !isSameRecord(current, target!)) return true
        // 子 agent 的归属按锁内这一份再判：归属检查之后、target 读到之前被接受的，target 本身已是接受后的版本
        return deps.delegation !== undefined && (current.status !== 'active' || notOwnPending(current, deps.session.id) !== undefined)
      }
      const op = ledgerOp('rewrite')
      const rewritten = await store.put(clean, undefined, isChangedSinceRead, op)
      if (rewritten === undefined) return changedAfterRead(clean.id, seen.current, deps.delegation !== undefined)
      // 指纹按这次写下的那条（put 的返回值），撤销前据此确认之后没被别处改过
      if (op !== undefined) await store.finishOp(op, rewritten)
    }

    // 6. supersedes 处理：读到时在用的同作用域目标置 superseded（见上方 replaced）；锁内再看一次，其间被删除、被取代、
    // 被改写或搬到别的作用域的不动
    for (const old of replaced) {
      try {
        const op = ledgerOp('supersede', clean.id)
        const written = await store.update(old, (r) => {
          // 抛出即不写（同 updateIfLive）
          if (r.status !== 'active' || r.updatedAt !== old.updatedAt || !isSameScope(r)) throw new RecordNotFoundError(r.id)
          return { ...r, status: 'superseded', updatedAt: now }
        }, undefined, op)
        if (op !== undefined) await store.finishOp(op, written)
      } catch (err) {
        if (!(err instanceof RecordNotFoundError)) throw err   // 读到之后被别处动过：静默跳过
      }
    }

    const baseResult = candidate.action === 'update'
      ? { kind: 'updated' as const, record: clean }
      : { kind: 'saved' as const, record: clean }

    const warnings: SaveWarning[] = [
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
