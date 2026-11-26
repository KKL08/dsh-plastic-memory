import { anchorsOf, anchorSourceMode, readChangeKind, type MemoryRecord } from '../record-schema.ts'
import { injectionText } from '../index-line.ts'
import { isExpired } from '../record-freshness.ts'
import { SEVERITY_BY_TYPE, type Finding } from './schema.ts'
import { maskDiagnostic, maskSecretSurface, maskSecrets } from '../secrets.ts'
import { estimateTokens } from '../snapshot.ts'
import { formatValidity } from '../validity.ts'
import { SCAN_CONTENT_FIELDS, type ScanContentField } from './changeset.ts'

/** 语义层的 LLM 抽象：纯逻辑只依赖这个接口，真机接线在 index.ts。 */
export interface SemanticLlm {
  /** 解析出的模型名（「让模型改」写在界面上）；宿主接线总会带上，测试桩可以不给。 */
  readonly model?: string
  /** 提供方（宿主的路由名）；宿主接线总会带上，测试桩可以不给。体检的判断上下文按它区分结果。 */
  readonly provider?: string
  /** 推理强度（宿主适配器的取值）；借会话的模型拿不到，缺省。 */
  readonly reasoningEffort?: string
  /**
   * signal 触发时应尽快取消在途请求，并抛出 AbortError（宿主 exec.signal 契约）。
   * onUsage：宿主流里报了用量时，按这次调用的实际 token 数回调一次（宿主在出错收尾前报了用量的也计入）；没报就不回调。
   */
  complete(input: { system: string; user: string }, signal?: AbortSignal, onUsage?: (tokens: number) => void): Promise<string>
}

/** 宿主流 usage 块的形状（宿主 TokenUsage 的子集）：各项互不重叠，缓存读写不算进 inputTokens。 */
export interface ReportedUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 一次调用的实际用量：有 totalTokens 用它，否则输入、缓存读写、输出相加。数不合法时返回 undefined，不算。 */
export function reportedTokens(usage: ReportedUsage): number | undefined {
  const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
  if (!parts.every(isCount)) return undefined
  if (usage.totalTokens !== undefined) return isCount(usage.totalTokens) ? usage.totalTokens : undefined
  return parts.reduce((a, b) => a + b, 0)
}

/** 取消判定：signal 已 abort，或捕获到的错误本身就是 AbortError。取消不降级、直接向上抛。 */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === 'AbortError')
}

/**
 * 体检提示词的版本：改系统提示词、记忆行格式（semanticMemoryLine）或基线段落的写法时加一。
 * 体检结果按它区分，换了版本，按旧提示词查出的结论不再沿用。
 */
export const SEMANTIC_PROMPT_VERSION = 4

/** 一次调用里记忆列表的 token 预算（snapshot.estimateTokens 估算）。整库塞进一条消息会撑爆上下文窗口，超了就分批。 */
export const SEMANTIC_BATCH_TOKEN_BUDGET = 30_000

const SEMANTIC_TYPES = new Set(['conflict', 'missed-change', 'exception', 'redundancy', 'misplaced', 'unclear'])

const SYSTEM_PROMPT = `你是记忆库治理审查员。对给出的记忆列表检查以下六类问题。

两条说法对不上时，依次判断：
1. 先看适用范围，横向两条记忆、纵向记忆与基线都适用：通用规则和更窄范围的特别做法能同时成立，报 exception（例外）。
2. 再看时间，这一步只比较两条记忆：结合 recordedAt、factTime、validFrom、validTo、lastChange、versions，若一条是旧状态、一条是新状态，报 missed-change（漏记的变化），current 填代表现在状态那条记忆的 id。
3. 横向两条记忆、纵向记忆与基线在同一范围、同一时间条件下互相排斥，报 conflict（冲突）；纵向以权威配置基线为准。

- conflict、exception：横向 memoryIds 填两条；纵向填一条，并用 baselineRef 注明基线出处。
- missed-change：memoryIds 填两条不同的记忆，current 填其中代表当前状态那条记忆的 id；这类发现只比较记忆，输出字段为 type、memoryIds、summary、suggestedAction、current。
- redundancy 冗余：删掉其中一条，模型行为不变；记忆与基线重复也算，纵向 memoryIds 填一条，baselineRef 注明基线出处。解释为什么的记忆有独立价值，判断时保留这份价值。
- misplaced 错位：项目特定的记忆放了 global，或全局偏好锁在了项目里。
- unclear 模糊：新会话没有额外上下文时无法据此行动；或者只有一句结论，看不出是在什么情况下定的，因此判断不了它管到哪里。短本身不算问题；看得出管到哪里、也能照着做的短记忆不报。

recordedAt 是记下这条记忆的时间；事情发生的时间看 factTime，生效时间看 validFrom、validTo。lastChange 是最近一次改动的性质。versions 是这条已有的历史版本数，unknown 表示数量读不出。结合这些时间和改动线索判断新旧状态。
sourceMode 是内容的来源方式，用来判断依据的可靠度。
summary、suggestedAction 是给用户看的：提到记忆时写它的 name，id 只写在 memoryIds 里。

只报有把握的问题。只输出 JSON，格式：
{"findings":[{"type":"missed-change","memoryIds":["mem_x","mem_y"],"summary":"一句话描述","suggestedAction":"建议动作","current":"mem_y"},{"type":"conflict","memoryIds":["mem_z"],"summary":"一句话描述","suggestedAction":"建议动作","baselineRef":"AGENTS.md：某规则"}]}
没有问题输出 {"findings":[]}`

/**
 * 一批的提示词。project：这次检查的项目（检查全局时不给）。给了就在基线前写明检查的是哪个项目、基线是它的指令文件：
 * 「全部」体检时各项目依次检查，不点明的话，指令文件里的「本项目」归属只能靠模型从记忆行的路径去猜。
 */
export function buildSemanticPrompt(
  records: MemoryRecord[],
  baseline: readonly string[] | null,
  project?: string,
  /**
   * 每条记忆的历史版本数（按 id）：大于 0 的在记忆行里写 versions 一行，读不出的写 unknown，0 和没给的不写。
   * 体检时由调用方按记忆所在层的历史现读；不给时整批都不写这一行。
   */
  versions?: VersionCounts,
): { system: string; user: string } {
  // 判断冲突用不到密钥原值，明确密钥不发给模型（与注入同口径）。指令文件整份原样给：长度由读取时的上限管，超了另有截断说明
  const baselineSection = baseline
    ? `## 权威配置基线（AGENTS.md/CLAUDE.md）\n${baseline.map(m => maskSecrets(m)).join('\n\n')}`
    : '## 权威配置基线\n（无权威配置基线，跳过垂直冲突检测）'
  return {
    system: SYSTEM_PROMPT,
    user: `${project !== undefined ? `${projectSection(maskSecrets(project), baseline !== null)}\n\n` : ''}${baselineSection}\n\n## 记忆列表（共 ${records.length} 条）\n${records.map(r => {
      const count = versions?.get(r.id)
      return semanticMemoryLine(r) + (count === 'unknown' || (count !== undefined && count > 0) ? `\n  versions: ${count}` : '')
    }).join('\n')}`,
  }
}

/** 检查项目时放在基线前的一段：检查的是哪个项目；有基线时说明基线是这个项目的指令文件、怎么用它。 */
function projectSection(project: string, hasBaseline: boolean): string {
  const lines = [`## 这次检查的项目\n这次检查的是项目 ${project} 的记忆，列表里也会带上全局记忆供跨层对照。`]
  if (hasBaseline) {
    lines.push(`下面的基线是项目 ${project} 的指令文件（含全局层），基线里说的「本项目」「这个项目」都指 ${project}。对照基线检查项目记忆与它有没有冲突、冗余。`)
  }
  return lines.join('\n')
}

/**
 * 记忆列表里一条的各个内容字段，按 SCAN_CONTENT_FIELDS（扫描指纹也含这份清单）：类型写在首行，名称、正文、摘要各一行，
 * 事实时间、有效期起止有才写。没有的字段返回 undefined，不写这一行。
 */
const LINE_FIELDS: Record<ScanContentField, (r: MemoryRecord) => string | undefined> = {
  type: r => r.type,
  name: r => injectionText(r.name),
  content: r => injectionText(r.content),
  summary: r => injectionText(r.summary),
  factTime: r => (r.factTime === undefined ? undefined : injectionText(maskSecrets(r.factTime))),
  validFrom: r => (r.validFrom === undefined ? undefined : formatValidity(r.validFrom)),
  validTo: r => (r.validTo === undefined ? undefined : formatValidity(r.validTo)),
}

/**
 * 记忆列表里的一条（明确密钥已遮）。分批按它估算 token，与发给模型的文字同一口径。内容字段出自 SCAN_CONTENT_FIELDS。
 * 标签不发给模型，遮盖时也不带上：只改标签时这一行不变，和批的键一致。
 */
export function semanticMemoryLine(record: MemoryRecord): string {
  const r = maskSecretSurface({ ...record, tags: [] })
  const lines = SCAN_CONTENT_FIELDS.filter(field => field !== 'type').flatMap((field) => {
    const value = LINE_FIELDS[field](r)
    return value === undefined ? [] : [`  ${field}: ${value}`]
  })
  lines.push(`  recordedAt: ${new Date(r.createdAt).toISOString().slice(0, 16)}Z`)
  const latest = anchorsOf(r)[0]
  if (latest !== undefined) lines.push(`  sourceMode: ${anchorSourceMode(latest)}`)
  const change = readChangeKind(r.lastChange?.kind)
  if (change !== undefined) lines.push(`  lastChange: ${change}`)
  return [`- id=${r.id} type=${LINE_FIELDS.type(r)} scope=${r.scope}${r.workspacePath ? `(${r.workspacePath})` : ''}`, ...lines].join('\n')
}

/** 记忆的历史版本数（按 id）：读不出的是 'unknown'。见 buildSemanticPrompt。 */
export type VersionCounts = ReadonlyMap<string, number | 'unknown'>

/** 语义检查准入：在用、没过期（还没生效的照常进）。只管交给模型的输入；规则层照旧看全部记忆。 */
export function isSemanticAdmitted(r: MemoryRecord, now: number): boolean {
  return r.status === 'active' && !isExpired(r, now)
}

/**
 * 按 token 预算把记忆分批：没有记忆时不分批（不调用模型）；装得下就一批（原顺序）。装不下时按类型分组，
 * 同类型尽量同批——冲突、重复多发生在同类型之间；一组超预算再连续切开，单条超预算的自成一批。
 * 各段依次放进第一个还装得下的批，都装不下就开新批。每条恰好进一批。
 * 分批时组按类型名、组内按 createdAt 再 id 排：改一条记忆（更新时间变了）不会挪动别的记忆所在的批，
 * 成对问题不会因为批的边界漂移在两次体检之间时有时无。
 */
export function planSemanticBatches(records: MemoryRecord[], budget = SEMANTIC_BATCH_TOKEN_BUDGET): MemoryRecord[][] {
  if (records.length === 0) return []
  const costs = new Map(records.map(r => [r, estimateTokens(semanticMemoryLine(r))]))
  const costOf = (rs: readonly MemoryRecord[]) => rs.reduce((n, r) => n + costs.get(r)!, 0)
  if (costOf(records) <= budget) return [records]

  const stable = [...records].sort((a, b) =>
    (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const groups = new Map<string, MemoryRecord[]>()
  for (const r of stable) {
    const group = groups.get(r.type)
    if (group) group.push(r)
    else groups.set(r.type, [r])
  }
  const pieces: MemoryRecord[][] = []
  for (const group of groups.values()) {
    if (costOf(group) <= budget) {
      pieces.push(group)
      continue
    }
    let piece: MemoryRecord[] = []
    let used = 0
    for (const r of group) {
      if (piece.length > 0 && used + costs.get(r)! > budget) {
        pieces.push(piece)
        piece = []
        used = 0
      }
      piece.push(r)
      used += costs.get(r)!
    }
    pieces.push(piece)
  }

  const batches: Array<{ records: MemoryRecord[]; used: number }> = []
  for (const piece of pieces) {
    const cost = costOf(piece)
    const batch = batches.find(b => b.used + cost <= budget)
    if (batch) {
      batch.records.push(...piece)
      batch.used += cost
    } else {
      batches.push({ records: [...piece], used: cost })
    }
  }
  return batches.map(b => b.records)
}

/** 模型写的说明可能引用记忆里的密钥，会进待决账本、体检缓存与工具输出：两级都遮。 */
const maskText = (text: string) => maskSecrets(text, { severity: 'suspected' })

/**
 * 给用户看的文字里模型仍写了记忆 id 的，换成「名称」（连同两侧各一个空格，引号已经隔开）：一次替换，长 id 先匹配（id 互为前缀时不错换）。
 * 体检说明和「整理所选」的计划共用；名称由调用方先遮好密钥。
 */
export function idsToNames(records: readonly { id: string; name: string }[]): (text: string) => string {
  if (records.length === 0) return text => text
  const names = new Map(records.map(r => [r.id, r.name]))
  const pattern = new RegExp(` ?(${[...names.keys()].sort((a, b) => b.length - a.length).map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}) ?`, 'g')
  return text => text.replace(pattern, (_, id: string) => `「${names.get(id)}」`)
}

/** 解析 LLM 输出。整体解析失败返回 null（触发重试）；单条非法只跳过该条。 */
export function parseSemanticFindings(raw: string, knownIds: Set<string>): Finding[] | null {
  const stripped = raw.replace(/```(?:json)?/g, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return null
  }
  const findings = (parsed as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return null

  const out: Finding[] = []
  for (const item of findings) {
    if (item === null || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const type = f.type as string
    if (!SEMANTIC_TYPES.has(type)) continue
    // 去重后再数基数：模型可能把同一 id 写两遍，["mem_c","mem_c"] 当作横向冲突的两方会让
    // keep-left 删掉保留方（右侧 id 就是左侧 id）。
    const memoryIds = [...new Set((Array.isArray(f.memoryIds) ? f.memoryIds : [])
      .filter((id): id is string => typeof id === 'string' && knownIds.has(id)))]
    if (memoryIds.length === 0) continue
    // 空字符串 baselineRef 不算"有基线"：下游 dedupKey 用真值判断、pairKey 与 executeConfirm 用
    // !== undefined 判断，两者对空字符串的态度不一致，必须在这里收口成"要么是非空字符串要么不存在"。
    const baselineRef = typeof f.baselineRef === 'string' && f.baselineRef.length > 0 ? maskText(f.baselineRef) : undefined
    if (type === 'missed-change' && (memoryIds.length !== 2 || baselineRef !== undefined)) continue
    if (type === 'conflict' || type === 'exception') {
      // 冲突的基数必须在产出侧收口——消费方 memory_confirm 的横向分支只认
      // memoryIds[0]/[1]，多出或缺少都会导致"用户以为裁决了、实际什么都没发生"。
      const horizontal = memoryIds.length === 2 && baselineRef === undefined
      const vertical = memoryIds.length === 1 && baselineRef !== undefined
      if (!horizontal && !vertical) continue
    }
    out.push({
      type: type as Finding['type'],
      layer: 'semantic',
      severity: SEVERITY_BY_TYPE[type as keyof typeof SEVERITY_BY_TYPE],
      memoryIds,
      summary: typeof f.summary === 'string' ? maskText(f.summary) : '',
      suggestedAction: typeof f.suggestedAction === 'string' ? maskText(f.suggestedAction) : '',
      ...(baselineRef !== undefined ? { baselineRef } : {}),
      ...(type === 'missed-change' && typeof f.current === 'string' && memoryIds.includes(f.current) ? { current: f.current } : {}),
    })
  }
  return out
}

/**
 * 语义层没做成的原因（最后一次尝试的）：模型调用抛错（带上错误的原话，宿主给了错误码时带上 hostCode），或输出解析不了。
 * 错误码不在这里吞掉：内容检查据它分出「模型用不了」（tools/scan.ts）。
 * 原话之后会进体检记录、视图和给模型的说明文字：AUTH 的原话可能回显部分凭据，对齐宿主不留（没有 message）；其余先遮掉疑似密钥。
 */
export type SemanticFailure =
  | { kind: 'model-error'; hostCode?: string; message?: string }
  | { kind: 'unparseable' }

/** 抛出的错误自带的错误码（宿主适配层挂在 code 上的字符串），没有为 undefined。 */
function errorCode(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/** 模型调用抛错换成没做成的原因（脱敏口径见 SemanticFailure）：处理建议的生成共用。 */
export function modelError(err: unknown): SemanticFailure {
  const hostCode = errorCode(err)
  if (hostCode === 'AUTH') return { kind: 'model-error', hostCode }
  return { kind: 'model-error', ...(hostCode !== undefined ? { hostCode } : {}), message: maskDiagnostic(err instanceof Error ? err.message : String(err)) }
}

/**
 * 语义层扫描：按 token 预算分批（planSemanticBatches），每批一次调用，解析失败带提示重试一次。
 * 单条就能判的问题每条都覆盖；成对的（冲突、重复）只在同一批里检出。任一批两次都失败，整层按失败返回
 * （failed:true、不交出别批的结果，也不再发后面的批，failure 是这一批最后一次尝试没做成的原因）。各批结果合并去重。
 * batches 是批数，不分批时为 1；没有记忆时为 0，不调用模型，按没有发现的成功扫描返回。
 */
export async function runSemanticScan(
  records: MemoryRecord[],
  baseline: readonly string[] | null,
  llm: SemanticLlm,
  signal?: AbortSignal,
  onUsage?: (tokens: number) => void,
): Promise<{ findings: Finding[]; failed: false; batches: number } | { findings: Finding[]; failed: true; batches: number; failure: SemanticFailure }> {
  const batches = planSemanticBatches(records)
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const batch of batches) {
    const found = await scanBatch(batch, baseline, llm, signal, onUsage)
    if (!Array.isArray(found)) return { findings: [], failed: true, batches: batches.length, failure: found }
    for (const f of found) {
      const key = `${f.type}|${[...f.memoryIds].sort().join('+')}|${f.baselineRef ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push(f)
    }
  }
  return { findings, failed: false, batches: batches.length }
}

/** 一批的调用：解析失败带提示重试一次，两次都不行返回重试那次没做成的原因。 */
export async function scanBatch(
  records: MemoryRecord[],
  baseline: readonly string[] | null,
  llm: SemanticLlm,
  signal: AbortSignal | undefined,
  onUsage: ((tokens: number) => void) | undefined,
  /** 这次检查的项目（见 buildSemanticPrompt）；检查全局时不给。 */
  project?: string,
  /** 这一批记忆的历史版本数（见 buildSemanticPrompt）。 */
  versions?: VersionCounts,
): Promise<Finding[] | SemanticFailure> {
  const knownIds = new Set(records.map(r => r.id))
  const prompt = buildSemanticPrompt(records, baseline, project, versions)
  const named = idsToNames(records.map(r => maskSecretSurface(r, { severity: 'suspected' })))
  const withNames = (findings: Finding[]) => findings.map(f => ({ ...f, summary: injectionText(named(f.summary)), suggestedAction: injectionText(named(f.suggestedAction)) }))

  // LLM 调用本身可能抛（限流/超时/上下文超限/网络），必须与"输出无法解析"同等降级——
  // 否则 layers=full 时已经算好的规则层结果会被一起丢掉。
  let firstRaw: string | null = null
  try {
    firstRaw = await llm.complete(prompt, signal, onUsage)
  } catch (err) {
    // 用户取消不降级也不重试：立即向上抛，让工具结果标记为 isError（宿主 exec.signal 契约）。
    if (isAbort(err, signal)) throw err
    // 普通错误落到下面的重试
  }
  const first = firstRaw === null ? null : parseSemanticFindings(firstRaw, knownIds)
  if (first !== null) return withNames(first)

  // 同上：重试调用本身也可能抛，与"重试输出仍无法解析"同等降级为失败。
  let retryRaw: string
  try {
    retryRaw = await llm.complete({ system: prompt.system, user: `${prompt.user}\n\n上次输出无法解析，请只输出 JSON。` }, signal, onUsage)
  } catch (err) {
    // 同首次：取消直接抛，不吞成失败
    if (isAbort(err, signal)) throw err
    // 两次都失败：原因带上错误码交给调用方
    return modelError(err)
  }
  const retried = parseSemanticFindings(retryRaw, knownIds)
  return retried !== null ? withNames(retried) : { kind: 'unparseable' }
}
