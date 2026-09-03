import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { FrontmatterError } from '../errors.ts'
import { memoryRecordSchema, type MemoryRecord } from '../record-schema.ts'

/** 文件面不存在的字段：位置由目录表达，易变统计住 KV sidecar（契约总表见 docs/p15-storage-search-redesign.md §3）。 */
const NON_FILE_KEYS = new Set(['scope', 'workspacePath', 'recallCount', 'lastRecalledAt', 'content'])
/** 时间戳字段：文件面 ISO 8601（UTC、毫秒），内存面 epoch ms。 */
const TIME_KEYS = new Set(['createdAt', 'updatedAt', 'lastConfirmedAt', 'validFrom', 'validTo'])
/** ISO 8601 UTC 毫秒格式：toISOString() 的输出形态（快照冲突判定按毫秒比较）。 */
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** frontmatter 输出的稳定字段序（diff 友好）。 */
const FILE_KEY_ORDER = [
  'id', 'name', 'type', 'tags', 'status', 'confidence', 'source',
  'createdAt', 'updatedAt', 'lastConfirmedAt', 'validFrom', 'validTo',
  'supersedes', 'summary', 'globalCandidate',
] as const
const KNOWN_FILE_KEYS = new Set<string>(FILE_KEY_ORDER)

export interface ParsedMemoryFile { data: Record<string, unknown>; body: string }
export type FileLocation = { scope: 'global' } | { scope: 'workspace'; workspacePath: string }

const FENCE = '---\n'
const CLOSE = '\n---\n'

export function splitFrontmatter(raw: string): ParsedMemoryFile {
  if (!raw.startsWith(FENCE)) throw new FrontmatterError('missing-fence', '缺少 frontmatter 围栏')
  const close = raw.indexOf(CLOSE, FENCE.length - 1)
  if (close < 0) throw new FrontmatterError('unclosed-fence', 'frontmatter 围栏未闭合')
  const data = parseYaml(raw.slice(FENCE.length, close + 1)) // 坏 YAML 由 yaml 包抛出
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new FrontmatterError('not-object', 'frontmatter 不是对象')
  let body = raw.slice(close + CLOSE.length)
  if (body.startsWith('\n')) body = body.slice(1)      // encode 时围栏后有一个空行
  return { data: data as Record<string, unknown>, body: body.replace(/\n$/, '') }
}

export function decodeRecord(
  parsed: ParsedMemoryFile,
  loc: FileLocation,
): { record: MemoryRecord; extras: Record<string, unknown> } {
  const src: Record<string, unknown> = {}
  const extras: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed.data)) {
    if (KNOWN_FILE_KEYS.has(k)) src[k] = v
    else if (!NON_FILE_KEYS.has(k)) extras[k] = v
    // 这些字段的权威来源是目录/正文/sidecar，frontmatter 里手写的同名键是污染，静默丢弃（记录本身不受影响）
  }
  for (const k of TIME_KEYS) {
    if (src[k] !== undefined) {
      const val = String(src[k])
      // 宽松的 Date.parse 会把手改的 '2026-08-19' 静默折算成 UTC 零点——亚日精度悄悄丢失，
      // 而快照冲突判定按毫秒比较。格式不对必须响亮失败（进 malformed 隔离），不能安静接受。
      if (!ISO_MS_RE.test(val)) throw new FrontmatterError('timestamp-format', `时间戳必须是 UTC 毫秒 ISO 格式（toISOString）：${k}=${val}`)
      const ms = Date.parse(val)
      if (!Number.isFinite(ms)) throw new FrontmatterError('timestamp-parse', `时间戳无法解析：${k}=${val}`)
      src[k] = ms
    }
  }
  const assembled = {
    ...src,
    content: parsed.body,
    scope: loc.scope,
    ...(loc.scope === 'workspace' ? { workspacePath: loc.workspacePath } : {}),
    recallCount: 0,        // sidecar 无行时的默认（有行时由 FileTable 加载后合并覆盖）
    lastRecalledAt: null,
  }
  const r = memoryRecordSchema.safeParse(assembled) // eventRange 二元组由 z.tuple 强制
  if (!r.success) throw new FrontmatterError('schema-invalid', `schema 校验失败：${r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；')}`)
  return { record: r.data, extras }
}

export function encodeRecord(record: MemoryRecord, extras: Record<string, unknown>): string {
  const fm: Record<string, unknown> = {}
  for (const k of FILE_KEY_ORDER) {
    const v = (record as unknown as Record<string, unknown>)[k]
    if (v === undefined) continue                     // 可选键缺省 = 键不存在
    fm[k] = TIME_KEYS.has(k) ? new Date(v as number).toISOString() : v
  }
  for (const [k, v] of Object.entries(extras)) {
    if (!KNOWN_FILE_KEYS.has(k) && !NON_FILE_KEYS.has(k)) fm[k] = v  // schema 键胜出
  }
  return `${FENCE}${stringifyYaml(fm)}---\n\n${record.content}\n`
}
