import { createHash } from 'node:crypto'
import {
  ALIASES_RE, HEADER_RE, HEADING_RE, LINKED_HEADING_RE, MEMBER_RE, UNSORTED_PAGE, UNSORTED_TITLE,
  decodePath, encodePath, isTopicName, keyOf, orderedPages, resolveTopic, scan, unescape, withCreatedAt, withMemberText, withoutMemberText,
  type IndexFiles,
} from './topic-index.ts'

/**
 * 索引操作的纯函数：把一个操作按当下的索引定成具体的计划、把计划套到索引上、把计划撤回去。不碰磁盘。
 *
 * - 操作（IndexOp）用主题名说话，是模型和调用方交来的样子；计划（IndexPlan）用文件名说话，带上撤销要用的改前数据，
 *   可以原样存进回执。计划里说到记忆只用 id：改前的整页里成员行换成只带 id 的占位，记忆的名称和摘要不进计划。
 * - 套计划（applyPlan）可以重复做：对已经套了一半的索引再套一次，得到套完的索引。中断后的补做靠这一点。
 * - 撤销（undoPlan）按效果判：这一步写下的效果还在才撤，期间别处进来的行留着；效果已经不在了就说撤不了。
 * - 六种操作：归主题、改名、合并、调主题顺序、调成员顺序、改说明。拆分就是几次归到新主题，不另算一种。
 */

export type IndexOp =
  /** 把 from 主题（或「未整理」）里的几条记忆归到 to 主题；to 还没有就新建，about 是新主题的说明。 */
  | { kind: 'assign'; memoryIds: readonly string[]; from: string; to: string; about?: string }
  | { kind: 'rename'; topic: string; name: string }
  /** 把 from 里的主题并进 into；about 给了就换成合并后的说明。 */
  | { kind: 'merge'; from: readonly string[]; into: string; about?: string }
  | { kind: 'order-topics'; order: readonly string[] }
  | { kind: 'order-members'; topic: string; order: readonly string[] }
  | { kind: 'describe'; topic: string; about: string }

/** 一条记忆从哪一页的第几个成员位置搬走的。 */
export interface MovedMember { id: string; from: string; at: number }

export type IndexPlan =
  | { kind: 'assign'; page: string; name: string; isNew: boolean; about?: string; createdAt?: number; moved: MovedMember[] }
  | { kind: 'rename'; page: string; from: string; to: string; aboutBefore: string; aliasesBefore: string[] }
  | {
    kind: 'merge'; page: string; name: string; moved: MovedMember[]
    /**
     * 并进来的主题：改前的整页（成员行是只带 id 的占位）、页里成员行之外的文字的指纹（body，搬空之后页里别的文字还是这样才删页）、
     * 它在入口里的那一节和位置（入口里没有这一节时没有）。
     */
    sources: Array<{ page: string; name: string; aliases: string[]; text: string; body: string; section?: { text: string; at: number } }>
    about?: string
    aboutBefore: string
    aliasesBefore: string[]
  }
  | { kind: 'order-topics'; order: string[]; before: string[] }
  | { kind: 'order-members'; page: string; order: string[]; before: string[] }
  | { kind: 'describe'; page: string; about: string; before: string }

export type PlanResult = { kind: 'planned'; plan: IndexPlan } | { kind: 'skipped'; reason: string }

export interface PlanContext {
  /** 主题数上限。 */
  maxTopics: number
  /** 还在用的记忆：不在里面的不搬。 */
  activeIds: ReadonlySet<string>
  /** 新建主题页时写进页头的建页时刻。 */
  now: number
}

/** 套完计划的索引；deleted 是要删掉的主题页。 */
export interface AppliedIndex { files: IndexFiles; deleted: string[] }

type Row = { line: string; isCode: boolean }

const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
const escapeTitle = (name: string) => name.replace(/[[\]\\]/g, c => `\\${c}`)
const bare = (line: string) => line.replace(/\r$/, '')
const memberIdOf = (row: Row) => {
  if (row.isCode) return undefined
  const m = MEMBER_RE.exec(bare(row.line))
  return m ? unescape(m[2]!) : undefined
}

/** 把页头和正文分开：操作只动正文，页头原样接回去。 */
function splitHeader(text: string): { header: string; rows: Row[] } {
  const header = HEADER_RE.exec(text)?.[0] ?? ''
  return { header, rows: scan(text.slice(header.length)) }
}
const joinPage = (header: string, rows: readonly Row[]) => header + rows.map(r => r.line).join('\n')

const memberIds = (text: string) => splitHeader(text).rows.flatMap(r => memberIdOf(r) ?? [])

/** 一页里成员行和空行之外的文字（页头不算）：标题、曾用名、手写的备注。 */
const bodyLines = (text: string) => splitHeader(text).rows.filter(r => memberIdOf(r) === undefined && bare(r.line).trim() !== '').map(r => bare(r.line))
/** 那些文字的指纹：删页前拿它确认页里没有多出别人后来写的东西。 */
const bodyDigest = (text: string) => createHash('sha1').update(bodyLines(text).join('\n')).digest('hex').slice(0, 16)

/** 从一页里取出这些记忆的行（按页里的先后），并给出去掉它们之后的页。 */
function takeMembers(text: string, ids: ReadonlySet<string>): { lines: Map<string, string>; rest: string } {
  const { header, rows } = splitHeader(text)
  const lines = new Map<string, string>()
  const kept = rows.filter(row => {
    const id = memberIdOf(row)
    if (id === undefined || !ids.has(id)) return true
    if (!lines.has(id)) lines.set(id, bare(row.line))
    return false
  })
  return { lines, rest: joinPage(header, kept) }
}

/** 把几行成员插进一页：at 是插在第几个成员前面，超过成员数就接在最后一个成员后面；页里还没有成员时放在末尾。 */
function insertMembers(text: string, lines: readonly string[], at: number): string {
  if (lines.length === 0) return text
  const { header, rows } = splitHeader(text)
  const eol = rows.some(r => r.line.endsWith('\r')) ? '\r' : ''
  const added = lines.map(line => ({ line: line + eol, isCode: false }))
  const positions = rows.flatMap((r, i) => (memberIdOf(r) === undefined ? [] : [i]))
  if (positions.length > 0) {
    const index = at < positions.length ? positions[at]! : positions.at(-1)! + 1
    return joinPage(header, [...rows.slice(0, index), ...added, ...rows.slice(index)])
  }
  // 没有成员：放在末尾，和前面的文字隔一个空行，文件以换行结尾
  const body = rows.slice()
  while (body.length > 0 && bare(body.at(-1)!.line).trim() === '') body.pop()
  const gap = body.length === 0 ? [] : [{ line: eol, isCode: false }]
  return joinPage(header, [...body, ...gap, ...added, { line: '', isCode: false }])
}

function titleIndex(rows: readonly Row[]): number {
  return rows.findIndex(r => !r.isCode && HEADING_RE.exec(bare(r.line))?.[1] === '#')
}

function withTitle(text: string, name: string): string {
  const { header, rows } = splitHeader(text)
  const at = titleIndex(rows)
  const eol = rows.some(r => r.line.endsWith('\r')) ? '\r' : ''
  const title = { line: `# ${name}${eol}`, isCode: false }
  return joinPage(header, at === -1 ? [title, { line: eol, isCode: false }, ...rows] : [...rows.slice(0, at), title, ...rows.slice(at + 1)])
}

function titleOf(text: string): string | undefined {
  const { rows } = splitHeader(text)
  const at = titleIndex(rows)
  return at === -1 ? undefined : HEADING_RE.exec(bare(rows[at]!.line))![2]
}

function aliasesOf(text: string): string[] {
  return splitHeader(text).rows.flatMap(r => {
    const listed = r.isCode ? null : ALIASES_RE.exec(bare(r.line).trim())
    return listed ? listed[1]!.split(/[、,，]/).map(a => a.trim()).filter(a => a !== '') : []
  })
}

/** 把曾用名一行换成给定的清单（空清单就去掉这一行）；页里有几行曾用名时并成一行。 */
function withAliases(text: string, aliases: readonly string[]): string {
  const { header, rows } = splitHeader(text)
  const eol = rows.some(r => r.line.endsWith('\r')) ? '\r' : ''
  const isAliasRow = (r: Row) => !r.isCode && ALIASES_RE.test(bare(r.line).trim())
  const first = rows.findIndex(isAliasRow)
  const line = { line: `曾用名：${aliases.join('、')}${eol}`, isCode: false }
  if (first !== -1) {
    const kept = rows.filter((r, i) => i === first || !isAliasRow(r))
    const at = kept.findIndex(isAliasRow)
    if (aliases.length > 0) return joinPage(header, [...kept.slice(0, at), line, ...kept.slice(at + 1)])
    // 去掉这一行：它前后都是空行时连前面那个空行一起去掉，不留两个连着的空行
    const isBlank = (r: Row | undefined) => r !== undefined && bare(r.line).trim() === ''
    const from = isBlank(kept[at - 1]) && (isBlank(kept[at + 1]) || at + 1 === kept.length) ? at - 1 : at
    return joinPage(header, [...kept.slice(0, from), ...kept.slice(at + 1)])
  }
  if (aliases.length === 0) return text
  const title = titleIndex(rows)
  const at = title === -1 ? 0 : title + 1
  return joinPage(header, [...rows.slice(0, at), { line: eol, isCode: false }, line, ...rows.slice(at)])
}

/** 两份名单合在一起，按判同规则去重，保留先出现的写法。 */
function mergeNames(...lists: Array<readonly string[]>): string[] {
  const seen = new Set<string>()
  return lists.flat().filter(name => {
    const key = keyOf(name)
    if (key === '' || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── 入口 ──

interface Section { rows: Row[]; name: string; fileName: string | undefined }
interface Entry { header: string; lead: Row[]; sections: Section[] }

/** 把入口按二级标题切成节：一节是标题行加它后面直到下一个二级标题之前的全部文字。 */
function splitEntry(entry: string): Entry {
  const { header, rows } = splitHeader(entry)
  const lead: Row[] = []
  const sections: Section[] = []
  for (const row of rows) {
    const heading = row.isCode ? null : HEADING_RE.exec(bare(row.line))
    if (heading?.[1] === '##') {
      const linked = LINKED_HEADING_RE.exec(heading[2]!)
      sections.push({ rows: [row], name: linked ? unescape(linked[1]!) : heading[2]!, fileName: linked ? decodePath(linked[2]!) : undefined })
    } else if (sections.length === 0) lead.push(row)
    else sections.at(-1)!.rows.push(row)
  }
  return { header, lead, sections }
}
const joinEntry = (e: Entry) => joinPage(e.header, [...e.lead, ...e.sections.flatMap(s => s.rows)])

/** 一个主题页在入口里的那一节：先按链接里的文件名对，再按名字对。 */
function sectionIndex(e: Entry, page: string, name: string): number {
  const linked = e.sections.findIndex(s => s.fileName === page)
  return linked !== -1 ? linked : e.sections.findIndex(s => s.fileName === undefined && keyOf(s.name) === keyOf(name))
}

/** 说明那一段占的行：标题下第一段，围栏代码块和一级标题跳过不算。 */
function aboutRows(section: Section): number[] {
  const found: number[] = []
  for (let i = 1; i < section.rows.length; i++) {
    const row = section.rows[i]!
    if (row.isCode || HEADING_RE.test(bare(row.line))) continue
    if (bare(row.line).trim() === '') { if (found.length > 0) break } else found.push(i)
  }
  return found
}
const aboutOf = (section: Section) => aboutRows(section).map(i => bare(section.rows[i]!.line).trim()).join(' ')

function withAbout(section: Section, about: string): Section {
  const at = aboutRows(section)
  const text = oneLine(about)
  const eol = section.rows[0]!.line.endsWith('\r') ? '\r' : ''
  const line = { line: text + eol, isCode: false }
  if (at.length > 0) {
    const rest = new Set(at.slice(1))
    const rows = section.rows.flatMap((row, i) => (i === at[0] ? (text === '' ? [] : [line]) : rest.has(i) ? [] : [row]))
    return { ...section, rows }
  }
  if (text === '') return section
  const blank = { line: eol, isCode: false }
  const tail = section.rows.slice(1)
  const isOpen = tail.length > 0 && bare(tail[0]!.line).trim() !== ''
  return { ...section, rows: [section.rows[0]!, blank, line, ...(isOpen || tail.length === 0 ? [blank] : []), ...tail] }
}

function linkedHeading(section: Section, page: string, name: string): Section {
  const eol = section.rows[0]!.line.endsWith('\r') ? '\r' : ''
  return { rows: [{ line: `## [${escapeTitle(name)}](topics/${encodePath(page)})${eol}`, isCode: false }, ...section.rows.slice(1)], name, fileName: page }
}

function newSection(page: string, name: string, about: string): Section {
  const text = oneLine(about)
  const rows = [`## [${escapeTitle(name)}](topics/${encodePath(page)})`, ...(text === '' ? [] : ['', text]), ''].map(line => ({ line, isCode: false }))
  return { rows, name, fileName: page }
}

/** 把一节插到第 at 个位置（超出就放最后），和前一段文字之间留一个空行。 */
function insertSection(e: Entry, section: Section, at: number): Entry {
  const sections = e.sections.slice()
  const index = Math.min(at, sections.length)
  const before = index === 0 ? e.lead : sections[index - 1]!.rows
  // 前一段以空行结尾，标题才不会贴着上面的文字（文件以换行结尾时，最后那个空串接上后面的行就是空行）
  const last = before.at(-1)
  if (last !== undefined && bare(last.line).trim() !== '') {
    const pad = { line: '', isCode: false }
    if (index === 0) e = { ...e, lead: [...e.lead, pad] }
    else sections[index - 1] = { ...sections[index - 1]!, rows: [...sections[index - 1]!.rows, pad] }
  }
  const rows = bare(section.rows.at(-1)!.line).trim() === '' ? section.rows : [...section.rows, { line: '', isCode: false }]
  sections.splice(index, 0, { ...section, rows })
  return { ...e, sections }
}

const sectionFromText = (text: string): Section | undefined => splitEntry(text).sections[0]

const FORMER_NOTE_OPEN = '（曾用名：'
/** 括号成对：从左到右右括号不比左括号多，数到头正好抵消。 */
const isBalanced = (text: string) => {
  let depth = 0
  for (const ch of text) {
    if (ch === '（') depth++
    else if (ch === '）' && --depth < 0) return false
  }
  return depth === 0
}
/**
 * 说明末尾那句「（曾用名：…）」从哪开始；没有这一句为 -1。旧名自己可以带成对的括号；
 * 开头字样到末尾之间括号不成对的（那几个字只是出现在正文中间）不算。
 */
const formerNoteAt = (about: string) => {
  if (!about.endsWith('）')) return -1
  const at = about.lastIndexOf(FORMER_NOTE_OPEN)
  return at !== -1 && isBalanced(about.slice(at + FORMER_NOTE_OPEN.length, -1)) ? at : -1
}
const formerNames = (about: string) => {
  const at = formerNoteAt(about)
  return at === -1 ? [] : about.slice(at + FORMER_NOTE_OPEN.length, -1).split('、').map(n => n.trim()).filter(n => n !== '')
}
const withoutFormerNote = (about: string) => { const at = formerNoteAt(about); return at === -1 ? about : about.slice(0, at) }
const withFormerNote = (head: string, names: readonly string[]) => (names.length === 0 ? head : `${head}（曾用名：${names.join('、')}）`)

/** 入口里的说明末尾带一句「（曾用名：…）」：把这些旧名记进去，已经记着的不重复。 */
function aboutWithFormerNames(about: string, names: readonly string[]): string {
  return withFormerNote(withoutFormerNote(about), mergeNames(formerNames(about), names))
}
/** 把说明末尾那句曾用名里的这些名字拿掉；一个都不剩就整句去掉。 */
function aboutWithoutFormerNames(about: string, names: readonly string[]): string {
  const drop = new Set(names.map(keyOf))
  return withFormerNote(withoutFormerNote(about), formerNames(about).filter(name => !drop.has(keyOf(name))))
}

/** 说明要落成入口里的一行普通文字：以标题记号或代码围栏开头的会改掉入口的结构，不收。 */
const isAbout = (text: string) => !/^(#{1,6}(\s|$)|```|~~~)/.test(text)

// ── 定计划 ──

const skipped = (reason: string): PlanResult => ({ kind: 'skipped', reason })

/** 按名字或曾用名找现有的主题。 */
function findTopic(files: IndexFiles, name: string) {
  const key = keyOf(name)
  const topics = orderedPages(files)
  return topics.find(t => keyOf(t.name) === key) ?? topics.find(t => t.aliases.some(a => keyOf(a) === key))
}

/** 这几条记忆现在在 page 页里的、还在用的那些，连同各自的位置。 */
function movable(files: IndexFiles, page: string, ids: readonly string[], active: ReadonlySet<string>): MovedMember[] {
  const position = new Map<string, number>()
  memberIds(files.pages[page] ?? '').forEach((id, at) => { if (!position.has(id)) position.set(id, at) })
  return [...new Set(ids)].flatMap(id => {
    const at = position.get(id)
    return at === undefined || !active.has(id) ? [] : [{ id, from: page, at }]
  })
}

/** 套完之后搬的记忆确实成了目标页的成员才算数：目标页结尾落在代码块里之类的情况，行放进去也不算成员，这个操作不做。 */
function landed(files: IndexFiles, plan: Extract<IndexPlan, { kind: 'assign' | 'merge' }>): PlanResult {
  const members = new Set(memberIds(applyPlan(files, plan).files.pages[plan.page] ?? ''))
  return plan.moved.every(m => members.has(m.id)) ? { kind: 'planned', plan } : skipped('目标主题页放不进成员（页里有没收尾的代码块）')
}

/**
 * 把一个操作按当下的索引定成计划。对不上的（主题不在了、记忆不在那个主题里了、名字不能用、到上限）跳过并说明原因，
 * 一个操作跳过不影响别的。
 */
export function planIndexOp(files: IndexFiles, op: IndexOp, ctx: PlanContext): PlanResult {
  switch (op.kind) {
    case 'assign': {
      const fromPage = keyOf(op.from) === keyOf(UNSORTED_TITLE) ? UNSORTED_PAGE : findTopic(files, op.from)?.fileName
      if (fromPage === undefined || files.pages[fromPage] === undefined) return skipped(`主题「${op.from}」不在了`)
      const target = resolveTopic(files, op.to, ctx.maxTopics)
      if (target.kind === 'invalid') return skipped(`「${op.to}」不能当主题名`)
      if (target.kind === 'full') return skipped(`主题数已到上限，没有新建「${op.to.trim()}」`)
      if (target.fileName === fromPage) return skipped('已经在这个主题里')
      const moved = movable(files, fromPage, op.memoryIds, ctx.activeIds)
      if (moved.length === 0) return skipped(`这些记忆已经不在「${op.from}」里`)
      const isNew = target.kind === 'new'
      // 新主题的说明不合适就先空着，记忆照样归过去
      const about = oneLine(op.about ?? '')
      return landed(files, { kind: 'assign', page: target.fileName, name: target.name, isNew, ...(isNew ? { about: isAbout(about) ? about : '', createdAt: ctx.now } : {}), moved })
    }
    case 'rename': {
      const topic = findTopic(files, op.topic)
      if (topic === undefined) return skipped(`主题「${op.topic}」不在了`)
      const name = op.name.trim()
      if (!isTopicName(name)) return skipped(`「${op.name}」不能当主题名`)
      if (name === topic.name) return skipped('名字没变')
      const clash = findTopic(files, name)
      // 只是改大小写、或改回自己的曾用名可以；撞上别的主题的名字或曾用名不改
      if (clash !== undefined && clash.fileName !== topic.fileName) return skipped(`已经有主题叫「${name}」`)
      return { kind: 'planned', plan: { kind: 'rename', page: topic.fileName, from: topic.name, to: name, aboutBefore: topic.about, aliasesBefore: topic.aliases } }
    }
    case 'merge': {
      const into = findTopic(files, op.into)
      if (into === undefined) return skipped(`主题「${op.into}」不在了`)
      const entry = splitEntry(files.entry)
      const found = [...new Map(op.from.flatMap(name => {
        const t = findTopic(files, name)
        return t === undefined || t.fileName === into.fileName ? [] : [[t.fileName, t] as const]
      })).values()]
      if (found.length === 0) return skipped('要并进来的主题都不在了')
      // 被并的页里还有不在用的记忆的行（等维护清掉）时先不并：页搬不空，旧名会留在一张空页上
      if (found.some(t => t.memberIds.some(id => !ctx.activeIds.has(id)))) return skipped('要并进来的主题里有等着清理的成员行')
      const sources = found.map(t => {
        const at = sectionIndex(entry, t.fileName, t.name)
        return {
          page: t.fileName, name: t.name, aliases: t.aliases, text: withoutMemberText(files.pages[t.fileName]!), body: bodyDigest(files.pages[t.fileName]!),
          ...(at === -1 ? {} : { section: { text: entry.sections[at]!.rows.map(r => r.line).join('\n'), at } }),
        }
      })
      const moved = found.flatMap(t => movable(files, t.fileName, t.memberIds, ctx.activeIds))
      const about = op.about === undefined ? '' : oneLine(op.about)
      return landed(files, {
        kind: 'merge', page: into.fileName, name: into.name, moved, sources,
        ...(about === '' || !isAbout(about) ? {} : { about }), aboutBefore: into.about, aliasesBefore: into.aliases,
      })
    }
    case 'order-topics': {
      const topics = orderedPages(files)
      const wanted = [...new Set(op.order.flatMap(name => findTopic(files, name)?.fileName ?? []))]
      if (wanted.length < 2) return skipped('没有可调的顺序')
      // 没点到的主题保持原来的相对先后，接在后面
      const order = [...wanted, ...topics.map(t => t.fileName).filter(f => !wanted.includes(f))]
      const before = topics.map(t => t.fileName)
      if (order.join('\n') === before.join('\n')) return skipped('顺序没变')
      return { kind: 'planned', plan: { kind: 'order-topics', order, before } }
    }
    case 'order-members': {
      const page = keyOf(op.topic) === keyOf(UNSORTED_TITLE) ? UNSORTED_PAGE : findTopic(files, op.topic)?.fileName
      if (page === undefined || files.pages[page] === undefined) return skipped(`主题「${op.topic}」不在了`)
      const before = [...new Set(memberIds(files.pages[page]!))]
      const wanted = [...new Set(op.order)].filter(id => before.includes(id))
      const order = [...wanted, ...before.filter(id => !wanted.includes(id))]
      if (wanted.length < 2 || order.join('\n') === before.join('\n')) return skipped('顺序没变')
      return { kind: 'planned', plan: { kind: 'order-members', page, order, before } }
    }
    case 'describe': {
      const topic = findTopic(files, op.topic)
      if (topic === undefined) return skipped(`主题「${op.topic}」不在了`)
      if (!isAbout(oneLine(op.about))) return skipped('说明不能以标题记号或代码围栏开头')
      // 说明末尾那句曾用名是程序记的，改说明时留着
      const about = withFormerNote(withoutFormerNote(oneLine(op.about)), formerNames(topic.about))
      if (about === topic.about) return skipped('说明没变')
      return { kind: 'planned', plan: { kind: 'describe', page: topic.fileName, about, before: topic.about } }
    }
  }
}

/** 计划第一个要写的文件：写下它（带提交标记）这一步就算提交了。主题页的文件名，或 'entry'。 */
export function targetOf(plan: IndexPlan): string {
  return plan.kind === 'order-topics' || plan.kind === 'describe' ? 'entry' : plan.page
}

// ── 套计划 ──

/** 把 moved 里的记忆搬进 page：已经在 page 里的不动，还在别的页里的把行拿过来。position 是插在第几个成员前面。 */
function moveInto(files: IndexFiles, page: string, moved: readonly MovedMember[], position: 'top' | 'end'): IndexFiles {
  const pages = { ...files.pages }
  const present = new Set(memberIds(pages[page] ?? ''))
  const wanted = new Set(moved.map(m => m.id).filter(id => !present.has(id)))
  const lines = new Map<string, string>()
  for (const fileName of Object.keys(pages)) {
    if (fileName === page) continue
    const taken = takeMembers(pages[fileName]!, wanted)
    for (const [id, line] of taken.lines) if (!lines.has(id)) lines.set(id, line)
  }
  const arriving = moved.filter(m => lines.has(m.id))
  const inserted = insertMembers(pages[page]!, arriving.map(m => lines.get(m.id)!), position === 'top' ? 0 : Number.MAX_SAFE_INTEGER)
  // 放进去的行要确实成了这页的成员才算（页被改成结尾落在代码块里时不算）：不算就不放，那几条留在原处
  const landing = new Set(memberIds(inserted))
  if (arriving.every(m => landing.has(m.id))) pages[page] = inserted
  // 现在确实在目标页里的，别的页不再留它的行
  const here = new Set(memberIds(pages[page]!))
  const settled = new Set(moved.map(m => m.id).filter(id => here.has(id)))
  for (const fileName of Object.keys(pages)) if (fileName !== page) pages[fileName] = takeMembers(pages[fileName]!, settled).rest
  return { entry: files.entry, pages }
}

function mapSection(files: IndexFiles, page: string, name: string, change: (section: Section) => Section): IndexFiles {
  const entry = splitEntry(files.entry)
  const at = sectionIndex(entry, page, name)
  if (at === -1) return files
  const sections = entry.sections.slice()
  sections[at] = change(sections[at]!)
  return { ...files, entry: joinEntry({ ...entry, sections }) }
}

/** 按 order 重排：只动点到的那些，各自落在它们原来占的位置上，别的不动。 */
function reorder<T>(items: readonly T[], keyOfItem: (item: T) => string | undefined, order: readonly string[]): T[] {
  const rank = new Map(order.map((key, i) => [key, i]))
  const slots = items.flatMap((item, i) => { const key = keyOfItem(item); return key !== undefined && rank.has(key) ? [i] : [] })
  const sorted = slots.map(i => items[i]!).sort((a, b) => rank.get(keyOfItem(a)!)! - rank.get(keyOfItem(b)!)!)
  const out = items.slice()
  slots.forEach((slot, i) => { out[slot] = sorted[i]! })
  return out
}

/**
 * 把计划套到索引上。可以重复做：目标页已经写过、别的页还没改的索引，再套一次得到套完的结果；
 * 已经套完的索引再套一次不变。
 */
export function applyPlan(files: IndexFiles, plan: IndexPlan): AppliedIndex {
  switch (plan.kind) {
    case 'assign': {
      let next = files
      if (next.pages[plan.page] === undefined) {
        if (!plan.isNew) return { files, deleted: [] }
        const text = `# ${plan.name}\n\n`
        next = { ...next, pages: { ...next.pages, [plan.page]: plan.createdAt === undefined ? text : withCreatedAt(text, plan.createdAt) } }
      }
      next = moveInto(next, plan.page, plan.moved, 'top')
      if (plan.isNew) {
        const entry = splitEntry(next.entry)
        if (sectionIndex(entry, plan.page, plan.name) === -1) {
          next = { ...next, entry: joinEntry(insertSection(entry, newSection(plan.page, plan.name, plan.about ?? ''), entry.sections.length)) }
        }
      }
      return { files: next, deleted: [] }
    }
    case 'rename': {
      const text = files.pages[plan.page]
      if (text === undefined) return { files, deleted: [] }
      const aliases = mergeNames(aliasesOf(text), [plan.from]).filter(a => keyOf(a) !== keyOf(plan.to))
      let next: IndexFiles = { ...files, pages: { ...files.pages, [plan.page]: withAliases(withTitle(text, plan.to), aliases) } }
      // 入口那一节按旧名或新名都可能对得上（上一次套到一半时已经改过标题）
      const entry = splitEntry(next.entry)
      const name = sectionIndex(entry, plan.page, plan.from) !== -1 ? plan.from : plan.to
      next = mapSection(next, plan.page, name, s => { const linked = linkedHeading(s, plan.page, plan.to); return withAbout(linked, aboutWithFormerNames(aboutOf(linked), [plan.from])) })
      return { files: next, deleted: [] }
    }
    case 'merge': {
      if (files.pages[plan.page] === undefined) return { files, deleted: [] }
      let next = moveInto(files, plan.page, plan.moved, 'end')
      const former = plan.sources.flatMap(s => [s.name, ...s.aliases])
      const target = next.pages[plan.page]!
      next = { ...next, pages: { ...next.pages, [plan.page]: withAliases(target, mergeNames(aliasesOf(target), former).filter(a => keyOf(a) !== keyOf(plan.name))) } }
      // 并进来的页里一条成员都不剩、别的文字也还是定计划时的样子才删；期间别处又归进去的记忆、后来手写的备注留在原处，那一页就不删
      const deleted = plan.sources.filter(s => next.pages[s.page] !== undefined && memberIds(next.pages[s.page]!).length === 0 && bodyDigest(next.pages[s.page]!) === s.body).map(s => s.page)
      const pages = { ...next.pages }
      for (const page of deleted) delete pages[page]
      const entry = splitEntry(next.entry)
      const gone = new Set(plan.sources.filter(s => deleted.includes(s.page) || files.pages[s.page] === undefined).map(s => sectionIndex(entry, s.page, s.name)).filter(i => i !== -1))
      const sections = entry.sections.filter((_, i) => !gone.has(i))
      next = { entry: joinEntry({ ...entry, sections }), pages }
      const names = plan.sources.map(s => s.name)
      next = mapSection(next, plan.page, plan.name, s => withAbout(s, aboutWithFormerNames(plan.about ?? aboutOf(s), names)))
      return { files: next, deleted }
    }
    case 'order-topics': {
      const entry = splitEntry(files.entry)
      const pages = orderedPages(files)
      const pageOf = (s: Section) => s.fileName ?? pages.find(p => keyOf(p.name) === keyOf(s.name))?.fileName
      return { files: { ...files, entry: joinEntry({ ...entry, sections: reorder(entry.sections, pageOf, plan.order) }) }, deleted: [] }
    }
    case 'order-members': {
      const text = files.pages[plan.page]
      if (text === undefined) return { files, deleted: [] }
      const { header, rows } = splitHeader(text)
      return { files: { ...files, pages: { ...files.pages, [plan.page]: joinPage(header, reorder(rows, memberIdOf, plan.order)) } }, deleted: [] }
    }
    case 'describe': {
      const topic = orderedPages(files).find(t => t.fileName === plan.page)
      if (topic === undefined) return { files, deleted: [] }
      return { files: mapSection(files, plan.page, topic.name, s => withAbout(s, plan.about)), deleted: [] }
    }
  }
}

/**
 * 只够再套一次的计划：去掉撤销才用得上的改前全文（并进来的页、入口里的那一节）。放进操作日志的是这一份，里面没有成员行。
 */
export function planForReplay(plan: IndexPlan): IndexPlan {
  if (plan.kind !== 'merge') return plan
  return { ...plan, sources: plan.sources.map(s => ({ ...s, text: '', ...(s.section !== undefined ? { section: { text: '', at: s.section.at } } : {}) })) }
}

// ── 撤销 ──

export type UndoResult = { kind: 'undone'; files: IndexFiles; deleted: string[] } | { kind: 'stale'; reason: string }

const stale = (reason: string): UndoResult => ({ kind: 'stale', reason })

/** 把还在 page 里的这些记忆各自搬回原来的页、原来的位置；原来的页不在了就进「未整理」。 */
function moveBack(files: IndexFiles, page: string, moved: readonly MovedMember[]): { files: IndexFiles; count: number } {
  const pages = { ...files.pages }
  const taken = takeMembers(pages[page]!, new Set(moved.map(m => m.id)))
  pages[page] = taken.rest
  // 位置靠前的先放回去，后面的位置才对得上
  for (const m of moved.filter(m => taken.lines.has(m.id)).sort((a, b) => a.at - b.at)) {
    const home = pages[m.from] === undefined ? UNSORTED_PAGE : m.from
    pages[home] = insertMembers(pages[home] ?? `# ${UNSORTED_TITLE}\n\n`, [taken.lines.get(m.id)!], home === m.from ? m.at : Number.MAX_SAFE_INTEGER)
  }
  return { files: { entry: files.entry, pages }, count: taken.lines.size }
}

/**
 * 把一个套过的计划撤回去。只撤还在的效果：搬过去的记忆还在目标页的搬回来，名字、说明、顺序还是这次写下的才改回去；
 * 期间别处进来的行不动。这一步的效果已经一点都不在了，返回 stale。
 */
export function undoPlan(files: IndexFiles, plan: IndexPlan): UndoResult {
  switch (plan.kind) {
    case 'assign': {
      if (files.pages[plan.page] === undefined) return stale('这个主题已经不在了')
      const back = moveBack(files, plan.page, plan.moved)
      if (back.count === 0) return stale('这些记忆已经不在这个主题里')
      let next = back.files
      const deleted: string[] = []
      // 这次新建的主题，搬空了就连页带入口那一节一起去掉；页里、那一节里后来多了别的文字（手写的备注、改过的说明）就都留着
      if (plan.isNew && memberIds(next.pages[plan.page]!).length === 0) {
        const entry = splitEntry(next.entry)
        const at = sectionIndex(entry, plan.page, plan.name)
        const written = (rows: readonly Row[]) => rows.map(r => bare(r.line).trim()).filter(line => line !== '').join('\n')
        const isSectionAsCreated = at === -1 || written(entry.sections[at]!.rows) === written(newSection(plan.page, plan.name, plan.about ?? '').rows)
        if (bodyLines(next.pages[plan.page]!).join('\n') === `# ${plan.name}` && isSectionAsCreated) {
          const pages = { ...next.pages }
          delete pages[plan.page]
          deleted.push(plan.page)
          next = { entry: at === -1 ? next.entry : joinEntry({ ...entry, sections: entry.sections.filter((_, i) => i !== at) }), pages }
        }
      }
      return { kind: 'undone', files: next, deleted }
    }
    case 'rename': {
      const text = files.pages[plan.page]
      if (text === undefined || titleOf(text) !== plan.to) return stale('这个主题后来又改过名')
      // 曾用名回到改名前的样子：改名时加进去的旧名拿掉，改名时拿掉的（新名原本就是曾用名）放回来，后来别处加的留着
      const before = new Set(plan.aliasesBefore.map(keyOf))
      const now = aliasesOf(text)
      const aliases = [
        ...plan.aliasesBefore.filter(a => keyOf(a) === keyOf(plan.to) || now.some(n => keyOf(n) === keyOf(a))),
        ...now.filter(a => !before.has(keyOf(a)) && keyOf(a) !== keyOf(plan.from)),
      ]
      let next: IndexFiles = { ...files, pages: { ...files.pages, [plan.page]: withAliases(withTitle(text, plan.from), aliases) } }
      next = mapSection(next, plan.page, plan.to, s => {
        const linked = linkedHeading(s, plan.page, plan.from)
        // 说明还是这次写下的样子才改回去，后来改过的留着
        return aboutOf(linked) === aboutWithFormerNames(plan.aboutBefore, [plan.from]) ? withAbout(linked, plan.aboutBefore) : linked
      })
      return { kind: 'undone', files: next, deleted: [] }
    }
    case 'merge': {
      if (files.pages[plan.page] === undefined) return stale('合并成的主题已经不在了')
      const inTarget = new Set(memberIds(files.pages[plan.page]!))
      const pages = { ...files.pages }
      let restored = 0
      const taken = takeMembers(pages[plan.page]!, new Set(plan.moved.map(m => m.id)))
      pages[plan.page] = taken.rest
      for (const source of plan.sources) {
        const mine = plan.moved.filter(m => m.from === source.page)
        if (pages[source.page] === undefined) {
          // 页已经删了：按改前的整页放回去，只留现在还在合并成的主题里的成员（别的已经去了别处或不在了），行用现在的
          const keep = new Set(mine.map(m => m.id).filter(id => inTarget.has(id)))
          pages[source.page] = withMemberText(source.text, (key) => { const id = unescape(key); return keep.has(id) ? taken.lines.get(id) : undefined })
          restored++
        } else {
          // 页还在（期间有别的记忆归进去）：只把搬走的成员放回去
          for (const m of mine.filter(m => taken.lines.has(m.id)).sort((a, b) => a.at - b.at)) pages[source.page] = insertMembers(pages[source.page]!, [taken.lines.get(m.id)!], m.at)
        }
      }
      if (restored === 0 && taken.lines.size === 0) return stale('合并进来的记忆已经不在这个主题里')
      const added = new Set(plan.sources.flatMap(s => [s.name, ...s.aliases]).map(keyOf))
      const kept = new Set(plan.aliasesBefore.map(keyOf))
      pages[plan.page] = withAliases(pages[plan.page]!, aliasesOf(pages[plan.page]!).filter(a => kept.has(keyOf(a)) || !added.has(keyOf(a))))
      let entry = splitEntry(files.entry)
      for (const source of plan.sources.filter(s => s.section !== undefined).sort((a, b) => a.section!.at - b.section!.at)) {
        if (sectionIndex(entry, source.page, source.name) !== -1) continue
        const section = sectionFromText(source.section!.text)
        if (section !== undefined) entry = insertSection(entry, section, source.section!.at)
      }
      let next: IndexFiles = { entry: joinEntry(entry), pages }
      const names = plan.sources.map(s => s.name)
      next = mapSection(next, plan.page, plan.name, s => {
        const written = aboutWithFormerNames(plan.about ?? plan.aboutBefore, names)
        return aboutOf(s) === written ? withAbout(s, plan.aboutBefore) : withAbout(s, aboutWithoutFormerNames(aboutOf(s), names))
      })
      return { kind: 'undone', files: next, deleted: [] }
    }
    case 'order-topics': {
      const now = orderedPages(files).map(t => t.fileName)
      const known = new Set(plan.order)
      if (now.filter(f => known.has(f)).join('\n') !== plan.order.filter(f => now.includes(f)).join('\n')) return stale('主题的顺序后来又调过')
      return { kind: 'undone', files: applyPlan(files, { kind: 'order-topics', order: plan.before, before: plan.order }).files, deleted: [] }
    }
    case 'order-members': {
      const text = files.pages[plan.page]
      if (text === undefined) return stale('这个主题已经不在了')
      const now = [...new Set(memberIds(text))]
      const known = new Set(plan.order)
      if (now.filter(id => known.has(id)).join('\n') !== plan.order.filter(id => now.includes(id)).join('\n')) return stale('这一页的顺序后来又调过')
      return { kind: 'undone', files: applyPlan(files, { kind: 'order-members', page: plan.page, order: plan.before, before: plan.order }).files, deleted: [] }
    }
    case 'describe': {
      const topic = orderedPages(files).find(t => t.fileName === plan.page)
      if (topic === undefined) return stale('这个主题已经不在了')
      if (topic.about !== plan.about) return stale('主题说明后来又改过')
      return { kind: 'undone', files: mapSection(files, plan.page, topic.name, s => withAbout(s, plan.before)), deleted: [] }
    }
  }
}
