import { charSimilarity } from './text.ts'
import { createHash } from 'node:crypto'
import { slugifyName } from './storage/paths.ts'

/**
 * 主题索引的纯函数：解析、整份核对、主题名解析、MEMORY.md 投影。只吃文本和记忆清单，不碰磁盘。
 *
 * 一个作用域一套文件：入口（一个二级标题是一个主题，标题下第一段是主题说明）加每个主题一页
 * （一级标题是主题名，「曾用名：」开头的一行列旧名，成员是带链接的列表项，链接的标题属性里写记忆 id）。
 * 代码只认这几处，其余文字原样保留：用户和模型都可以直接改这些文件。
 */

/** 「未整理」页的文件名：还没归主题的记忆都在这一页，主题不能取这个名字。 */
export const UNSORTED_PAGE = '_unsorted.md'
export const UNSORTED_TITLE = '未整理'
export const ENTRY_TITLE = '记忆索引'
/** 主题名上限（按字符数，不按字节）：要放进标题和文件名，也要让模型一眼看完。 */
export const TOPIC_NAME_MAX = 40
/** 一个作用域里主题数上限的默认值（全局和每个项目各算）。 */
export const INDEX_MAX_TOPICS_DEFAULT = 30

/** 一个作用域的索引文件：入口的全文，和各主题页的全文（键是主题页目录下的文件名）。 */
export interface IndexFiles { entry: string; pages: Record<string, string> }

/** 在索引里有一行的记忆：在用、已进主档的。fileName 是它在记忆目录顶层的文件名。 */
export interface IndexedMemory { id: string; name: string; summary: string; fileName: string }

export interface Topic {
  fileName: string
  name: string
  /** 入口里这个主题标题下的第一段；入口里没有它时为空。 */
  about: string
  aliases: string[]
  memberIds: string[]
}

/** 主题名判同：去首尾空白、不分大小写。 */
export const keyOf = (name: string) => name.trim().toLowerCase()
const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
// 文件名当一个路径段编码：# 和 ? 留着会被读成链接的片段和查询，括号留着会提前结束 Markdown 链接
export const encodePath = (name: string) => encodeURIComponent(name).replace(/\(/g, '%28').replace(/\)/g, '%29')
export const decodePath = (path: string) => { try { return decodeURIComponent(path) } catch { return path } }
export const unescape = (text: string) => text.replace(/\\(.)/g, '$1')
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// 记忆 id 没有固定写法（手建的文件可以自己起），标题属性里按带转义的引号串认
export const MEMBER_RE = /^(\s*[-*+] )\[(?:\\.|[^\]\\])*\]\(\s*\S+\s+"((?:\\.|[^"\\])+)"\s*\)/
export const HEADING_RE = /^(#{1,2}) +(.+?)\s*$/
/** 入口里链到主题页的标题：`## [主题名](topics/文件名)`。 */
export const LINKED_HEADING_RE = /^\[((?:\\.|[^\]\\])*)\]\((?:\.\/)?topics\/([^)\s]+)\)$/
export const ALIASES_RE = /^曾用名[：:](.*)$/
/** 页头：开头一段 `---` 围起来的「键: 值」行。代码只认 lastWriteOp（提交标记）和 createdAt（建页时刻）两个键，别的键原样留着。 */
export const HEADER_RE = /^---\r?\n((?:[A-Za-z][A-Za-z0-9]*: \S+\r?\n)+)---\r?\n/
const STAMP_KEY = 'lastWriteOp'
const CREATED_KEY = 'createdAt'
const headerValue = (text: string, key: string) => {
  const header = HEADER_RE.exec(text)?.[1]
  return header === undefined ? undefined : new RegExp(`^${key}: (\\S+)\\r?$`, 'm').exec(header)?.[1]
}
/** 写页头里的一个键（已有就替换），别的键和正文不动；页头的换行跟正文走。 */
function withHeaderValue(text: string, key: string, value: string): string {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  const lines = (HEADER_RE.exec(text)?.[1] ?? '').split(/\r?\n/).filter(l => l !== '' && !l.startsWith(`${key}: `))
  return `---${eol}${[`${key}: ${value}`, ...lines].join(eol)}${eol}---${eol}${text.replace(HEADER_RE, '')}`
}
const FENCE_RE = /^\s*(```|~~~)/

/**
 * 逐行过一遍，标出哪些行在围栏代码块里（围栏那两行也算）：代码块里的东西是示例，不当标题、曾用名、成员行认。
 * 行尾的回车留在 line 里，原样写回去。
 */
export function scan(text: string): Array<{ line: string; isCode: boolean }> {
  let fence: string | undefined
  return text.split('\n').map(line => {
    const mark = FENCE_RE.exec(line)?.[1]
    if (fence !== undefined) {
      if (mark === fence) fence = undefined
      return { line, isCode: true }
    }
    if (mark !== undefined) fence = mark
    return { line, isCode: mark !== undefined }
  })
}
const memberOf = (row: { line: string; isCode: boolean }) => (row.isCode ? null : MEMBER_RE.exec(row.line))

/** 记忆 id 对应的成员行键：转义标题属性里的引号和反斜杠，可直接用于 memberLines 的查找。 */
export const memberKey = (id: string): string => id.replace(/["\\]/g, c => `\\${c}`)

/** 一条成员行：名称链到记忆文件（相对主题页的位置），标题属性里是记忆 id，后面接摘要。 */
export function memberLine(m: IndexedMemory, bullet = '- '): string {
  const name = oneLine(m.name).replace(/[[\]\\]/g, c => `\\${c}`)
  return `${bullet}[${name}](../../${encodePath(m.fileName)} "${memberKey(m.id)}") — ${oneLine(m.summary)}`
}

/** 成员行换成的占位：只剩记忆 id（标题属性里的写法，带转义）。 */
const MEMBER_PLACEHOLDER = '\u0000member:'

/** 把页里的成员行换成只带 id 的占位：这份文字可以放进操作日志，里面没有记忆的名称和摘要。 */
export function withoutMemberText(text: string): string {
  return scan(text).map((row) => {
    const m = memberOf(row)
    return m === null ? row.line : `${MEMBER_PLACEHOLDER}${m[2]!}`
  }).join('\n')
}

/** 把占位换回成员行：lineOf 按 id（标题属性里的写法）给出那一行，给不出的（记忆已经不在索引里）整行去掉。行尾的回车跟占位那一行走。 */
export function withMemberText(text: string, lineOf: (id: string) => string | undefined): string {
  return text.split('\n').flatMap((line) => {
    if (!line.startsWith(MEMBER_PLACEHOLDER)) return [line]
    const eol = line.endsWith('\r') ? '\r' : ''
    const found = lineOf(line.slice(MEMBER_PLACEHOLDER.length).replace(/\r$/, ''))
    return found === undefined ? [] : [found.replace(/\r$/, '') + eol]
  }).join('\n')
}

/** 占位文字里的记忆 id（标题属性里的写法），按出现的先后。 */
export function placeholderIds(text: string): string[] {
  return text.split('\n').flatMap(line => (line.startsWith(MEMBER_PLACEHOLDER) ? [line.slice(MEMBER_PLACEHOLDER.length).replace(/\r$/, '')] : []))
}

/** 一页里的成员 id（标题属性里的写法），按出现的先后。 */
export function memberKeys(text: string): string[] {
  return scan(text).flatMap((row) => { const m = memberOf(row); return m === null ? [] : [m[2]!] })
}

/** 从一页里去掉这些记忆的成员行（id 是标题属性里的写法），别的行原样。 */
export function withoutMemberKeys(text: string, ids: ReadonlySet<string>): string {
  return scan(text).filter((row) => { const m = memberOf(row); return m === null || !ids.has(m[2]!) }).map(row => row.line).join('\n')
}

/** 把几行成员接在一页的末尾（页以换行结尾）。 */
export function withMemberLinesAppended(text: string, lines: readonly string[]): string {
  if (lines.length === 0) return text
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  const body = text.replace(/(\r?\n)*$/, '')
  return `${body}${body === '' ? '' : eol}${lines.map(l => l.replace(/\r$/, '')).join(eol)}${eol}`
}

/** 这份索引里每条记忆的成员行（按 id，标题属性里的写法）；同一条出现几次取先看到的。 */
export function memberLines(files: IndexFiles): Map<string, string> {
  const lines = new Map<string, string>()
  for (const text of Object.values(files.pages)) {
    for (const row of scan(text)) {
      const m = memberOf(row)
      if (m !== null && !lines.has(m[2]!)) lines.set(m[2]!, row.line)
    }
  }
  return lines
}

/**
 * 落盘前遮一遍主题页里手写的文字（主题名、曾用名、别的备注）：成员行原样留着（链接和 id 不能被改坏；它的名称和摘要
 * 由调用方在交进核对之前遮好），其余的行连成段交给 mask，跨行的密钥（私钥块）也遮得住。
 * 入口文件里没有成员行，整份直接交给 mask，不走这里。
 */
export function maskIndexText(text: string, mask: (text: string) => string): string {
  const out: string[] = []
  let block: string[] = []
  const flush = () => {
    if (block.length > 0) out.push(mask(block.join('\n')))
    block = []
  }
  for (const row of scan(text)) {
    if (!memberOf(row)) { block.push(row.line); continue }
    flush()
    out.push(row.line)
  }
  flush()
  return out.join('\n')
}

/** 页头里的提交标记：最近一次改写这一页的操作 id；没有页头为 undefined。 */
export function stampOf(text: string): string | undefined {
  return headerValue(text, STAMP_KEY)
}

/** 页头里的建页时刻（毫秒）；没有（手建的页、早先建的页）为 undefined。 */
export function createdAtOf(text: string): number | undefined {
  const at = Date.parse(headerValue(text, CREATED_KEY) ?? '')
  return Number.isNaN(at) ? undefined : at
}

export function withCreatedAt(text: string, at: number): string {
  return withHeaderValue(text, CREATED_KEY, new Date(at).toISOString())
}

/** 把提交标记写进页头（已有就替换），正文不动；页头的换行跟正文走。 */
export function withStamp(text: string, op: string): string {
  return withHeaderValue(text, STAMP_KEY, op)
}

export interface PageFacts { fileName: string; name: string; aliases: string[]; memberIds: string[] }

function pageFacts(fileName: string, text: string): PageFacts {
  let name: string | undefined
  const aliases: string[] = []
  const memberIds: string[] = []
  for (const row of scan(text.replace(HEADER_RE, ''))) {
    if (row.isCode) continue
    const line = row.line.replace(/\r$/, '')
    const member = MEMBER_RE.exec(line)
    if (member) { memberIds.push(unescape(member[2]!)); continue }
    const heading = HEADING_RE.exec(line)
    if (heading?.[1] === '#') { name ??= heading[2]!; continue }
    const listed = ALIASES_RE.exec(line.trim())
    if (listed) aliases.push(...listed[1]!.split(/[、,，]/).map(a => a.trim()).filter(a => a !== ''))
  }
  return { fileName, name: name ?? fileName.replace(/\.md$/, ''), aliases, memberIds }
}

/**
 * 入口里的主题：二级标题和标题下的第一段（压成一行）。标题可以只写主题名（按名字对主题页），
 * 也可以写成链到主题页的链接（按文件对，主题改名、重名都不会对错页）；fileName 只有后一种有。
 */
export function entryTopics(entry: string): Array<{ name: string; fileName: string | undefined; about: string }> {
  const topics: Array<{ name: string; fileName: string | undefined; about: string[]; isClosed: boolean }> = []
  for (const row of scan(entry.replace(HEADER_RE, ''))) {
    if (row.isCode) continue
    const line = row.line.replace(/\r$/, '')
    const heading = HEADING_RE.exec(line)
    if (heading) {
      if (heading[1] === '##') {
        const linked = LINKED_HEADING_RE.exec(heading[2]!)
        topics.push({ name: linked ? unescape(linked[1]!) : heading[2]!, fileName: linked ? decodePath(linked[2]!) : undefined, about: [], isClosed: false })
      }
      continue
    }
    const current = topics.at(-1)
    if (current === undefined || current.isClosed) continue
    if (line.trim() === '') current.isClosed = current.about.length > 0
    else current.about.push(line.trim())
  }
  return topics.map(t => ({ name: t.name, fileName: t.fileName, about: t.about.join(' ') }))
}

/**
 * 主题页的先后：入口里出现的顺序在前，入口里没有的按文件名排在后。
 * 同一条记忆出现在两页、两个页同名时，都以这个顺序里靠前的为准。
 */
export function orderedPages(files: IndexFiles): Array<PageFacts & { about: string }> {
  const listed = entryTopics(files.entry)
  const byFile = new Map<string, { at: number; about: string }>()
  const byName = new Map<string, { at: number; about: string }>()
  for (const [at, t] of listed.entries()) {
    if (t.fileName !== undefined) { if (!byFile.has(t.fileName)) byFile.set(t.fileName, { at, about: t.about }) }
    else if (!byName.has(keyOf(t.name))) byName.set(keyOf(t.name), { at, about: t.about })
  }
  return Object.keys(files.pages)
    .filter(fileName => fileName !== UNSORTED_PAGE)
    .map(fileName => {
      const facts = pageFacts(fileName, files.pages[fileName]!)
      const inEntry = byFile.get(fileName) ?? byName.get(keyOf(facts.name))
      return { ...facts, about: inEntry?.about ?? '', at: inEntry?.at ?? Number.POSITIVE_INFINITY }
    })
    .sort((a, b) => a.at - b.at || byText(a.fileName, b.fileName))
    .map(({ at: _, ...page }) => page)
}

/** 读出索引的结构：各主题（先后见 orderedPages）和「未整理」里的记忆 id。 */
export function readIndex(files: IndexFiles): { topics: Topic[]; unsorted: string[] } {
  const unsorted = files.pages[UNSORTED_PAGE]
  return { topics: orderedPages(files), unsorted: unsorted === undefined ? [] : pageFacts(UNSORTED_PAGE, unsorted).memberIds }
}

export interface ReconcileReport {
  /** 补进「未整理」的记忆。 */
  added: string[]
  /** 指向已不在的记忆、被去掉的行。 */
  removed: string[]
  /** 同一条记忆多出来、被去掉的行（一行记一次）。 */
  deduped: string[]
  /** 名称、摘要或文件名按记忆同步过的行。 */
  synced: string[]
  /** 补进入口的主题名。 */
  entryAdded: string[]
}

/**
 * 整份核对：拿索引和在用记忆清单，得出修正后的索引。不调模型，结果只由两个入参决定，核对两遍结果相同。
 *  - 没出现在任何主题页的记忆追加到「未整理」（按名称排）；
 *  - 行指向的记忆已不在的去掉；同一条记忆的行只留先出现的那一行；
 *  - 行的名称、摘要、文件名按记忆同步（行按 id 认，位置和列表符号不动）；
 *  - 入口里没有的主题页补到入口末尾；入口里没有页的标题是手写的文字，不动。
 * 还没有索引（files 为 undefined）时全部记忆进「未整理」。其余文字逐字保留，围栏代码块里的行不碰。
 * isComplete 为 false（这一层有读不出来的记忆文件）时，清单里没有的行不去掉：那条记忆可能只是这一次没读出来，
 * 去掉了它归在哪个主题就找不回来。
 */
export function reconcileIndex(
  files: IndexFiles | undefined, memories: readonly IndexedMemory[], isComplete = true,
): { files: IndexFiles; report: ReconcileReport } {
  const report: ReconcileReport = { added: [], removed: [], deduped: [], synced: [], entryAdded: [] }
  const source: IndexFiles = files ?? { entry: '', pages: {} }
  const byId = new Map(memories.map(m => [m.id, m]))
  const seen = new Set<string>()
  const pages: Record<string, string> = {}
  const ordered = orderedPages(source)
  const fileNames = [...ordered.map(p => p.fileName), ...(source.pages[UNSORTED_PAGE] === undefined ? [] : [UNSORTED_PAGE])]
  for (const fileName of fileNames) {
    const kept: string[] = []
    for (const row of scan(source.pages[fileName]!)) {
      const eol = row.line.endsWith('\r') ? '\r' : ''
      const line = eol === '' ? row.line : row.line.slice(0, -1)
      const member = row.isCode ? null : MEMBER_RE.exec(line)
      if (!member) { kept.push(row.line); continue }
      const id = unescape(member[2]!)
      const memory = byId.get(id)
      if (memory === undefined && isComplete) { report.removed.push(id); continue }
      if (seen.has(id)) { report.deduped.push(id); continue }
      seen.add(id)
      if (memory === undefined) { kept.push(row.line); continue }
      const synced = memberLine(memory, member[1])
      if (synced !== line) report.synced.push(id)
      kept.push(synced + eol)
    }
    pages[fileName] = kept.join('\n')
  }
  const missing = memories.filter(m => !seen.has(m.id)).sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id))
  if (missing.length > 0 || files === undefined) {
    const base = pages[UNSORTED_PAGE] ?? `# ${UNSORTED_TITLE}\n\n`
    const lines = missing.map(m => memberLine(m))
    pages[UNSORTED_PAGE] = lines.length === 0 ? base : `${base.endsWith('\n') || base === '' ? base : `${base}\n`}${lines.join('\n')}\n`
    report.added.push(...missing.map(m => m.id))
  }
  const listed = entryTopics(source.entry)
  const linkedFiles = new Set(listed.flatMap(t => (t.fileName === undefined ? [] : [t.fileName])))
  const plainNames = new Set(listed.flatMap(t => (t.fileName === undefined ? [keyOf(t.name)] : [])))
  let entry = source.entry.replace(HEADER_RE, '').trim() === '' ? `${source.entry}# ${ENTRY_TITLE}\n` : source.entry
  for (const page of ordered) {
    if (linkedFiles.has(page.fileName) || plainNames.has(keyOf(page.name))) continue
    plainNames.add(keyOf(page.name))
    const title = page.name.replace(/[[\]\\]/g, c => `\\${c}`)
    entry = `${entry.endsWith('\n') ? entry : `${entry}\n`}\n## [${title}](topics/${encodePath(page.fileName)})\n`
    report.entryAdded.push(page.name)
  }
  return { files: { entry, pages }, report }
}

/**
 * 能不能当主题名（已去首尾空白）。带换行或以 # 开头的名字写成标题会把页的结构弄坏；
 * 顿号和逗号是曾用名一行的分隔符，名字里带了，改名之后旧名会被拆成两个。
 */
export function isTopicName(name: string): boolean {
  const reserved = [UNSORTED_TITLE, UNSORTED_PAGE.replace(/\.md$/, '')].map(keyOf)
  return name !== '' && [...name].length <= TOPIC_NAME_MAX && !reserved.includes(keyOf(name)) && !/[\r\n、,，]|^#/.test(name)
}

/**
 * 主题名不能用的原因，按判的先后排：空的、超过 TOPIC_NAME_MAX 个字符、和「未整理」重名、带换行或顿号逗号、以 # 开头。
 * 同时犯几条时给最前的那一条。
 */
export const TOPIC_NAME_PROBLEMS = ['empty', 'too-long', 'reserved', 'bad-char', 'heading'] as const
export type TopicNameProblem = (typeof TOPIC_NAME_PROBLEMS)[number]

/**
 * 这个名字（已去首尾空白）为什么不能当主题名；能用返回 undefined。和 isTopicName 是同一个判定：
 * isTopicName(name) 恒等于 topicNameProblem(name) === undefined。
 */
export function topicNameProblem(name: string): TopicNameProblem | undefined {
  if (name === '') return 'empty'
  if ([...name].length > TOPIC_NAME_MAX) return 'too-long'
  if ([UNSORTED_TITLE, UNSORTED_PAGE.replace(/\.md$/, '')].map(keyOf).includes(keyOf(name))) return 'reserved'
  if (/[\r\n、,，]/.test(name)) return 'bad-char'
  if (name.startsWith('#')) return 'heading'
  return undefined
}

/** 新建主题、主题用不了时，结果里列几个名字最相近的现有主题。 */
export const NEAREST_TOPICS_LIMIT = 2

/**
 * 名字最相近的几个现有主题（「未整理」不算），返回主题名。比法：keyOf(name) 和各主题的 keyOf(名字)、keyOf(每个曾用名)
 * 分别算 charSimilarity，取其中最高的作为这个主题的分；按分降序取前 limit 个，同分按 orderedPages 的先后。
 * 新建闸用的是同一个相似度函数。
 */
export function nearestTopics(files: IndexFiles, name: string, limit: number = NEAREST_TOPICS_LIMIT): string[] {
  return orderedPages(files).map(t => ({ name: t.name, score: Math.max(...[t.name, ...t.aliases].map(n => charSimilarity(keyOf(name), keyOf(n)))) })).sort((a, b) => b.score - a.score).slice(0, limit).map(t => t.name)
}

/**
 * 按名字认主题：去首尾空白、不分大小写（keyOf）。名字优先：有名字对上的就只回它们；一个都没有才回曾用名对上的；
 * 都没有回空数组。两档里各按 topics 的先后。namesOf 给出一个主题算作「名字」的那几个写法，缺省只有它的名字
 * （检索还算上显示名）。保存、只改主题、换作用域带上原来的主题、整理索引按名字找页，都取第一个；按主题检索列出每个作用域里回来的全部。
 */
export function topicsNamed<T extends { name: string; aliases: readonly string[] }>(topics: readonly T[], name: string, namesOf?: (topic: T) => readonly string[]): T[] {
  const key = keyOf(name)
  const named = topics.filter(t => (namesOf?.(t) ?? [t.name]).some(n => keyOf(n) === key))
  return named.length > 0 ? named : topics.filter(t => t.aliases.some(n => keyOf(n) === key))
}

export type TopicResolution =
  | { kind: 'existing'; fileName: string; name: string }
  /** 还没有这个主题，可以建：fileName 是要建的主题页。 */
  | { kind: 'new'; fileName: string; name: string }
  /** 主题数到上限，不建。 */
  | { kind: 'full' }
  /** 不能当主题名：空的、太长、和「未整理」重名、带换行或顿号逗号、以 # 开头。 */
  | { kind: 'invalid' }

/**
 * 模型交来的主题名落到哪一页：按当下的索引解析，现有主题的名字和曾用名都算（去首尾空白、不分大小写）。
 * 没有这个主题时给出要建的页：文件名取主题名的 slug，和现有的页撞名（文件系统可能不分大小写）就追加主题名的哈希片段。
 */
export function resolveTopic(files: IndexFiles, rawName: string, maxTopics: number): TopicResolution {
  const name = rawName.trim()
  if (!isTopicName(name)) return { kind: 'invalid' }
  const topics = orderedPages(files)
  const existing = topicsNamed(topics, name)[0]
  if (existing) return { kind: 'existing', fileName: existing.fileName, name: existing.name }
  if (topics.length >= maxTopics) return { kind: 'full' }
  // 文件系统可能不分大小写、把写法不同的同一个字当成同名：都按规范化后的小写比
  const fileKey = (fileName: string) => fileName.normalize('NFC').toLowerCase()
  const taken = new Set(Object.keys(files.pages).concat(UNSORTED_PAGE).map(fileKey))
  // slug 按长度截断时可能切在一个字的中间，剩下的半个字编不进文件名
  const slug = slugifyName(name).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  const hash = createHash('sha1').update(name).digest('hex')
  // 先不带后缀；撞名就追加主题名的哈希片段，片段还撞就加长，整段哈希都撞再编号
  const candidates = function* () {
    yield `${slug}.md`
    for (let length = 6; length <= hash.length; length += 2) yield `${slug}-${hash.slice(0, length)}.md`
    for (let n = 2; ; n++) yield `${slug}-${hash}-${n}.md`
  }
  for (const fileName of candidates()) if (!taken.has(fileKey(fileName))) return { kind: 'new', fileName, name }
  return { kind: 'invalid' }
}

/** 把一条记忆的行从各主题页里去掉（它搬去了别的目录）。返回改过的索引；哪一页都没有它时原样返回。 */
export function withoutMember(files: IndexFiles, id: string): IndexFiles {
  const pages: Record<string, string> = {}
  for (const [fileName, text] of Object.entries(files.pages)) {
    pages[fileName] = scan(text).filter(row => { const m = memberOf({ ...row, line: row.line.replace(/\r$/, '') }); return !m || unescape(m[2]!) !== id }).map(row => row.line).join('\n')
  }
  return { entry: files.entry, pages }
}

/** 投影开头的说明：这份文件只给人看，改它不生效。 */
export const PROJECTION_NOTE = '<!-- 自动生成：要调整请改 _index/ 下的文件，直接改这里会被覆盖。 -->'

/**
 * MEMORY.md 的全文：索引的一份方便读的投影。每个主题一段（主题名链到主题页、主题说明、条数），「未整理」放最后。
 * staleIds 是久未确认的记忆 id，只用来数数。
 */
export function renderProjection(files: IndexFiles, staleIds: ReadonlySet<string>): string {
  const { topics, unsorted } = readIndex(files)
  const section = (title: string, fileName: string, about: string, ids: readonly string[]) => {
    const stale = ids.filter(id => staleIds.has(id)).length
    const count = `${ids.length} 条${stale > 0 ? `（其中久未确认 ${stale} 条）` : ''}`
    return [`## [${title}](_index/topics/${encodePath(fileName)})`, ...(about === '' ? [] : [about]), '', count, '']
  }
  return [
    PROJECTION_NOTE,
    `# ${ENTRY_TITLE}`,
    '',
    ...topics.flatMap(t => section(t.name, t.fileName, t.about, t.memberIds)),
    ...section(UNSORTED_TITLE, UNSORTED_PAGE, '', unsorted),
  ].join('\n')
}
