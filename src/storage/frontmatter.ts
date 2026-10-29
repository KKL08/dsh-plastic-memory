import { createHash } from 'node:crypto'
import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml'
import { FrontmatterError } from '../errors.ts'
import { memoryRecordSchema, CONFIDENCE_BY_SOURCE, type MemoryRecord } from '../record-schema.ts'
import type { CodedNote, DirectoryNoteCode } from '../contract-codes.ts'
import type { QuarantineEntry } from './table.ts'
import { deriveFileId } from './paths.ts'
import { formatValidity, localDateAt, roundValidity } from '../validity.ts'

/** 保留键：位置由目录表达、正文即 content、召回统计住 .state/（契约表见 docs/design-storage-file-is-memory.md §2）。 */
const RESERVED_KEYS = new Set(['scope', 'workspacePath', 'recallCount', 'lastRecalledAt', 'content'])
/** 时间戳字段：文件面 ISO 8601（写出 UTC 毫秒；有效期键例外，见 VALIDITY_KEYS），内存面 epoch ms。 */
const TIME_KEYS = new Set(['createdAt', 'updatedAt', 'lastConfirmedAt', 'deletedAt', 'validFrom', 'validTo'])
/**
 * 有效期键：写出本机时间 YYYY-MM-DD HH:mm，用户打开文件能直接看懂、照着改（其余时间键的毫秒要给事件排先后，仍写 UTC 毫秒 ISO）。
 * 读取认所有时间键的写法，旧版本的毫秒按分钟向外取整（roundValidity），维护点的重新 encode 回写即把旧文件转成新写法。
 * 纯日期取文件 mtime 的本机时分（与 memory_save 只写日期时补写入时刻同一语义）；读目录总带 mtime，不带时（直接解码）按 UTC 零点。
 */
const VALIDITY_KEYS = new Set(['validFrom', 'validTo'])
const isValidityKey = (k: string): k is 'validFrom' | 'validTo' => VALIDITY_KEYS.has(k)
/** 手建文件缺这三个时间戳时取文件 mtime。 */
const MTIME_DEFAULT_KEYS = ['createdAt', 'updatedAt', 'lastConfirmedAt'] as const
/** 无 source（手编/无出处）时的缺省置信度：按用户亲写的档位。 */
const HAND_WRITTEN_CONFIDENCE = 0.9
/** frontmatter 输出的稳定字段序（diff 友好）；digest 不是记录字段，写出时重算。 */
const FILE_KEY_ORDER = [
  'id', 'name', 'type', 'tags', 'status', 'confidence', 'source',
  'createdAt', 'updatedAt', 'lastConfirmedAt', 'deletedAt', 'validFrom', 'validTo',
  'supersedes', 'summary', 'globalCandidate', 'handEdited', 'digest',
] as const
const KNOWN_FILE_KEYS = new Set<string>(FILE_KEY_ORDER)

/**
 * 时间戳可接受的 ISO 形态：纯日期（按 UTC 零点；有效期键见 VALIDITY_KEYS）；日期时间（T 或空格分隔，秒、毫秒可省），带 Z 或偏移按其时区，
 * 不带时区按本地时间——手写文件最常见的写法，小时级歧义不影响陈旧度判断。
 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/

/** digest 算法版本前缀：换算法必须换前缀，旧前缀按缺省（未知）处理（ARCHITECTURE.md ⑥-6a）。 */
const DIGEST_PREFIX = 'd1:'

export interface ParsedMemoryFile { data: Record<string, unknown>; body: string }
export type FileLocation = { scope: 'global' } | { scope: 'workspace'; workspacePath: string }

export interface DecodeOptions {
  /** 相对 memoryRoot 的路径：文件缺 id 时据此派生（deriveFileId）。 */
  relPath?: string
  /** 文件 mtime：缺 createdAt / updatedAt / lastConfirmedAt 时取它。 */
  mtimeMs?: number
}
/** 目录级说明（info 级）：调用方按文件归集（file-table 补上 path 成 DirectoryNote）。 */
export interface DecodeNote extends CodedNote<DirectoryNoteCode> { level: 'info'; keys: string[] }
export interface DecodedRecord { record: MemoryRecord; extras: Record<string, unknown>; notes: DecodeNote[] }
export type { QuarantineEntry }
export type DecodeOutcome = ({ ok: true } & DecodedRecord) | ({ ok: false } & QuarantineEntry)

const FENCE = '---\n'
/** 开围栏：第一行只有 ---，接受 CRLF（手建文件）。 */
const OPEN_FENCE_RE = /^---\r?\n/
/** 闭围栏：独占一行的 ---，接受 CRLF；从开围栏的换行处起找，空 frontmatter（---\n---\n）也能闭合。 */
const CLOSE_FENCE_RE = /\r?\n---\r?\n/g

/** confidence 在文件面可省：先按可选解析，校验过 source 之后再补缺省、按 sourceMode 收口。 */
const fileRecordSchema = memoryRecordSchema.extend({ confidence: memoryRecordSchema.shape.confidence.optional() })

export function splitFrontmatter(raw: string): ParsedMemoryFile {
  const open = OPEN_FENCE_RE.exec(raw)
  if (!open) throw new FrontmatterError('missing-fence', '缺少 frontmatter 围栏')
  CLOSE_FENCE_RE.lastIndex = open[0].length - 1   // 指向开围栏的 \n：空 frontmatter 的闭围栏紧接着它
  const close = CLOSE_FENCE_RE.exec(raw)
  if (!close) throw new FrontmatterError('unclosed-fence', 'frontmatter 围栏未闭合')
  let data: unknown
  try {
    // YAML 文本带上闭围栏前的换行（块标量的末尾换行语义不变）；正文保留原样的换行风格，digest 另行归一
    data = parseYaml(raw.slice(open[0].length, close.index + close[0].indexOf('---')))
  } catch (e) {
    throw new FrontmatterError('yaml-parse', `frontmatter 不是合法 YAML：${yamlErrorAt(e)}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new FrontmatterError('not-object', 'frontmatter 不是对象')
  const body = raw.slice(close.index + close[0].length)
    .replace(/^\r?\n/, '')      // encode 时围栏后有一个空行
    .replace(/\r?\n$/, '')
  return { data: data as Record<string, unknown>, body }
}

/** YAML 报错只留错误名与行列：yaml 的原话会引出出错那一行，长行还截掉开头，密钥前缀被截掉后遮盖规则认不出来。 */
function yamlErrorAt(e: unknown): string {
  if (!(e instanceof YAMLParseError)) return e instanceof Error ? e.name : 'unknown'
  const at = e.linePos?.[0]
  return at === undefined ? e.code : `${e.code}（frontmatter 第 ${at.line} 行第 ${at.col} 列）`
}

/** 内容摘要：name、summary、正文以 LF 拼接（CRLF 归一）后 sha1 前 16 位，带算法前缀。只用于手编检测。 */
export function computeDigest(name: string, summary: string, content: string): string {
  const text = `${name}\n${summary}\n${content}`.replace(/\r\n/g, '\n')
  return `${DIGEST_PREFIX}${createHash('sha1').update(text).digest('hex').slice(0, 16)}`
}

/**
 * 文件里的 digest「认识且不匹配」= 内容被手改过：读取时据此标 handEdited，维护点据此把 updatedAt / lastConfirmedAt
 * 取 mtime。缺省或前缀不认识视为未知（0.1.x 文件、手建文件），不算不匹配。
 */
export function digestMismatch(fileDigest: unknown, r: Pick<MemoryRecord, 'name' | 'summary' | 'content'>): boolean {
  return typeof fileDigest === 'string' && fileDigest.startsWith(DIGEST_PREFIX)
    && fileDigest !== computeDigest(r.name, r.summary, r.content)
}

function parseTimestamp(key: string, value: unknown, mtimeMs: number | undefined): number {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value                       // 数字毫秒（epoch ms）
    throw new FrontmatterError('timestamp-parse', `时间戳无法解析：${key}=${value}`)
  }
  const text = String(value)
  const date = DATE_RE.exec(text)
  const m = date ?? DATETIME_RE.exec(text)
  if (!m) throw new FrontmatterError('timestamp-format', `时间戳格式不认识（接受 YYYY-MM-DD、ISO 8601 日期时间、数字毫秒）：${key}=${text}`)
  // Date.parse 会把 2026-02-30 静默滚成 3 月 2 日：先核对日历日期存在
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (date && VALIDITY_KEYS.has(key) && mtimeMs !== undefined) {
    // 有效期的纯日期：时分取用户写下它的时刻（文件 mtime，本机时间）；同一文件反复读结果不变
    const at = new Date(mtimeMs)
    const ms = localDateAt(y, mo, d, at.getHours(), at.getMinutes())
    if (ms === undefined) throw new FrontmatterError('timestamp-parse', `时间戳无法解析：${key}=${text}`)
    return ms
  }
  const day = new Date(Date.UTC(y, mo - 1, d))
  const ms = Date.parse(text.replace(' ', 'T'))   // ES 规范：无偏移的日期时间按本地时间
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || !Number.isFinite(ms)) {
    throw new FrontmatterError('timestamp-parse', `时间戳无法解析：${key}=${text}`)
  }
  return ms
}

export function decodeRecord(parsed: ParsedMemoryFile, loc: FileLocation, opts: DecodeOptions = {}): DecodedRecord {
  const src: Record<string, unknown> = {}
  const extras: Record<string, unknown> = {}
  const reserved: string[] = []
  for (const [k, v] of Object.entries(parsed.data)) {
    if (KNOWN_FILE_KEYS.has(k)) src[k] = v
    else if (RESERVED_KEYS.has(k)) reserved.push(k)   // 权威来源是目录/正文/侧表：忽略，进目录级说明
    else extras[k] = v
  }
  for (const k of TIME_KEYS) {
    if (src[k] === undefined) continue
    const ms = parseTimestamp(k, src[k], opts.mtimeMs)
    src[k] = isValidityKey(k) ? roundValidity(k, ms) : ms
  }
  for (const k of MTIME_DEFAULT_KEYS) {
    if (src[k] === undefined && opts.mtimeMs !== undefined) src[k] = opts.mtimeMs
  }
  if (src.id === undefined && opts.relPath !== undefined) src.id = deriveFileId(opts.relPath)
  const fileDigest = src.digest
  delete src.digest
  const assembled = {
    tags: [], summary: '', status: 'active',
    ...src,
    content: parsed.body,
    scope: loc.scope,
    ...(loc.scope === 'workspace' ? { workspacePath: loc.workspacePath } : {}),
    recallCount: 0,        // 侧表无行时的默认（有行时由读取方合并覆盖）
    lastRecalledAt: null,
  }
  const r = fileRecordSchema.safeParse(assembled) // eventRange 二元组由 z.tuple 强制
  if (!r.success) throw new FrontmatterError('schema-invalid', `schema 校验失败：${r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；')}`)
  // confidence：无 source 缺省按用户亲写档位；有 source 与写入管线同一规则——只能下调，上限是 sourceMode 档位
  const cap = r.data.source ? CONFIDENCE_BY_SOURCE[r.data.source.sourceMode] : undefined
  const confidence = cap === undefined ? (r.data.confidence ?? HAND_WRITTEN_CONFIDENCE) : Math.min(r.data.confidence ?? cap, cap)
  const record: MemoryRecord = { ...r.data, confidence }
  // digest：缺省或前缀不认识 = 未知（0.1.x 文件、手建文件），不标；认识且不匹配 = 被手改过
  if (digestMismatch(fileDigest, record)) record.handEdited = true
  const notes: DecodeNote[] = reserved.length === 0 ? [] : [{
    level: 'info', code: 'reserved-keys', keys: reserved,
    text: `frontmatter 含保留键 ${reserved.join('、')}，已忽略（位置由目录决定，正文即 content，召回统计不在文件里）`,
  }]
  return { record, extras, notes }
}

/** 不抛的读取入口：围栏、YAML、schema、时间戳任一失败都收成隔离条目。 */
export function decodeFile(raw: string, ctx: { path: string; loc: FileLocation } & DecodeOptions): DecodeOutcome {
  try {
    return { ok: true, ...decodeRecord(splitFrontmatter(raw), ctx.loc, { relPath: ctx.relPath, mtimeMs: ctx.mtimeMs }) }
  } catch (e) {
    return { ok: false, path: ctx.path, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 有效期写出：本机写法读回来恰好是原值才写它；否则（年份不是四位、夏令时回拨时重复的那一小时、历史上偏移不是整分钟的时区）
 * 写 UTC ISO——读取认它、读回分毫不差，维护点不会来回改写。
 */
function encodeValidity(key: 'validFrom' | 'validTo', ms: number): string {
  const value = roundValidity(key, ms)
  const text = formatValidity(value)
  let back: number | undefined
  try { back = roundValidity(key, parseTimestamp(key, text, undefined)) } catch { back = undefined }
  return back === value ? text : new Date(value).toISOString()
}

export function encodeRecord(record: MemoryRecord, extras: Record<string, unknown>): string {
  const fm: Record<string, unknown> = {}
  for (const k of FILE_KEY_ORDER) {
    if (k === 'digest') { fm.digest = computeDigest(record.name, record.summary, record.content); continue }
    const v = (record as unknown as Record<string, unknown>)[k]
    if (v === undefined) continue                     // 可选键缺省 = 键不存在
    fm[k] = isValidityKey(k) ? encodeValidity(k, v as number)
      : TIME_KEYS.has(k) ? new Date(v as number).toISOString() : v
  }
  for (const [k, v] of Object.entries(extras)) {
    if (!KNOWN_FILE_KEYS.has(k) && !RESERVED_KEYS.has(k)) fm[k] = v  // schema 键胜出
  }
  return `${FENCE}${stringifyYaml(fm)}---\n\n${record.content}\n`
}
