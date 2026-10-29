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
  // 行首：缩进与引用标记（> 、>> ）
  const lead = String.raw`[ \t>]*`
  // 正文行：整行是 base64、或是头字段、或是后面紧跟 base64 行的空行；行尾可以带空白。
  // 头字段的值止于非空白字符，行尾空白只归后面的 [ \t]*：两段若能吃同一批字符，缺 END 时回溯随行数指数增长。
  const bodyLine = String.raw`\r?\n${lead}(?:[A-Za-z0-9+/=]+|[A-Za-z][A-Za-z0-9-]*: (?:[^\r\n]*\S)?|(?=\r?\n${lead}[A-Za-z0-9+/=]))[ \t]*(?=\r?\n|$)`
  return new RegExp(String.raw`${begin}(?:[ \t]*(?:${bodyLine})*\r?\n${lead}${end}|[^\r\n]*(?:${bodyLine})*)`)
}

export const SECRET_PATTERNS: Array<{ name: string; re: RegExp; severity: SecretSeverity }> = [
  { name: 'sk- 系列密钥（OpenAI/Anthropic 等）', re: /\bsk-[A-Za-z0-9_-]{16,}\b/, severity: 'critical' },
  { name: 'GitHub token（ghp_/gho_ 等）', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, severity: 'critical' },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'critical' },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, severity: 'critical' },
  { name: 'PEM 私钥块', re: keyBlock('-----BEGIN ([A-Z ]*)PRIVATE KEY-----', String.raw`-----END \1PRIVATE KEY-----`), severity: 'critical' },
  { name: 'PGP 私钥块', re: keyBlock('-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----END PGP PRIVATE KEY BLOCK-----'), severity: 'critical' },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/, severity: 'critical' },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'critical' },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/, severity: 'critical' },
  // 以下两条无厂商特征、正则较宽，归 suspected（拦下待确认，force 放行，避免误伤）。
  // \S{6,} 对中文文本会把任意 6 个非空白字符当密码——中文记忆没有空格，普通句子如
  // "密码:公司统一走单点登录" 也会命中。约束取值必须像凭证（同时含数字与字母）且不含中日韩字符，
  // 排除自然语言描述、保留真正贴出来的口令。
  { name: '硬编码密码', re: /(?:password|passwd|pwd|密码)\s*[:=＝：]\s*(?=\S*[0-9])(?=\S*[A-Za-z])[^\s㐀-鿿]{6,}/i, severity: 'suspected' },
  // 引号改为可选：记忆内容是散文而非代码，"api_key: 1234567890abcdef" 这种写法不该被漏检。
  { name: '通用 api_key/token/secret 赋值', re: /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}['"]?/i, severity: 'suspected' },
]

export function detectSecrets(text: string): Array<{ name: string; severity: SecretSeverity }> {
  return SECRET_PATTERNS.filter(p => p.re.test(text)).map(p => ({ name: p.name, severity: p.severity }))
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

/** 命中密钥的字段。只在跨字段拼接时才命中（单个字段都不命中）的，四个面全算命中。 */
export function secretFields(r: SecretSurface): SecretField[] {
  const hit = SECRET_FIELDS.filter(f => detectSecrets(fieldText(r, f)).length > 0)
  return hit.length === 0 && hasSecret(r) ? [...SECRET_FIELDS] : hit
}

/** 注入时遮盖命中片段用的占位文本。 */
export const SECRET_MASK = '[已隐藏]'

/**
 * 遮盖口径。缺省（critical）只遮 critical：注入与视图用，suspected 写入时已由用户确认放行，遮了反而违背确认。
 * suspected = critical 与 suspected 都遮：对话卡用，那里展示的是 agent 发的原文，密钥一律不出现（spec 42）。
 */
export interface MaskOptions { severity?: SecretSeverity }

// matchAll 要全局正则；SECRET_PATTERNS 本身不带 g，detectSecrets 的 test() 才不受 lastIndex 影响。
const globalPatterns = (severities: readonly SecretSeverity[]) => SECRET_PATTERNS
  .filter(p => severities.includes(p.severity))
  .map(p => new RegExp(p.re.source, `${p.re.flags}g`))
const GLOBAL_PATTERNS: Record<SecretSeverity, RegExp[]> = {
  critical: globalPatterns(['critical']),
  suspected: globalPatterns(['critical', 'suspected']),
}

type Span = [start: number, end: number]

/** text 里各规则全局匹配的命中区间，未合并。 */
function rawSpans(text: string, opts: MaskOptions): Span[] {
  return GLOBAL_PATTERNS[opts.severity ?? 'critical'].flatMap(re => [...text.matchAll(re)].map((m): Span => [m.index, m.index + m[0].length]))
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

/** 报错、诊断文字（解析失败的原话可能引出文件里的整行）：两级密钥都遮。进视图、工具结果、日志之前过它。 */
export function maskDiagnostic(text: string): string {
  return maskSecrets(text, { severity: 'suspected' })
}

/**
 * 四个面按片段遮盖。先按单个字段找命中、各遮各的；再在与 hasSecret 同口径的拼接文本上找起点不在任何字段自身命中里的
 * 区间（跨字段拼接才命中的），各字段落在区间里的部分各换一个占位。字段内起头、一路延伸到文本末尾的命中
 * （截断的私钥）因此只遮到本字段末尾。没有命中原样返回同一个对象。
 */
export function maskSecretSurface<T extends SecretSurface>(r: T, opts: MaskOptions = {}): T {
  const segments = [r.content, r.name, r.summary, ...r.tags]
  const starts: number[] = []
  let text = ''
  segments.forEach((segment, i) => {
    if (i > 0) text += i <= 3 ? '\n' : ' '  // 字段间换行、标签间空格，同 fieldText 的拼法
    starts.push(text.length)
    text += segment
  })
  const own = segments.flatMap((segment, i) => secretSpans(segment, opts).map(([a, b]): Span => [starts[i] + a, starts[i] + b]))
  const cross = rawSpans(text, opts).filter(([a]) => !own.some(([start, end]) => a >= start && a < end))
  const spans = mergeSpans([...own, ...cross])
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
