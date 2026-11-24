/**
 * 密钥模式集。severity 分两级：
 * - critical：有明确厂商前缀/格式，几乎不误报 → 写入时直接拦截（pipeline reject，不落盘）。
 * - suspected：无厂商特征、正则较宽、可能误报 → 写入时拦下待确认，带 force 放行并保留警告。
 * 库里的 suspected 是用户确认过不是密钥才放行的，注入遮盖与体检判红只看 critical；
 * forget 时两级一视同仁：命中任一级即物理删除（tools/forget.ts）。
 */
export type SecretSeverity = 'critical' | 'suspected'

/**
 * 私钥块（PEM、PGP）的正则：命中整块（BEGIN 到同名 END），遮盖才盖得住正文。BEGIN 与 END 之间只允许正文行：base64 行、
 * 「键: 值」头字段行，以及后面还有 base64 行的空行（整块缩进、整块在 Markdown 引用里、行尾带空白都算）。没有这样的 END
 * （截断的粘贴、散文里提到 BEGIN 头）只到 BEGIN 那一行行尾，再带上紧跟着的正文行；散文里的 BEGIN 头因此只遮这一行，
 * 不会一路吞到后文真正私钥的 END。
 */
function keyBlock(begin: string, end: string): RegExp {
  // 行首：缩进与引用标记（> 、>> ）。缩进和行尾空白一样认换行以外的任何空白（含复制来的 NBSP、全角空格）：
  // 只认空格和 tab 时这一行对不上，整块退回只遮 BEGIN 行
  const lead = String.raw`(?:[^\S\r\n]|>)*`
  const trail = String.raw`[^\S\r\n]*`
  // 正文行：整行是 base64、或是头字段、或是后面紧跟 base64 行的空行；行尾可以带空白。
  // 头字段的值止于非空白字符，行尾空白只归后面的 trail：两段若能吃同一批字符，缺 END 时回溯随行数指数增长。
  const bodyLine = String.raw`\r?\n${lead}(?:[A-Za-z0-9+/=]+|[A-Za-z][A-Za-z0-9-]*: (?:[^\r\n]*\S)?|(?=\r?\n${lead}[A-Za-z0-9+/=]))${trail}(?=\r?\n|$)`
  return new RegExp(String.raw`${begin}(?:${trail}(?:${bodyLine})*\r?\n${lead}${end}|[^\r\n]*(?:${bodyLine})*)`)
}

/** 一处命中：起点、整段命中的文字、凭据值（带 value 分组的规则只取值本身，其余规则是整段）。 */
interface SecretMatch { index: number; match: string; value: string }

// 「硬编码密码」的标签和分隔符，取值由 hardcodedPasswords 接着往后认。
// PASSWORD_VALUE、NON_SPACE 和下面的 JWT 是模块级粘连正则，各处调用共用 lastIndex：设 lastIndex 到 exec/test 之间不能有 yield
const PASSWORD_LABEL = /(?:password|passwd|pwd|密码)\s*[:=＝：]\s*/gi
const PASSWORD_VALUE = /[^\s㐀-鿿]{6,}/iy
const NON_SPACE = /\S*/y

/**
 * 「硬编码密码」逐处命中，与正则 (?:password|passwd|pwd|密码)\s*[:=＝：]\s*(?<value>(?=\S*[0-9])(?=\S*[A-Za-z])[^\s㐀-鿿]{6,})
 * （不分大小写）逐处相同：取值从分隔符后第一个非空白字符起，到空白或中日韩字符前为止，至少 6 个字符；取值起点所在的那段连续非空白字符里，
 * 从起点往后要同时有数字和字母。这段字符的段尾和其中最后一个数字、字母的位置记下来，同一段里后面的标签直接复用，标签再多每段也只读一遍。
 */
function* hardcodedPasswords(text: string): Generator<SecretMatch> {
  const label = new RegExp(PASSWORD_LABEL)
  let run = { end: -1, lastDigit: -1, lastLetter: -1 }
  for (let m = label.exec(text); m !== null; m = label.exec(text)) {
    const from = m.index + m[0].length
    if (from >= run.end) run = scanRun(text, from)
    PASSWORD_VALUE.lastIndex = from
    const value = run.lastDigit >= from && run.lastLetter >= from ? PASSWORD_VALUE.exec(text)?.[0] : undefined
    if (value === undefined) {
      label.lastIndex = m.index + 1
      continue
    }
    yield { index: m.index, match: text.slice(m.index, from + value.length), value }
    label.lastIndex = from + value.length
  }
}

/** 从 from 起的那段连续非空白字符：段尾，段里最后一个数字、最后一个字母的位置（没有记 -1）。 */
function scanRun(text: string, from: number): { end: number; lastDigit: number; lastLetter: number } {
  NON_SPACE.lastIndex = from
  NON_SPACE.test(text)
  const end = NON_SPACE.lastIndex
  let lastDigit = -1
  let lastLetter = -1
  for (let i = from; i < end; i++) {
    const c = text.charCodeAt(i)
    if (c >= 48 && c <= 57) lastDigit = i
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) lastLetter = i
  }
  return { end, lastDigit, lastLetter }
}

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/y
const JWT_START = /\beyJ/g

/**
 * JWT 逐处命中，与正则 JWT 不带 y 时的全局匹配逐处相同。第一段总是取到起点所在那段 [A-Za-z0-9_-] 连续字符的末尾，之后要接的内容
 * 只看段尾，所以一处起点不命中时，同一段里后面的起点（第一段更短）也不会命中，直接从段尾接着找：每段字符最多被三个起点各读一遍
 * （自己那段的第一个起点，以及前一段、前两段的第一个起点读到这里的第二、三段）。
 */
function* jwts(text: string): Generator<SecretMatch> {
  const start = new RegExp(JWT_START)
  for (let m = start.exec(text); m !== null; m = start.exec(text)) {
    JWT.lastIndex = m.index
    const hit = JWT.exec(text)?.[0]
    if (hit === undefined) {
      start.lastIndex = tokenRunEnd(text, m.index)
      continue
    }
    yield { index: m.index, match: hit, value: hit }
    start.lastIndex = m.index + hit.length
  }
}

/** text 从 from 起连续的 [A-Za-z0-9_-] 字符到哪里为止。 */
function tokenRunEnd(text: string, from: number): number {
  let i = from
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45)) break
  }
  return i
}

type SecretPattern = { name: string; severity: SecretSeverity } & ({ re: RegExp } | { matches: (text: string) => Generator<SecretMatch> })

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'sk- 系列密钥（OpenAI/Anthropic 等）', re: /\bsk-[A-Za-z0-9_-]{16,}\b/, severity: 'critical' },
  { name: 'GitHub token（ghp_/gho_ 等）', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, severity: 'critical' },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'critical' },
  { name: 'JWT', matches: jwts, severity: 'critical' },
  { name: 'PEM 私钥块', re: keyBlock('-----BEGIN ([A-Z ]*)PRIVATE KEY-----', String.raw`-----END \1PRIVATE KEY-----`), severity: 'critical' },
  { name: 'PGP 私钥块', re: keyBlock('-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----END PGP PRIVATE KEY BLOCK-----'), severity: 'critical' },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/, severity: 'critical' },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'critical' },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/, severity: 'critical' },
  // 以下两条无厂商特征、正则较宽，归 suspected（拦下待确认，force 放行，避免误伤）。
  // \S{6,} 对中文文本会把任意 6 个非空白字符当密码——中文记忆没有空格，普通句子如
  // "密码:公司统一走单点登录" 也会命中。约束取值必须像凭证（同时含数字与字母）且不含中日韩字符，
  // 排除自然语言描述、保留真正贴出来的口令。
  // 两条都只取凭据值本身（不含标签、分隔符、引号）：核对改写稿里的值是不是原文里本来就有的（secretValues）。
  // 「硬编码密码」逐处判定，见 hardcodedPasswords。
  { name: '硬编码密码', matches: hardcodedPasswords, severity: 'suspected' },
  // 引号改为可选：记忆内容是散文而非代码，"api_key: 1234567890abcdef" 这种写法不该被漏检。
  { name: '通用 api_key/token/secret 赋值', re: /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*['"]?(?<value>[A-Za-z0-9_-]{16,})['"]?/i, severity: 'suspected' },
]

export function detectSecrets(text: string): Array<{ name: string; severity: SecretSeverity }> {
  return SECRET_PATTERNS.filter(p => ('re' in p ? p.re.test(text) : p.matches(text).next().done === false)).map(p => ({ name: p.name, severity: p.severity }))
}

/** 记录里会外泄的四个面：正文、name（进文件名）、summary（进注入索引）、tags（进索引行）。 */
export const SECRET_FIELDS = ['content', 'name', 'summary', 'tags'] as const
export type SecretField = (typeof SECRET_FIELDS)[number]
type SecretSurface = { content: string; name: string; summary: string; tags: string[] }

const fieldText = (r: SecretSurface, field: SecretField) => (field === 'tags' ? r.tags.join(' ') : r[field])

/** 四个面拼起来检测（与写入管线、规则层同口径）。 */
export function hasSecret(r: SecretSurface): boolean {
  return detectSecrets(SECRET_FIELDS.map(f => fieldText(r, f)).join('\n')).length > 0
}

/** 四个面里有没有高危（critical）密钥：注入、视图只遮这一级，疑似的写入时已由用户确认放行、照原文出现。 */
export function hasCriticalSecret(r: SecretSurface): boolean {
  return detectSecrets(SECRET_FIELDS.map(f => fieldText(r, f)).join('\n')).some(h => h.severity === 'critical')
}

/**
 * 命中密钥的字段（两级都算，同 hasSecret）：自身命中的，加上被跨字段命中区间覆盖到的。区间与 maskSecretSurface 同一套算法。
 * 区间落不进任何字段、却仍判为含密钥时（兜底），四个面全算命中。
 */
export function secretFields(r: SecretSurface): SecretField[] {
  const { segments, starts, spans } = surfaceSpans(r, { severity: 'suspected' })
  const hit = new Set<SecretField>()
  segments.forEach((segment, i) => {
    const from = starts[i]
    const to = from + segment.length
    if (spans.some(([a, b]) => a < to && b > from)) hit.add(SECRET_FIELDS[Math.min(i, 3)])   // 第 4 段起都是标签
  })
  return hit.size === 0 && hasSecret(r) ? [...SECRET_FIELDS] : SECRET_FIELDS.filter(f => hit.has(f))
}

/** 注入时遮盖命中片段用的占位文本。 */
export const SECRET_MASK = '[已隐藏]'

/**
 * 遮盖口径。缺省（critical）只遮 critical：注入与视图用，suspected 写入时已由用户确认放行，遮了反而违背确认。
 * suspected = critical 与 suspected 都遮：对话卡用，那里展示的是 agent 发的原文，密钥一律不出现（spec 42）。
 */
export interface MaskOptions { severity?: SecretSeverity }

/** text 里一条规则的全部命中。 */
type SecretFinder = (text: string) => Iterable<SecretMatch>

// matchAll 要全局正则；SECRET_PATTERNS 本身不带 g，detectSecrets 的 test() 才不受 lastIndex 影响。
const finder = (p: SecretPattern): SecretFinder => {
  if (!('re' in p)) return p.matches
  const re = new RegExp(p.re.source, `${p.re.flags}g`)
  return text => [...text.matchAll(re)].map(m => ({ index: m.index, match: m[0], value: m.groups?.value ?? m[0] }))
}
const globalPatterns = (severities: readonly SecretSeverity[]) => SECRET_PATTERNS
  .filter(p => severities.includes(p.severity))
  .map(finder)
const GLOBAL_PATTERNS: Record<SecretSeverity, SecretFinder[]> = {
  critical: globalPatterns(['critical']),
  suspected: globalPatterns(['critical', 'suspected']),
}

type Span = [start: number, end: number]

/** text 里各规则全局匹配的命中区间，未合并。 */
function rawSpans(text: string, opts: MaskOptions): Span[] {
  return GLOBAL_PATTERNS[opts.severity ?? 'critical'].flatMap(find => [...find(text)].map((m): Span => [m.index, m.index + m.match.length]))
}

/** text 里所有命中片段的区间：重叠或相接的合并。 */
function secretSpans(text: string, opts: MaskOptions): Span[] {
  return mergeSpans(rawSpans(text, opts))
}

function mergeSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a[0] - b[0])
  const merged: Span[] = []
  for (const [start, end] of spans) {
    const last = merged.at(-1)
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** 取 text 的 [from, to) 段，其中落在命中区间里的部分换成占位文本。 */
function maskRange(text: string, spans: readonly Span[], from: number, to: number): string {
  let out = ''
  let pos = from
  for (const [start, end] of spans) {
    const a = Math.max(start, from)
    const b = Math.min(end, to)
    if (a >= b) continue
    out += text.slice(pos, a) + SECRET_MASK
    pos = b
  }
  return out + text.slice(pos, to)
}

/** 按片段遮盖：命中规则的片段（口径见 MaskOptions，缺省只看 critical）换成占位文本，其余文字原样。 */
export function maskSecrets(text: string, opts: MaskOptions = {}): string {
  return maskRange(text, secretSpans(text, opts), 0, text.length)
}

/**
 * text 里每处命中的完整凭据值（口径见 MaskOptions）：带 value 分组的规则取值本身，不含标签、分隔符和引号；其余规则整段命中就是值。
 * 核对一段新写的文字里的密钥是不是原文里本来就有的：值逐个精确比较，截短、加长都对不上，只改标签写法、分隔符仍对得上。
 */
export function secretValues(text: string, opts: MaskOptions = {}): string[] {
  return GLOBAL_PATTERNS[opts.severity ?? 'critical'].flatMap(find => [...find(text)].map(m => m.value))
}

/** 报错、诊断文字（解析失败的原话可能引出文件里的整行）：两级密钥都遮。进视图、工具结果、日志之前过它。 */
export function maskDiagnostic(text: string): string {
  return maskSecrets(text, { severity: 'suspected' })
}

/**
 * 四个面的命中区间，坐标在与 hasSecret 同口径的拼接文本上。先按单个字段找命中；再在拼接文本上找没有整段落在某个字段自身命中里的
 * 区间（跨字段拼接才命中、或从字段自身命中延伸进下一个字段的，如 BEGIN 行在 name、正文在 summary 的私钥）。
 * 截断的私钥后面的字段恰好像正文行时会被一并遮住，宁多遮不漏。
 * segments 依次是正文、name、summary 和每个标签，starts 是各段在拼接文本里的起点。
 */
function surfaceSpans(r: SecretSurface, opts: MaskOptions): { text: string; segments: string[]; starts: number[]; spans: Span[] } {
  const segments = [r.content, r.name, r.summary, ...r.tags]
  const starts: number[] = []
  let text = ''
  segments.forEach((segment, i) => {
    if (i > 0) text += i <= 3 ? '\n' : ' '  // 字段间换行、标签间空格，同 fieldText 的拼法
    starts.push(text.length)
    text += segment
  })
  const own = segments.flatMap((segment, i) => secretSpans(segment, opts).map(([a, b]): Span => [starts[i] + a, starts[i] + b]))
  const cross = rawSpans(text, opts).filter(([a, b]) => !own.some(([start, end]) => a >= start && b <= end))
  return { text, segments, starts, spans: mergeSpans([...own, ...cross]) }
}

/** 四个面按片段遮盖：各字段落在命中区间（见 surfaceSpans）里的部分各换一个占位。没有命中原样返回同一个对象。 */
export function maskSecretSurface<T extends SecretSurface>(r: T, opts: MaskOptions = {}): T {
  const { text, segments, starts, spans } = surfaceSpans(r, opts)
  if (spans.length === 0) return r
  const [content, name, summary, ...tags] = segments.map((segment, i) => maskRange(text, spans, starts[i], starts[i] + segment.length))
  return { ...r, content, name, summary, tags }
}

/**
 * 记忆文件路径对外的口径（注入、检索、体检说明同口径）：文件名由 name 派生，slug 只换分隔符还会截断，name 被遮了
 * 路径里多半还留着同一段密钥（截断后的残段规则也认不出），不给路径（undefined）；手起名的文件名可能自带密钥，其余路径遮一遍。
 */
export function exposedPath(r: SecretSurface, path: string): string | undefined {
  return maskSecretSurface(r).name === r.name ? maskSecrets(path) : undefined
}
