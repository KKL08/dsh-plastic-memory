import { createHash } from 'node:crypto'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { FrontmatterError } from '../errors.ts'
import { memoryRecordSchema, CONFIDENCE_BY_SOURCE, type MemoryRecord } from '../record-schema.ts'
import type { CodedNote, DirectoryNoteCode } from '../contract-codes.ts'
import type { QuarantineEntry } from './table.ts'
import { deriveFileId } from './paths.ts'

/** 保留键：位置由目录表达、正文即 content、召回统计住 .state/（契约表见 docs/design-storage-file-is-memory.md §2）。 */
const RESERVED_KEYS = new Set(['scope', 'workspacePath', 'recallCount', 'lastRecalledAt', 'content'])
/** 时间戳字段：文件面 ISO 8601（写出 UTC 毫秒），内存面 epoch ms。 */
const TIME_KEYS = new Set(['createdAt', 'updatedAt', 'lastConfirmedAt', 'deletedAt', 'validFrom', 'validTo'])
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
 * 时间戳可接受的 ISO 形态：纯日期（按 UTC 零点）；日期时间（T 或空格分隔，秒、毫秒可省），带 Z 或偏移按其时区，
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
    throw new FrontmatterError('yaml-parse', `frontmatter 不是合法 YAML：${e instanceof Error ? e.message : String(e)}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new FrontmatterError('not-object', 'frontmatter 不是对象')
  const body = raw.slice(close.index + close[0].length)
    .replace(/^\r?\n/, '')      // encode 时围栏后有一个空行
    .replace(/\r?\n$/, '')
  return { data: data as Record<string, unknown>, body }
}

/** 内容摘要：name、summary、正文以 LF 拼接（CRLF 归一）后 sha1 前 16 位，带算法前缀。只用于手编检测。 */
export function computeDigest(name: string, summary: string, content: string): string {
  const text = `${name}\n${summary}\n${content}`.replace(/\r\n/g, '\n')
  return `${DIGEST_PREFIX}${createHash('sha1').update(text).digest('hex').slice(0, 16)}`
}

function parseTimestamp(key: string, value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value                       // 数字毫秒（epoch ms）
    throw new FrontmatterError('timestamp-parse', `时间戳无法解析：${key}=${value}`)
  }
  const text = String(value)
  const m = DATE_RE.exec(text) ?? DATETIME_RE.exec(text)
  if (!m) throw new FrontmatterError('timestamp-format', `时间戳格式不认识（接受 YYYY-MM-DD、ISO 8601 日期时间、数字毫秒）：${key}=${text}`)
  // Date.parse 会把 2026-02-30 静默滚成 3 月 2 日：先核对日历日期存在
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
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
    if (src[k] !== undefined) src[k] = parseTimestamp(k, src[k])
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
  if (typeof fileDigest === 'string' && fileDigest.startsWith(DIGEST_PREFIX)
    && fileDigest !== computeDigest(record.name, record.summary, record.content)) {
    record.handEdited = true
  }
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

export function encodeRecord(record: MemoryRecord, extras: Record<string, unknown>): string {
  const fm: Record<string, unknown> = {}
  for (const k of FILE_KEY_ORDER) {
    if (k === 'digest') { fm.digest = computeDigest(record.name, record.summary, record.content); continue }
    const v = (record as unknown as Record<string, unknown>)[k]
    if (v === undefined) continue                     // 可选键缺省 = 键不存在
    fm[k] = TIME_KEYS.has(k) ? new Date(v as number).toISOString() : v
  }
  for (const [k, v] of Object.entries(extras)) {
    if (!KNOWN_FILE_KEYS.has(k) && !RESERVED_KEYS.has(k)) fm[k] = v  // schema 键胜出
  }
  return `${FENCE}${stringifyYaml(fm)}---\n\n${record.content}\n`
}
